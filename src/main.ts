// Orchestrates the whole page: loads a firmware's wasm module (see
// wasm.ts), builds the puck chrome entirely from its own emu_device()
// descriptor, drives the deterministic tick loop, and wires touch,
// buttons, sensors, apps, the push-window overlay, the touch-contact
// overlay, input recording/replay, and freeze/trace capture.
//
// No firmware behaviour lives here: every ABI call is a straight pass
// through to the module. This file's only job is turning DOM events into
// ABI calls, and ABI state into pixels.

import { type EmuExports, type DeviceDescriptor, DEFAULT_WASM_URL, fetchWasmBytes, instantiate, readDeviceDescriptor, readFramebufferPointer } from "./wasm";
import { readPushes, pixelReaderFor, blitRect, blitAll, type PixelReader } from "./panel";
import { PushOverlay } from "./overlay";
import { TouchOverlay, CONTACT_PRESETS, DEFAULT_PX_PER_MM } from "./touchoverlay";
import { mapClientPoint, gravityForQuickDeg } from "./rotate";
import { makeDraggable, wireButton, createButtonElement, applyRotation, type WiredButton } from "./device";
import { buildSensorControls, type SensorControls } from "./sensors";
import { buildAppStrip, type AppStripControl } from "./appstrip";
import { ShortcutRegistry, assignShortcut } from "./shortcuts";
import { ConsoleLog, type LogLine } from "./consolelog";
import { Recorder, type Trace, type TraceEvent } from "./recorder";
import { Replayer } from "./replay";
import { postFreeze, canvasToPngBase64, openAnnotationModal, type FreezeBundle, type EngineStatus } from "./freeze";
import { emptyJournal } from "./journal";
import { captureBaseline, checkAgainstBaseline, toRegressionResultPayload, openRegressionModal, type BaselineBundle, type RegressionCheck } from "./regression";
import { TouchSim, type TouchReport } from "./touchsim";
import { type TouchSimConfig, TOUCHSIM_DEFAULTS, TOUCH_DEFECTS_DEFAULT } from "./constants";
import { WindowShakeDetector } from "./windowshake";
import { PuckMotion } from "./puckmotion";
import { SoundPlayer } from "./audio";
import { PhoneMotion, DragMotion } from "./motion";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---- DOM ----
const bezelEl = $("#bezel");
const deviceWrapEl = $("#deviceWrap");
const panelEl = $<HTMLCanvasElement>("#panel");
const overlayEl = $<HTMLCanvasElement>("#overlay");
const panelCtx = panelEl.getContext("2d", { willReadFrequently: true })!;
const overlayCtx = overlayEl.getContext("2d")!;
const wasmErrorEl = $("#wasmError");
const engineDeadEl = $("#engineDead");
const consolePaneEl = $("#consolePane");
const diagStripEl = $("#diagStrip");
const replayBarEl = $("#replayBar");
const btnStopReplay = $<HTMLButtonElement>("#btnStopReplay");
const btnPause = $<HTMLButtonElement>("#btnPause");
const stageEl = $("#stage");

// ---- embed control cluster: inline icons -----------------------------
// Self-contained SVG strings (never a fetched icon font/sprite - this page
// has no build step for one and must keep working offline): Feather's
// "rotate-cw" glyph for the rotate button, Material's "vibration" glyph for
// the shake button, both stroke/fill set to currentColor so they inherit
// the button's own colour (idle/hover/press, see app.css's .embed-ctrl-btn)
// rather than carrying a hardcoded one of their own.
const ROTATE_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline>' +
  '<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';
const SHAKE_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
  '<path d="M0 15h2V9H0v6zm3 2h2V7H3v10zm19-8v6h2V9h-2zm-3 10h2V7h-2v10zM16.5 3h-9C6.67 3 6 3.67 6 4.5v15c0 .83.67 1.5 1.5 1.5h9c.83 0 1.5-.67 1.5-1.5v-15c0-.83-.67-1.5-1.5-1.5zM16 19H8V5h8v14z"></path></svg>';

// ---- module URL ----
// Additive hook for a static gallery page that embeds this same emulator
// page multiple times, once per proven app+pack combo, each pointed at its
// own prebuilt .wasm (see site/build.ts). The dev server and its live
// reload are untouched: with no ?module= param this is exactly
// DEFAULT_WASM_URL, byte for byte the same request reloadModule() always
// made.
const WASM_URL = new URLSearchParams(location.search).get("module") || DEFAULT_WASM_URL;

// ---- embed mode ----
// Additive hook for a static gallery run page that wants ONLY the bare
// device (frame, panel, its declared buttons), floating with no control
// strip and no backdrop, for embedding in a narrow iframe with no huge
// empty area around a full dev-UI layout it will never use (topbar, the
// input/device/console sidebar, the tuning disclosure, the diagnostics
// strip, and - as of this device-only pass - the bottom bar's rotation
// buttons and shake pill too, see applyEmbedMode below and app.css's
// html.embed .bottom-bar rule). Composes with ?module=; with no ?embed=1
// the page is exactly the existing dev UI, byte-for-byte the same
// behaviour as before this existed.
const EMBED = new URLSearchParams(location.search).get("embed") === "1";

// ---- state ----
let emu: EmuExports | null = null;
let wasmBytes: ArrayBuffer | null = null;
let device: DeviceDescriptor | null = null;
let panelW = 0;
let panelH = 0;
let fbPtr = 0;
let pixelReader: PixelReader | null = null;
let touchEnabled = false;
let accentColor = "#c4621f";

const recorder = new Recorder();
const consoleLog = new ConsoleLog(500, appendConsoleLine);
const pushOverlay = new PushOverlay();
// PushOverlay ships enabled (its own default), because the class is also
// used headless where nothing would ever switch it on. In the page it
// starts off, matching its unchecked box below: two overlays sharing one
// canvas is a rendering detail, not a reason to make them one switch, and
// the push outlines are the noisier of the two by a wide margin (every
// pushed rectangle, every frame, over whatever the app is drawing).
pushOverlay.enabled = false;
const touchOverlay = new TouchOverlay();
const shortcuts = new ShortcutRegistry();
const windowShake = new WindowShakeDetector();
// A second instance of the SAME detector shape, fed from dragging the puck
// itself on the page (device.ts's makeDraggable, onDrag callback) rather
// than the browser window's OS position. This is the reliable shake path:
// see its wiring in wireStaticUI for why the window path cannot be trusted
// on Windows (a real titlebar drag can stop the renderer from getting
// animation frames at all, which no threshold tuning fixes).
const puckDragShake = new WindowShakeDetector();
const puckMotion = new PuckMotion();
const soundPlayer = new SoundPlayer();
let shakeSensorIndex = -1;
// Every declared "kind": "vector" sensor's index, generic (this repo's
// AGENTS.md rule: nothing in src/ special-cases a sensor by id, only by
// kind - see buildChrome below, which fills this from emu_device() the
// same way shakeSensorIndex is filled by kind "event" + id "shake" is
// filled by buildSensorControls). Every entry gets the SAME gravity
// reading (sendGravityForRotation below): a device with more than one
// vector sensor is not something this repo's reference packs declare
// today, and nothing here assumes a particular count beyond "zero or
// more".
let vectorSensorIndices: number[] = [];
// Same idea as vectorSensorIndices, for a "kind": "stream" sensor (raw
// accelerometer samples, decision 0003 in packs/esp32-s3-touch-amoled-18)
// instead of one continuous fused reading. Generic over kind, never over a
// sensor's id, same AGENTS.md rule vectorSensorIndices already follows.
let streamSensorIndices: number[] = [];
let centeredOnce = false;

// The contact toggle (disc, trail and coordinate readout together, one
// switch). Off by default: it is noise until someone actually wants it.
// The push-window outlines have their own switch (pushOverlay.enabled,
// above): one wants to see a finger, the other wants to see geometry, and
// they are rarely the same question.
let overlayEnabled = false;

// Diagnostics kept for the one-line strip at the bottom of the page:
// coordinates, push counts, reload status and shake jolts belong together,
// not scattered across the chrome.
let lastTouchMapped: { panel: { x: number; y: number }; view: { x: number; y: number } } | null = null;
let lastReloadStatus = "";

const touchCfg: TouchSimConfig = { ...TOUCHSIM_DEFAULTS };
let touchDefectsEnabled = TOUCH_DEFECTS_DEFAULT;
let touchSim: TouchSim | null = null;
let liveTouch: TouchReport = { fingers: 0, x: 0, y: 0 };
let pointerIdDown: number | null = null;

// Default view rotation. 0 means "the framebuffer's own orientation is
// shown as-is": most firmware declares a panel whose w/h already match how
// it will be held, so there is nothing to correct for by default. Some
// firmware renders a landscape UI into a portrait-native framebuffer (or
// vice versa) and expects the device to be held rotated; if that's yours,
// pick the matching quick-rotate button once (bottom bar) and it stays
// picked for the session. Verify with a screenshot that has asymmetric
// content (text, an icon) rather than trusting the geometry by eye: a
// symmetric screen can look right at the wrong rotation and hide the bug.
let quickDeg = 0;
let tiltDeg = 0;
// The bounded, spring-back visual offset DragMotion drives while the bezel
// is being dragged as a desktop accelerometer (see that class's own header
// comment in motion.ts) - added to puckMotion's own shake offset in frame()
// below, the same additive composition applyRotation already expects.
let dragOffsetX = 0;
let dragOffsetY = 0;

const phoneMotion = new PhoneMotion({
  embed: EMBED,
  stage: stageEl,
  getQuickDeg: () => quickDeg,
  sendVector: (x, y, z, source) => sendVector(x, y, z, source),
  sendAccel: (ax, ay, az, tMs, source) => sendAccel(ax, ay, az, tMs, source),
  fireShake: (now, source) => fireShakeSensor(now, source),
  onLayoutChanged: () => fitDeviceToStage(),
  onOwnershipReleased: () => sendGravityForRotation(),
  // Joins the same row as the rotate/shake buttons rather than
  // self-centering on its own spot - resolved lazily (see PhoneMotionOptions'
  // own header comment) since embedControlsRow is only built later, in
  // wireStaticUI, well after this object is constructed at module load.
  mountTo: () => embedControlsRow ?? stageEl,
});

// See motion.ts's DragMotion header comment for the full gating rationale.
// In embed mode wireStaticUI never calls device.ts's makeDraggable at all
// (its own "if (!EMBED)" guard below), so there is no competing bezel-drag
// listener to pre-empt any more - this still constructs before boot() runs
// wireStaticUI (module top-level code runs first) purely so the listener
// exists before the very first pointerdown a visitor could ever produce.
const dragMotion = new DragMotion({
  stage: stageEl,
  bezel: bezelEl,
  getQuickDeg: () => quickDeg,
  sendVector: (x, y, z, source) => sendVector(x, y, z, source),
  sendAccel: (ax, ay, az, tMs, source) => sendAccel(ax, ay, az, tMs, source),
  fireShake: (now, source) => fireShakeSensor(now, source),
  pollDragShake: (x, y, now, suppressed) => puckDragShake.poll(x, y, now, suppressed),
  isEligible: () => EMBED && !phoneMotion.isActive(),
  hasVector: () => vectorSensorIndices.length > 0,
  hasShake: () => shakeSensorIndex >= 0,
  hasAccelStream: () => streamSensorIndices.length > 0,
  onOffsetChanged: (dx, dy) => {
    dragOffsetX = dx;
    dragOffsetY = dy;
  },
});

let wiredButtons: WiredButton[] = [];
// Keyed by the declared button id (DeviceButton.id), not array index: a
// gesture script names buttons by id (see wasm.ts's GestureStep), and this
// is what lets runGestureScript resolve "hold pwr" back to the exact same
// WiredButton a real pointer/keyboard press already drives, rather than
// reimplementing button state a second time for scripted gestures.
let wiredButtonById = new Map<string, WiredButton>();
let buttonKeyById = new Map<string, string>();
let appStripControl: AppStripControl | null = null;
let lastAppIndex = 0;
// Set inside buildChrome, alongside appStripControl above: the one handle
// this file needs to fire a declared event sensor from OUTSIDE the (in
// embed mode, hidden) sidebar buttons buildSensorControls itself renders --
// see buildEmbedControls' shake button below, which is the reason this
// exists at all.
let sensorControls: SensorControls | null = null;

let paused = false;
let replayer: Replayer | null = null;

// ---- engine death: distinct from #wasmError, see enterDeadState below ----
// Counts only SUCCESSFUL ticks (incremented after emu_tick() returns
// without throwing), so "died on tick N" in a DeadState below always names
// the ordinal of the tick that was actually in progress when it died, not
// one off in either direction.
let tickCount = 0;

interface DeadState {
  error: string;
  stack: string | undefined;
  diedOnTick: number;
  // What direct call was actually in flight when the trap happened: "tick"
  // for the ordinary requestAnimationFrame path, or e.g. "button[0] down",
  // "sensor[0] (shake)", "app switch to 2" for a trap inside a direct
  // ABI call made from a DOM event handler (see guardedAbiCall below).
  // diedOnTick still names the last tick boundary for context ("this
  // happened shortly after tick 40"), but for a non-tick cause it was NOT
  // the tick itself that died, and the banner/freeze bundle say so
  // precisely rather than always claiming "died on tick N" regardless of
  // what actually threw.
  cause: string;
  lastInputEvent: TraceEvent | null;
  diedAt: string; // ISO, wall-clock: freeze bundles want a real timestamp, not performance.now()
}
let deadState: DeadState | null = null;

const pushHistory: { tMs: number; x: number; y: number; w: number; h: number }[] = [];
const PUSH_HISTORY_MAX = 400;

// ---- console pane ----
function appendConsoleLine(line: LogLine): void {
  const div = document.createElement("div");
  div.className = "console-line";
  div.textContent = line.text;
  consolePaneEl.appendChild(div);
  while (consolePaneEl.childElementCount > 300) consolePaneEl.removeChild(consolePaneEl.firstChild!);
  consolePaneEl.scrollTop = consolePaneEl.scrollHeight;
}

// ---- wasm error banner ----
// Never a blank or frozen page on failure: this banner is always the raw
// error message plus a way forward, and (see bringUp) it is shown without
// ever tearing down a module that was already running.
function showWasmError(err: unknown): void {
  wasmErrorEl.innerHTML = "";
  const text = document.createElement("div");
  text.className = "wasm-error-text";
  text.textContent = errMsg(err);
  const retry = document.createElement("button");
  retry.className = "btn sec sm";
  retry.textContent = "retry";
  retry.addEventListener("click", () => void reloadModule("manual retry"));
  wasmErrorEl.appendChild(text);
  wasmErrorEl.appendChild(retry);
  wasmErrorEl.classList.remove("hidden");
  console.error(err);
}
function hideWasmError(): void {
  wasmErrorEl.classList.add("hidden");
}
function failReload(err: unknown): void {
  showWasmError(err);
  if (emu) consoleLog.push(`reload failed, keeping previous session running: ${errMsg(err)}`);
}

// ---- engine-dead banner ----------------------------------------------
// Deliberately NOT #wasmError, and deliberately worded differently.
// #wasmError means "a module never came up" - there is no panel, no
// buttons, nothing to look at. This means the opposite: a module WAS up,
// ticking, painting, and something threw partway through a tick anyway.
// The two must be impossible to confuse, because the person hitting this
// one is looking at what appears to be a perfectly normal, if frozen,
// device -- exactly the state a newcomer will default to blaming on their
// own C (see docs/findings-first-adversarial-pass.md). This banner's whole
// job is refusing to let that assumption stand unchallenged.
function describeTraceEvent(ev: TraceEvent): string {
  switch (ev.k) {
    case "touch":
      return `touch down=${ev.down} x=${ev.x} y=${ev.y} @${ev.t.toFixed(1)}ms`;
    case "button":
      return `button[${ev.i}] down=${ev.down} @${ev.t.toFixed(1)}ms`;
    case "verdict":
      return `button[${ev.i}] verdict long=${ev.long} @${ev.t.toFixed(1)}ms`;
    case "sensor":
      return `sensor[${ev.i}] @${ev.t.toFixed(1)}ms`;
    case "vector":
      return `sensor[${ev.i}] vector (${ev.x.toFixed(2)},${ev.y.toFixed(2)},${ev.z.toFixed(2)}) @${ev.t.toFixed(1)}ms`;
    case "accel":
      return `sensor[${ev.i}] accel (${ev.ax.toFixed(2)},${ev.ay.toFixed(2)},${ev.az.toFixed(2)}) @${ev.t.toFixed(1)}ms`;
    case "tick":
      return `tick @${ev.t.toFixed(1)}ms`;
  }
}

function showEngineDead(state: DeadState): void {
  engineDeadEl.innerHTML = "";
  const title = document.createElement("div");
  title.className = "engine-dead-title";
  title.textContent =
    state.cause === "tick"
      ? "engine crashed: the tick loop threw and has stopped, the panel below is not necessarily what your firmware last drew"
      : `engine crashed: ${state.cause} threw and ticking has stopped too, the panel below is not necessarily what your firmware last drew`;
  const text = document.createElement("div");
  text.className = "engine-dead-text";
  text.textContent = state.error + (state.stack ? `\n${state.stack}` : "");
  const meta = document.createElement("div");
  meta.className = "engine-dead-meta";
  meta.textContent =
    (state.cause === "tick" ? `died on tick ${state.diedOnTick}` : `died on ${state.cause}, shortly after tick ${state.diedOnTick}`) +
    `, ${state.diedAt}` +
    (state.lastInputEvent ? ` -- last input delivered: ${describeTraceEvent(state.lastInputEvent)}` : " -- no input had been delivered yet");
  const hint = document.createElement("div");
  hint.className = "engine-dead-hint";
  hint.textContent =
    "this could be a genuine wasm trap (a wild pointer write, an out-of-bounds access your firmware's own C committed) " +
    "or a bug in this emulator; the exception above is exact, use it to tell which. ticking has stopped so this does not " +
    "throw again 60 times a second -- reload once you've rebuilt, or to just try again.";
  const retry = document.createElement("button");
  retry.className = "btn sec sm";
  retry.textContent = "reload module";
  retry.addEventListener("click", () => void reloadModule("recovering from engine crash"));
  engineDeadEl.appendChild(title);
  engineDeadEl.appendChild(text);
  engineDeadEl.appendChild(meta);
  engineDeadEl.appendChild(hint);
  engineDeadEl.appendChild(retry);
  engineDeadEl.classList.remove("hidden");
}
function hideEngineDead(): void {
  engineDeadEl.classList.add("hidden");
}

// Called from anywhere in the frame path (stepOnce, afterTick, and
// anything they call) that catches an exception the ABI boundary
// validation in abiGuard.ts could not have prevented -- a genuine wasm
// trap from inside emu_tick() itself is the clearest example: nothing on
// the JS side can validate a pointer write that happens entirely inside
// the module's own compiled code. First exception wins; once dead, later
// ones (there will be exactly zero more, since frame() stops calling
// stepOnce once deadState is set, and guardedAbiCall below refuses to make
// any further direct call once deadState is set either) are not
// interesting.
//
// `cause` defaults to "tick" for the original call site (stepOnce's own
// catch, below) and is passed explicitly by guardedAbiCall for everything
// else -- see that function's header comment for why a trap outside
// emu_tick() gets exactly the same treatment as one inside it.
function enterDeadState(err: unknown, cause: string = "tick"): void {
  if (deadState) return;
  const last = recorder.recent(1);
  deadState = {
    error: errMsg(err),
    stack: err instanceof Error ? err.stack : undefined,
    diedOnTick: tickCount + 1,
    cause,
    lastInputEvent: last.length > 0 ? last[0]! : null,
    diedAt: new Date().toISOString(),
  };
  console.error(`engine crashed (${cause}):`, err);
  consoleLog.push(`engine crashed on ${cause}: ${deadState.error}`);
  showEngineDead(deadState);
}

// The guard for every direct ABI call made synchronously from a DOM event
// handler (a button press, a sensor click, an app-strip click, a shake) --
// entirely OUTSIDE the tick loop's own try/catch (stepOnce, below), because
// none of these run inside requestAnimationFrame's callback at all.
//
// This is the thing the tick-loop guard's own first pass left open, on
// purpose, and said so: those calls don't sit inside the self-rescheduling
// frame() loop, so a trap in one of them does not produce the SAME failure
// mode (a silent freeze under a still-painted panel) that stepOnce's guard
// exists for. But it is still the same class of bug, with its own bad
// outcome: a firmware that traps on a button press leaves the page looking
// perfectly healthy, ticking along, with one control that silently does
// nothing. Nothing here hands back an untrusted VALUE the way
// emu_fb()/emu_push_*() do (abiGuard.ts's job); emu_button, emu_touch,
// emu_sensor_event and emu_app_switch are all void. So the only failure
// mode a direct call like this can have is a genuine wasm trap -- and a
// trap is a trap regardless of which export it happened in: per the wasm
// spec, once ANY exported function traps, the instance's linear memory and
// globals are left in whatever partial state existed the instant execution
// stopped. That is exactly as suspect as a trap inside emu_tick() itself,
// so this reuses enterDeadState exactly as it already exists for the tick
// loop rather than inventing a second, softer failure state for "just one
// button" -- pretending a trapped module is still fine to keep calling into
// is precisely the comforting lie docs/findings-first-adversarial-pass.md
// was written to stop this repo telling itself. Once dead, this refuses to
// make any further call at all (rather than relying only on
// enterDeadState's own "first exception wins" short-circuit), because
// there is nothing to gain from invoking an export that is already known to
// be broken.
function guardedAbiCall(cause: string, fn: (liveEmu: EmuExports) => void): void {
  if (!emu || deadState) return;
  try {
    fn(emu);
  } catch (err) {
    enterDeadState(err, cause);
  }
}

// Marks the panel itself as dead, not just a banner somewhere in the
// chrome: a hatched overlay drawn directly over the framebuffer, painted
// every frame regardless of the ordinary contact/push overlay's own on/off
// toggle (overlayEnabled is a diagnostics PREFERENCE; this is a status the
// person does not get to turn off). This is what makes "firmware stopped
// drawing" and "emulator crashed" impossible to confuse at a glance: the
// former still looks like a normal, if static, panel; this does not.
function paintDeadOverlay(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = "rgba(180, 30, 20, 0.28)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(180, 30, 20, 0.55)";
  ctx.lineWidth = 3;
  const step = 14;
  ctx.beginPath();
  for (let x = -h; x < w; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x + h, h);
  }
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 12px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,.6)";
  ctx.shadowBlur = 3;
  ctx.fillText("ENGINE CRASHED", w / 2, h / 2);
  ctx.restore();
}

// "reloaded HH:MM:SS Nb" folded into the one diagnostics strip (see
// updateDiagStrip) so a stale or failed reload is obvious at a glance
// without a dedicated line of chrome for it.
function updateReloadStatus(byteLength: number): void {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  lastReloadStatus = `reloaded ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())} ${byteLength.toLocaleString()}b`;
}

// ---- physical contact size ----
function derivePxPerMm(d: DeviceDescriptor): number {
  // Not part of emu_abi.h today; a forward-compatible, defensive read in
  // case a firmware ever declares its own physical size, preferred over
  // the fallback constant when present.
  const p = d.panel as unknown as { wMm?: number; hMm?: number };
  if (typeof p.wMm === "number" && p.wMm > 0) return d.panel.w / p.wMm;
  if (typeof p.hMm === "number" && p.hMm > 0) return d.panel.h / p.hMm;
  return DEFAULT_PX_PER_MM;
}
// Finger size is a quantity (contact diameter, millimetres); naming only
// "adult"/"child" hides that number and makes it unreachable, which is
// backwards for a tool whose job is showing how big a finger really is
// against a layout. The numeric input is the primary control; the presets
// are one-click shortcuts to a value, not the only values. The px figure
// is the one the layout is actually judged against (it depends on the
// panel's declared geometry, not the millimetres alone), shown as a plain
// number next to the mm input, no sentence around either.
function refreshContactInfo(): void {
  const mmInput = $<HTMLInputElement>("#contactMm");
  // Never stomp what's mid-typed: only sync the field's displayed value
  // when it is not the thing focused right now.
  if (document.activeElement !== mmInput) mmInput.value = String(touchOverlay.contactMm);
  const px = Math.round(touchOverlay.contactMm * touchOverlay.pxPerMm);
  $("#contactPx").textContent = `${px}px`;
  $("#contactPreset")
    .querySelectorAll<HTMLButtonElement>("button")
    .forEach((b) => b.classList.toggle("active", Number(b.dataset.mm) === touchOverlay.contactMm));
}
function wireContactSize(): void {
  const mmInput = $<HTMLInputElement>("#contactMm");
  mmInput.addEventListener("input", () => {
    const v = Number(mmInput.value);
    if (Number.isFinite(v) && v > 0) {
      touchOverlay.contactMm = v;
      refreshContactInfo();
    }
  });

  const el = $("#contactPreset");
  el.innerHTML = "";
  CONTACT_PRESETS.forEach((preset) => {
    const b = document.createElement("button");
    b.textContent = preset.label;
    b.dataset.mm = String(preset.mm);
    b.title = `${preset.mm}mm`;
    b.addEventListener("click", () => {
      touchOverlay.contactMm = preset.mm;
      refreshContactInfo();
    });
    el.appendChild(b);
  });
  refreshContactInfo();
}

// ---- button ABI calls, recorded ----
// A DOM handler (device.ts's wireButton, wired from a real pointer or
// keyboard chord), never inside the tick loop -- see guardedAbiCall's own
// header comment for why a trap here gets the same #engineDead treatment
// as one inside emu_tick().
function emuButtonDown(index: number): void {
  guardedAbiCall(`button[${index}] down`, (liveEmu) => {
    liveEmu.emu_button(index, 1);
    recorder.record({ t: performance.now(), k: "button", i: index, down: 1 });
  });
}
function emuButtonUp(index: number): void {
  guardedAbiCall(`button[${index}] up`, (liveEmu) => {
    liveEmu.emu_button(index, 0);
    recorder.record({ t: performance.now(), k: "button", i: index, down: 0 });
  });
}
function emuButtonVerdict(index: number, isLong: boolean): void {
  guardedAbiCall(`button[${index}] verdict (long=${isLong})`, (liveEmu) => {
    liveEmu.emu_button_verdict(index, isLong ? 1 : 0);
    recorder.record({ t: performance.now(), k: "verdict", i: index, long: isLong ? 1 : 0 });
  });
}

// ---- chrome: rebuilt from the device descriptor on every (re)load ----
function buildChrome(d: DeviceDescriptor): void {
  document.documentElement.style.setProperty("--panel-w", `${d.panel.w}px`);
  document.documentElement.style.setProperty("--panel-h", `${d.panel.h}px`);
  panelEl.width = d.panel.w;
  panelEl.height = d.panel.h;
  overlayEl.width = d.panel.w;
  overlayEl.height = d.panel.h;

  $("#deviceName").textContent = d.name || "device emulator";
  // The name already shows in the topbar; the sidebar's job is the one
  // fact that isn't there yet, the panel's dimensions. NOT the pixel
  // format ("rgb565be"): that names an internal encoding, not something
  // useful to a person looking at the puck, so it moved to the
  // diagnostics strip (updateDiagStrip) instead of sitting here.
  $("#deviceInfo").textContent = `${d.panel.w}×${d.panel.h}`;

  bezelEl.querySelectorAll(".dev-btn").forEach((el) => el.remove());
  wiredButtons = [];
  wiredButtonById = new Map();
  buttonKeyById = new Map();
  shortcuts.clear();
  const usedKeys = new Set<string>();
  const shortcutListEl = $("#buttonShortcuts");
  shortcutListEl.innerHTML = "";

  // embed: keyboard-only rotate. Gated on EMBED so the plain dev UI's own
  // keyboard behaviour stays exactly what it was (this repo's own rule: src/
  // changes stay behind the embed flag, dev UI untouched) - #rotQuick's
  // buttons are still the only way to rotate there. In embed mode the whole
  // bottom bar is hidden (app.css's html.embed .bottom-bar), so "r" is what
  // a run page's own hint (site/build.ts) tells a visitor to press instead.
  // Registered here, not in wireStaticUI (called once at boot), because
  // shortcuts.clear() just above wipes every binding on each module
  // (re)load, same reason the device buttons and sensor buttons below are
  // (re)bound here too. Reserved into usedKeys BEFORE any button/sensor
  // claims a letter, so "r" always means rotate regardless of what a device
  // happens to call its own buttons.
  if (EMBED) {
    usedKeys.add("r");
    shortcuts.bindClick("r", cycleQuickRotation);
  }

  const buttons = d.buttons || [];
  buttons.forEach((btn, index) => {
    const el = createButtonElement(btn.edge, btn.at, bezelEl.clientWidth, bezelEl.clientHeight);
    el.title = `${btn.label} (${btn.edge} @ ${(btn.at * 100).toFixed(0)}%)`;
    bezelEl.appendChild(el);
    const wired = wireButton(
      el,
      {
        onDown: () => emuButtonDown(index),
        onUp: () => emuButtonUp(index),
        onVerdict: (isLong) => emuButtonVerdict(index, isLong),
      },
      btn.longPressMs
    );
    wiredButtons.push(wired);
    wiredButtonById.set(btn.id, wired);

    // Held via the keyboard, which is what makes a two-button gesture (a
    // chord across two side buttons) actually performable: a mouse only
    // has one pointer and can hold at most one button at a time, but two
    // physical keys can be held together on a real keyboard, exactly like
    // two fingers on two side buttons.
    const key = assignShortcut(btn.id, usedKeys);
    if (key) {
      shortcuts.bindHeld(key, { down: wired.down, up: wired.up });
      buttonKeyById.set(btn.id, key);
    }

    const row = document.createElement("div");
    row.className = "shortcut-row";
    row.title = `${btn.edge} @ ${(btn.at * 100).toFixed(0)}%${btn.longPressMs ? `, hold ${btn.longPressMs}ms = long` : ""}`;
    row.innerHTML = `<span class="kbd">${key ? key.toUpperCase() : "-"}</span> ${escapeHtml(btn.label)}`;
    shortcutListEl.appendChild(row);
  });

  if (emu) {
    sensorControls = buildSensorControls($("#sensorControls"), d.sensors || [], shortcuts, usedKeys, (t) => consoleLog.push(t), (sensor) => {
      // The one place a sensor click drives something visible beyond the
      // firmware event itself: a "shake" sensor gets the same puck motion
      // a real window shake produces, since there is no window motion
      // behind a click to derive it from otherwise (see puckmotion.ts).
      // Magnitude picked so the peak displacement lands close to
      // PuckMotion's own maxOffset (a clearly visible jolt, not a twitch):
      // for this spring's stiffness, a velocity kick V settles near a peak
      // of V/sqrt(stiffness) px, so 300-400 px/s of kick reads as a real
      // shake rather than a 1-2px flicker (measured with puppeteer: a
      // gentler kick was visually indistinguishable from noise).
      if (sensor.id.toLowerCase() === "shake") puckMotion.impulse((Math.random() - 0.5) * 500, (Math.random() - 0.5) * 380);
    }, guardedAbiCall);
    appStripControl = buildAppStrip($("#appStrip"), d.apps || [], emu, guardedAbiCall);
  }

  shakeSensorIndex = (d.sensors || []).findIndex((s) => s.kind === "event" && s.id.toLowerCase() === "shake");
  vectorSensorIndices = (d.sensors || []).reduce<number[]>((acc, s, i) => {
    if (s.kind === "vector") acc.push(i);
    return acc;
  }, []);
  streamSensorIndices = (d.sensors || []).reduce<number[]>((acc, s, i) => {
    if (s.kind === "stream") acc.push(i);
    return acc;
  }, []);
  phoneMotion.onDeviceChanged(vectorSensorIndices.length > 0, shakeSensorIndex >= 0, streamSensorIndices.length > 0);
  // The embed shake button only ever shows for a device that actually
  // declared one - same source of truth as the (hidden, in embed) sidebar
  // sensor button above, never a second, independent "does this have
  // shake" guess. No-op outside embed mode: buildEmbedControls never ran,
  // so embedShakeBtn stays null.
  if (embedShakeBtn) embedShakeBtn.hidden = shakeSensorIndex < 0;

  touchEnabled = (d.touch?.points ?? 0) > 0;
  panelEl.style.cursor = touchEnabled ? "crosshair" : "default";

  touchOverlay.pxPerMm = derivePxPerMm(d);
  refreshContactInfo();
  buildGestures(d);
  centerDeviceOnce();
  fitDeviceToStage();
}

// ---- gestures: give every declared gesture a button that PERFORMS it ----
//
// "how" (see wasm.ts's DeviceGesture) is prose written for a person, and
// this page must never try to derive a button sequence from it: wording
// can change independently of behaviour, so a page that scraped prose
// would go stale silently, which is exactly the kind of bug this emulator
// exists to catch rather than commit. The only thing this page ever
// executes is the OPTIONAL "script" field, a small machine-readable
// sequence the firmware itself declares (see wasm.ts's GestureStep and
// docs/abi.md).
//
// A gesture with no script degrades honestly: no button that silently does
// nothing, a plain sentence saying automatic performing isn't available for
// this build and pointing at the manual key-chord path instead.
function scriptButtonIds(script: unknown): string[] | null {
  if (!Array.isArray(script) || script.length === 0) return null;
  const ids: string[] = [];
  for (const step of script) {
    if (typeof step !== "object" || step === null) return null;
    const s = step as Record<string, unknown>;
    if (typeof s.hold === "string") {
      if (!wiredButtonById.has(s.hold)) return null;
      ids.push(s.hold);
    } else if (typeof s.release === "string") {
      if (!wiredButtonById.has(s.release)) return null;
    } else if (typeof s.waitMs === "number") {
      if (!(s.waitMs > 0 && s.waitMs < 60000)) return null;
    } else {
      return null; // an unrecognised step shape: refuse to guess what it meant
    }
  }
  return ids;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Executes a gesture's script through the SAME real input path a mouse or
// keyboard chord uses (WiredButton.down()/up(), which is exactly what
// device.ts's wireButton hands pointerdown/pointerup and shortcuts.ts's
// bindHeld hands keydown/keyup) - never emu_app_switch() or any other
// shortcut into app state. The gesture itself is under test here: a long
// press still runs on its own real setTimeout inside wireButton, a waitMs
// step still waits real milliseconds while the page's own requestAnimationFrame
// loop keeps calling emu_tick() underneath, and any multi-button gesture's
// ordering, overlap and timing are exactly what a physical chord would
// produce. A control that bypassed this to call emu_app_switch(-1) directly
// would "work" every time and hide exactly the class of bug a real chord
// can have (an input-state regression that only shows up through the real
// press path).
async function runGestureScript(script: unknown, log: (t: string) => void): Promise<void> {
  const steps = script as { hold?: string; release?: string; waitMs?: number }[];
  for (const step of steps) {
    if (step.hold !== undefined) {
      wiredButtonById.get(step.hold)!.down();
    } else if (step.release !== undefined) {
      wiredButtonById.get(step.release)!.up();
    } else if (step.waitMs !== undefined) {
      await sleep(step.waitMs);
    }
  }
  log("done");
}

// One <details> disclosure per declared gesture, closed by default: this
// is the one place real prose (the "how" text) is unavoidable, since it
// describes a physical action, so it stays out of permanent chrome and
// only appears when opened.
function buildGestures(d: DeviceDescriptor): void {
  const wrap = $("#gesturesWrap");
  wrap.innerHTML = "";
  if (!d.gestures || d.gestures.length === 0) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  for (const g of d.gestures) {
    const det = document.createElement("details");
    det.className = "disclosure gesture-detail";
    det.open = false; // explicit: this prose stays off the page until asked for
    const summary = document.createElement("summary");
    summary.textContent = g.label;
    det.appendChild(summary);

    const body = document.createElement("div");
    body.className = "gesture-body";
    const how = document.createElement("p");
    how.className = "how";
    how.textContent = g.how;
    body.appendChild(how);

    const holdIds = scriptButtonIds(g.script);
    const actions = document.createElement("div");
    actions.className = "gesture-actions";

    // One control either way, "perform": present but disabled when this
    // build has not declared a script, rather than a second, differently
    // worded element ("no script" named the missing DATA, not what the
    // person should do instead, which the button's own disabled state and
    // title already say).
    const btn = document.createElement("button");
    btn.className = "chrome-btn";
    btn.textContent = "perform";
    if (holdIds) {
      btn.addEventListener("click", () => {
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = "...";
        consoleLog.push(`gesture: performing "${g.label}" through the real button path`);
        void runGestureScript(g.script, (t) => consoleLog.push(`gesture: ${t}`)).finally(() => {
          btn.disabled = false;
          btn.textContent = prevText;
        });
      });
    } else {
      btn.disabled = true;
      btn.title = "not available yet: this build does not declare a script for this gesture. Use the button chord above instead";
    }
    actions.appendChild(btn);

    const uniqueIds = holdIds ? [...new Set(holdIds)] : [];
    const keys = uniqueIds.map((id) => buttonKeyById.get(id)?.toUpperCase()).filter((k): k is string => !!k);
    if (keys.length > 0) {
      const keysEl = document.createElement("span");
      keysEl.className = "gesture-keys";
      keysEl.title = "same as holding these together";
      keysEl.innerHTML = keys.map((k) => `<span class="kbd">${escapeHtml(k)}</span>`).join("+");
      actions.appendChild(keysEl);
    }
    body.appendChild(actions);
    det.appendChild(body);
    wrap.appendChild(det);
  }
}

// ---- centre the puck over the stage, once, on first load ----------------
function centerDeviceOnce(): void {
  if (centeredOnce) return;
  // Embed mode centres purely in CSS (app.css's html.embed .device-wrap:
  // left/top 50% + translate(-50%,-50%), which stays correct at any
  // --embed-scale) rather than here. This function's own left/top math is
  // in UNSCALED pixels, clamped to a 20px floor when the stage is smaller
  // than the device - exactly the plain dev UI's case (a large, scrollable
  // stage), never the embed case (the device is usually BIGGER than the
  // card/iframe before fitDeviceToStage's scale shrinks it). Setting an
  // inline left/top here would fight that CSS rule's own centring (an
  // inline style otherwise wins over an external stylesheet), and letting
  // it through was the actual cause of the fluidbox landing-page card
  // cropping the bottom of the device: this function's clamped, unscaled
  // "centre" is not where the SCALED device's centre needs to be, so
  // scaling around it left the device's bottom edge past the iframe's own
  // bottom edge. See that CSS rule's own comment for the full geometry.
  if (EMBED) {
    centeredOnce = true;
    return;
  }
  const stageRect = stageEl.getBoundingClientRect();
  const bw = bezelEl.offsetWidth;
  const bh = bezelEl.offsetHeight;
  if (bw === 0 || bh === 0 || stageRect.width === 0) return; // not laid out yet
  deviceWrapEl.style.left = `${Math.max(20, Math.round((stageRect.width - bw) / 2))}px`;
  deviceWrapEl.style.top = `${Math.max(20, Math.round((stageRect.height - bh) / 2))}px`;
  centeredOnce = true;
}

// ---- embed mode: the bare device only -------------------------------------
// See EMBED's own header comment above. DOM/CSS only - no ABI behaviour
// changes, touch/keyboard input keeps working exactly as before. Everything
// that used to live in the bottom bar (rotation buttons, any declared
// event-sensor pill) is hidden outright by app.css's html.embed .bottom-bar
// rule, so there is nothing left here to relocate: the elements stay right
// where buildChrome/buildSensorControls always put them, just not painted.
// Reachable instead through the R/S keyboard shortcuts buildChrome always
// registers (see its own "embed: keyboard-only rotate" comment) - device
// agnostic the same way the old strip was, never a hardcoded button name.
function applyEmbedMode(): void {
  if (!EMBED) return;
  document.documentElement.classList.add("embed");
}

// ---- embed mode: the minimal control cluster (rotate + shake) -------------
// Sylve's own read of the run pages ("'r' doesn't rotate anything... just
// include buttons on the emulators"): the R/S keyboard shortcuts above are
// dead on arrival inside a run page's iframe until the iframe itself has
// page focus (a visitor who never clicked/tapped the device gets nothing
// from pressing a key), so a button is the PRIMARY path here, not a
// decorative extra alongside the shortcut. Built fresh, once, for the embed
// layer - this is explicitly NOT the old .bottom-bar strip (app.css's
// html.embed .bottom-bar rule still hides that outright, unchanged): two
// small ghost icon buttons, low-contrast until hovered/pressed (see
// app.css's .embed-ctrl-btn), that fire through the EXACT same paths the
// removed strip's own rotation segtog / shake pill used - cycleQuickRotation
// and sensorControls.fire("shake") - never a second, parallel
// implementation of either.
//
// Mounted into #stage (not #deviceWrap): centred under the device via CSS
// (app.css's .embed-controls), the same "own row below the bezel" spot the
// phone-tilt chip already uses (motion.ts's PhoneMotion) - and, when both
// exist, phoneMotion's own chip joins THIS row (see phoneMotion's mountTo
// option above) rather than sitting in a second, independently centred
// spot.
//
// Called once from wireStaticUI, before reloadModule() ever runs, so
// embedShakeBtn already exists by the time buildChrome's own
// "if (embedShakeBtn) embedShakeBtn.hidden = ..." line first runs.
let embedControlsRow: HTMLDivElement | null = null;
let embedShakeBtn: HTMLButtonElement | null = null;
function buildEmbedControls(): void {
  if (!EMBED) return;
  const row = document.createElement("div");
  row.id = "embedControls";
  row.className = "embed-controls";

  const rotateBtn = document.createElement("button");
  rotateBtn.type = "button";
  rotateBtn.className = "embed-ctrl-btn";
  rotateBtn.setAttribute("aria-label", "rotate");
  rotateBtn.title = "rotate";
  rotateBtn.innerHTML = ROTATE_ICON_SVG;
  rotateBtn.addEventListener("click", () => cycleQuickRotation());
  row.appendChild(rotateBtn);

  // Hidden by default (no sensors are known yet, this runs before the
  // first module load) and revealed by buildChrome the moment a loaded
  // device actually declares a "shake" event sensor - see that function's
  // own "if (embedShakeBtn) embedShakeBtn.hidden = shakeSensorIndex < 0"
  // line, the single source of truth for whether this device has one.
  const shakeBtn = document.createElement("button");
  shakeBtn.type = "button";
  shakeBtn.className = "embed-ctrl-btn";
  shakeBtn.setAttribute("aria-label", "shake");
  shakeBtn.title = "shake";
  shakeBtn.innerHTML = SHAKE_ICON_SVG;
  shakeBtn.hidden = true;
  shakeBtn.addEventListener("click", () => {
    sensorControls?.fire("shake");
  });
  row.appendChild(shakeBtn);

  stageEl.appendChild(row);
  embedControlsRow = row;
  embedShakeBtn = shakeBtn;
}

// ---- embed mode: scale the device to fit whatever viewport/iframe this
// page is running in, instead of the normal dev UI's scroll-and-drag stage.
// Recomputed on load, on window resize, and on every rotation change (a
// quarter turn swaps the on-screen bounding box) - see wireStaticUI's
// #rotQuick handler and boot() for the call sites. A pure CSS transform on
// #deviceWrap (app.css), so it composes cleanly with applyRotation's own
// transform on the bezel one level down (device.ts) rather than fighting
// it. No-ops instantly outside embed mode.
function fitDeviceToStage(): void {
  if (!EMBED) return;
  const stageRect = stageEl.getBoundingClientRect();
  const bw = bezelEl.offsetWidth;
  const bh = bezelEl.offsetHeight;
  if (bw === 0 || bh === 0 || stageRect.width === 0 || stageRect.height === 0) return; // not laid out yet
  // bezelEl.offsetWidth/Height are the panel's own, UNROTATED layout size
  // (a CSS transform never changes layout size, only paint); at a quarter
  // turn the on-screen bounding box swaps, so fitting has to account for
  // that the same way rotate.ts's own "view" space does.
  const quarterTurned = ((Math.round(quickDeg / 90) % 2) + 2) % 2 === 1;
  const boxW = quarterTurned ? bh : bw;
  const boxH = quarterTurned ? bw : bh;
  const margin = 16; // breathing room so the bezel's own drop-shadow never clips
  // Always reserved in embed mode now, not just while the phone-tilt chip
  // happens to be mounted: the rotate button (buildEmbedControls) is
  // unconditional, so this row always occupies that space below the
  // device, chip or no chip - see html.embed .device-wrap's own top offset
  // in app.css, which shifts the device up by the same amount.
  const controlsReserve = 56;
  const scale = Math.min(1, (stageRect.width - margin) / boxW, (stageRect.height - margin - controlsReserve) / boxH);
  deviceWrapEl.style.setProperty("--embed-scale", String(scale > 0 ? scale : 1));
}

// ---- load / reload ----
// Guards against overlapping reloads: the server already waits for the
// wasm file to go quiet before broadcasting (server.ts, waitForStableFile),
// but a manual retry click landing while a reload triggered by that
// broadcast is still in flight would otherwise race two bringUp() calls
// against the same `emu` slot. Simpler to just refuse the second one; the
// first will finish in well under a second either way.
let reloadInFlight = false;

async function reloadModule(reason: string): Promise<void> {
  if (reloadInFlight) {
    consoleLog.push(`reload already in progress, ignoring (${reason})`);
    return;
  }
  reloadInFlight = true;
  consoleLog.push(`loading wasm module (${reason})...`);
  try {
    let bytes: ArrayBuffer;
    try {
      bytes = await fetchWasmBytes(`${WASM_URL}?t=${Date.now()}`);
    } catch (err) {
      failReload(err);
      return;
    }
    await bringUp(bytes, reason);
  } finally {
    reloadInFlight = false;
  }
}

async function bringUp(bytes: ArrayBuffer, reason: string): Promise<void> {
  let newEmu: EmuExports;
  try {
    newEmu = await instantiate(bytes, (text) => consoleLog.push(text));
  } catch (err) {
    failReload(err);
    return;
  }
  if (newEmu.emu_init() === 0) {
    failReload(new Error("emu_init() returned 0 (framebuffer allocation failed; see console pane above for why)"));
    return;
  }
  let newDevice: DeviceDescriptor;
  let reader: PixelReader;
  try {
    newDevice = readDeviceDescriptor(newEmu);
    reader = pixelReaderFor(newDevice.panel.format);
  } catch (err) {
    failReload(err);
    return;
  }
  // The framebuffer pointer, validated BEFORE anything touches it (see
  // abiGuard.ts's validateFbPtr): a hostile/buggy emu_fb() used to throw a
  // raw RangeError from inside blitAll() below, well after `emu` had
  // already been reassigned to the new module -- which is exactly what
  // wasm.ts's own header comment forbids ("a failure here must never tear
  // down a module that was already working"). Checking it here, before the
  // swap below, is what makes this a fourth guarded bringUp() step rather
  // than the unguarded crash docs/findings-first-adversarial-pass.md found.
  let newFbPtr: number;
  try {
    newFbPtr = readFramebufferPointer(newEmu, newDevice.panel);
  } catch (err) {
    failReload(err);
    return;
  }

  // Everything above is validated against the NEW module without ever
  // touching state the page is currently showing. From here on, the new
  // module is trusted enough to become the live one -- buildChrome()
  // itself needs `emu` already pointed at it (buildSensorControls/
  // buildAppStrip wire their callbacks against the module-level `emu`),
  // so full transactional swap-only-on-total-success isn't available past
  // this point without a much larger refactor. What IS still guarded: if
  // building the chrome or painting the first frame throws anyway (despite
  // every value above having already been validated), it is reported the
  // same way as the four checked failures rather than left to crash
  // silently and freeze the boot sequence -- see
  // docs/findings-first-adversarial-pass.md's "shows device name but never
  // paints" finding, which this closes.
  try {
    hideWasmError();
    wasmBytes = bytes;
    const prevAppIndex = lastAppIndex;
    emu = newEmu;
    device = newDevice;
    panelW = newDevice.panel.w;
    panelH = newDevice.panel.h;
    fbPtr = newFbPtr;
    pixelReader = reader;
    soundPlayer.resetForReload(newEmu);
    // A fresh, successfully-brought-up module means whatever killed the
    // previous one (if anything) no longer applies.
    deadState = null;
    tickCount = 0;
    hideEngineDead();

    if (touchSim) touchSim.setBounds(panelW, panelH);
    else touchSim = new TouchSim(touchCfg, panelW, panelH);

    buildChrome(newDevice);
    sendGravityForRotation(); // once at module ready, see this function's header comment

    if (newDevice.apps && newDevice.apps.length > 0 && newEmu.emu_app_switch && newEmu.emu_app_current) {
      const idx = Math.min(prevAppIndex, newDevice.apps.length - 1);
      if (idx !== newEmu.emu_app_current()) {
        newEmu.emu_app_switch(idx);
        consoleLog.push(
          `resumed at app "${newDevice.apps[idx]}" (index preserved across reload; the app's own state was ` +
            `NOT, since state generally resets on init/switch -- this is a "which app", not a "where it was")`
        );
        appStripControl?.refresh();
      }
    }

    // Painted immediately, not left to wait for the next tick's partial
    // pushes: the screen must never show a stale frame from a previous
    // module after a reload.
    blitAll(panelCtx, newEmu.memory, fbPtr, panelW, panelH, reader);
    consoleLog.push(`ready: ${newDevice.name || "device"} ${panelW}x${panelH} ${newDevice.panel.format} (${reason})`);
    updateReloadStatus(bytes.byteLength);
  } catch (err) {
    failReload(err);
  }
}

// ---- readouts: one quiet monospace strip, not scattered chrome ----------
// Coordinates, push counts, reload status and shake jolts are all
// diagnostics, and they read as one instrument when they live in one
// place. The coordinate segment only appears while the overlay (item 1)
// is switched on: it is part of that same toggle, not a separate readout
// that happens to survive turning the overlay off. The pixel format lives
// here too, not in the device section: it names an internal encoding (a
// raw technical fact), which is exactly what this strip is for.
function updateDiagStrip(): void {
  const parts: string[] = [];
  if (overlayEnabled && lastTouchMapped) {
    parts.push(`${lastTouchMapped.panel.x},${lastTouchMapped.panel.y}`);
  }
  parts.push(`push ${pushOverlay.lastCount}×${pushOverlay.lastWidth}px`);
  // Only for a device that declared sound at all; "suspended" is what
  // makes the autoplay-policy case say so rather than playing nothing
  // silently, per emu_abi.h.
  if (emu?.emu_sound_play_seq) parts.push(`sound ${soundPlayer.status}`);
  // Whichever of the two detectors is actually seeing motion right now:
  // this is the "tell the user whether their shaking is being seen at
  // all" readout, and a person only ever tries one gesture at a time.
  const shakeCount = Math.max(windowShake.lastJoltCount, puckDragShake.lastJoltCount);
  parts.push(`shake ${shakeCount}/${windowShake.cfg.joltMinCount}`);
  if (device) parts.push(device.panel.format);
  parts.push(`${recorder.events.length.toLocaleString()} rec`);
  if (lastReloadStatus) parts.push(lastReloadStatus);
  diagStripEl.textContent = parts.join("   ·   ");
}
function updateReplayBar(): void {
  if (!replayer) {
    replayBarEl.classList.add("hidden");
    btnStopReplay.classList.add("hidden");
    return;
  }
  const p = replayer.progress;
  replayBarEl.classList.remove("hidden");
  btnStopReplay.classList.remove("hidden");
  replayBarEl.textContent = `replaying: ${p.at}/${p.total}${paused ? " (paused)" : ""}`;
}

// ---- panel input: mouse/touch -> panel coordinates -> emu_touch ----
function wirePanelInput(): void {
  panelEl.addEventListener("pointerdown", (e) => {
    if (!touchEnabled || replayer) return;
    pointerIdDown = e.pointerId;
    panelEl.setPointerCapture(e.pointerId);
    const m = mapClientPoint(e.clientX, e.clientY, panelEl, quickDeg, tiltDeg, panelW, panelH);
    liveTouch = { fingers: 1, x: m.panel.x, y: m.panel.y };
    touchSim?.setPointer(true, m.panel.x, m.panel.y);
    lastTouchMapped = m;
    e.preventDefault();
  });
  panelEl.addEventListener("pointermove", (e) => {
    if (!touchEnabled) return;
    const m = mapClientPoint(e.clientX, e.clientY, panelEl, quickDeg, tiltDeg, panelW, panelH);
    if (pointerIdDown === e.pointerId) {
      liveTouch = { fingers: 1, x: m.panel.x, y: m.panel.y };
      touchSim?.setPointer(true, m.panel.x, m.panel.y);
      lastTouchMapped = m;
    } else if (pointerIdDown === null && !replayer) {
      if (overlayEnabled) touchOverlay.recordHover(m.panel.x, m.panel.y);
      lastTouchMapped = m;
    }
  });
  function release(e: PointerEvent): void {
    if (pointerIdDown !== e.pointerId) return;
    pointerIdDown = null;
    liveTouch = { fingers: 0, x: liveTouch.x, y: liveTouch.y };
    touchSim?.setPointer(false, liveTouch.x, liveTouch.y);
  }
  panelEl.addEventListener("pointerup", release);
  panelEl.addEventListener("pointercancel", release);
  panelEl.addEventListener("pointerleave", () => {
    if (pointerIdDown === null) touchOverlay.recordHover(null, null);
  });
}

// ---- the tick loop ----
// The entire body is one guarded call: per abiGuard.ts's boundary
// validation, a bad push rectangle or a bad audio buffer can no longer
// reach a raw typed-array throw, but a genuine wasm trap (a real wild
// pointer write inside emu_tick() itself) is not something JS-side
// validation can ever prevent -- it happens entirely inside the module's
// own compiled code. This try/catch is the backstop for exactly that case:
// see enterDeadState's header comment for what happens next.
function stepOnce(): void {
  if (!emu || !pixelReader) return;
  try {
    stepOnceUnguarded(emu);
  } catch (err) {
    enterDeadState(err);
  }
}

function stepOnceUnguarded(liveEmu: EmuExports): void {
  if (replayer) {
    const t = replayer.stepFrame(liveEmu);
    if (t === null) {
      consoleLog.push("replay finished");
      paused = true;
      btnPause.textContent = "resume";
    } else {
      tickCount++;
      afterTick(t);
    }
    updateReplayBar();
    return;
  }
  const now = performance.now();
  if (touchEnabled) {
    const report: TouchReport = touchDefectsEnabled && touchSim ? touchSim.poll(now) : liveTouch;
    liveEmu.emu_touch(report.fingers, Math.round(report.x), Math.round(report.y));
    recorder.record({ t: now, k: "touch", down: report.fingers, x: Math.round(report.x), y: Math.round(report.y) });
    touchOverlay.recordTouch(report.fingers === 1, report.x, report.y, now);
  }
  liveEmu.emu_tick(now);
  tickCount++;
  recorder.record({ t: now, k: "tick" });
  afterTick(now);
}

function afterTick(now: number): void {
  if (!emu || !pixelReader) return;
  const { rects, findings } = readPushes(emu, panelW, panelH);
  for (const f of findings) consoleLog.push(`firmware bug: ${f}`);
  for (const r of rects) blitRect(panelCtx, emu.memory, fbPtr, panelW, pixelReader, r);
  pushOverlay.record(rects, now);
  for (const r of rects) pushHistory.push({ tMs: now, ...r });
  while (pushHistory.length > PUSH_HISTORY_MAX) pushHistory.shift();
  if (device?.apps && device.apps.length > 0 && emu.emu_app_current) lastAppIndex = emu.emu_app_current();
  appStripControl?.refresh();
  soundPlayer.poll(emu, (text) => consoleLog.push(text)); // right after emu_tick(), per emu_abi.h's sound section
}

function frame(): void {
  // Stop ticking entirely once dead, rather than re-entering a module that
  // just crashed at 60Hz (stepOnce's own try/catch would keep catching the
  // same exception every frame forever, which is not "stopped", just
  // "silently retried and discarded" -- the requirement is to actually
  // stop). The rest of the loop (this function's own requestAnimationFrame
  // call at the bottom) keeps running regardless, which is what keeps
  // "reload" clickable and the page otherwise alive.
  if (emu && !paused && !deadState) stepOnce();
  const now = performance.now();
  overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);
  if (deadState) {
    // Painted every frame, unconditionally: this is a status, not a
    // diagnostics preference like overlayEnabled below it.
    paintDeadOverlay(overlayCtx, overlayEl.width, overlayEl.height);
  } else {
    // Two independent switches, one shared canvas (cleared once, above).
    pushOverlay.paint(overlayCtx, now, accentColor); // no-ops while disabled
    if (overlayEnabled) touchOverlay.paint(overlayCtx, now, accentColor);
  }
  pollWindowShake(now);
  puckMotion.tick(window.screenX, window.screenY, now);
  applyRotation(bezelEl, quickDeg + tiltDeg, puckMotion.offsetX + dragOffsetX, puckMotion.offsetY + dragOffsetY);
  updateDiagStrip();
  requestAnimationFrame(frame);
}

// ---- shake ----------------------------------------------------------------
// Two independent triggers feed the same ABI call. A real OS titlebar drag
// on Windows enters a synchronous move loop (WM_ENTERSIZEMOVE) that can
// stop the renderer from being scheduled, so requestAnimationFrame - and
// with it every per-frame screenX/screenY sample - can simply never run
// while the drag is happening, no matter the jolt threshold (see
// windowshake.ts's header comment). It stays wired (it may still work in
// some environments/Chrome versions) but is not the recommended path.
//
// The reliable path: dragging the puck ITSELF is ordinary DOM pointer
// input, which is never subject to a native modal loop and always gets
// frames, and arguably reads as a better gesture besides (you are shaking
// the device, not the window it happens to be displayed in). Wired below
// via device.ts's makeDraggable onDrag callback, same jolt-detector shape.
// ---- vector sensors (e.g. tilt): driven by the existing rotation control --
// Rotating the on-screen view IS physically rotating the device (see
// rotate.ts's gravityForQuickDeg header comment), so the same quick-rotate
// buttons that already remap touch coordinates also send a fresh gravity
// reading to every declared "kind": "vector" sensor - generic over kind,
// never over a sensor's id/name (this repo's AGENTS.md rule). No-ops
// instantly if the device declared no vector sensor, or if the loaded
// module never exported emu_sensor_vector (an older/other firmware).
// Called on every rotation change and once right after a module comes up
// (bringUp below), so a fresh module always starts with a reading that
// matches whatever rotation was already selected, rather than waiting for
// the next click to correct it.
function sendVector(x: number, y: number, z: number, source: string): void {
  if (!emu || !emu.emu_sensor_vector || vectorSensorIndices.length === 0) return;
  for (const i of vectorSensorIndices) {
    guardedAbiCall(`sensor[${i}] vector (${source})`, (liveEmu) => {
      liveEmu.emu_sensor_vector!(i, x, y, z);
      recorder.record({ t: performance.now(), k: "vector", i, x, y, z });
    });
  }
}

// ---- stream sensors (raw accelerometer): driven live from motion.ts -------
// A "kind": "stream" sensor's own ABI (emu_accel_sample, OPTIONAL) is a
// SEPARATE call from sendVector's emu_sensor_vector: this pushes one RAW
// sample per real reading the phone or the desktop drag synthesizer
// actually produced, never a resample of the fused vector sendVector
// already sent for the same event - see motion.ts's PhoneMotion.
// onDeviceMotion and DragMotion.updateFromClient/springBack, the two call
// sites that feed this. No-ops instantly if the device declared no stream
// sensor, or the loaded module never exported emu_accel_sample (an older/
// other firmware) - same "unimplemented means uncalled" contract sendVector
// already follows for emu_sensor_vector.
function sendAccel(ax: number, ay: number, az: number, tMs: number, source: string): void {
  if (!emu || !emu.emu_accel_sample || streamSensorIndices.length === 0) return;
  for (const i of streamSensorIndices) {
    guardedAbiCall(`sensor[${i}] accel (${source})`, (liveEmu) => {
      liveEmu.emu_accel_sample!(i, tMs, ax, ay, az);
      recorder.record({ t: tMs, k: "accel", i, ax, ay, az });
    });
  }
}

function sendGravityForRotation(): void {
  if (phoneMotion.isActive()) return;
  const g = gravityForQuickDeg(quickDeg);
  sendVector(g.x, g.y, g.z, "rotation");
}

// ---- quick rotation: the single place that actually applies a rotation
// step, shared by the #rotQuick buttons' own click handler and (see
// buildChrome's "embed: keyboard-only rotate" binding) the "r" keyboard
// shortcut. Both need the exact same four steps (move the CSS transform,
// mark which button is active, resend gravity, refit the embed scale); a
// second, slightly-different copy of this in the keyboard path would be
// the kind of drift that quietly breaks one of the two later.
const QUICK_ROT_ORDER = [0, 90, 180, -90] as const;
function setQuickRotation(deg: number): void {
  quickDeg = deg;
  $("#rotQuick")
    .querySelectorAll<HTMLButtonElement>("button")
    .forEach((x) => x.classList.toggle("active", Number(x.dataset.deg) === deg));
  applyRotation(bezelEl, quickDeg + tiltDeg, puckMotion.offsetX + dragOffsetX, puckMotion.offsetY + dragOffsetY);
  phoneMotion.onQuickRotationChanged();
  sendGravityForRotation();
  fitDeviceToStage();
}
// Rotates one quarter turn further along QUICK_ROT_ORDER - what the "r"
// keyboard shortcut does. Not a hardcoded "always -90": cycling keeps this
// meaningful for a device that only ever needs one turn (chrono, one press
// gets there) as much as for exploring all four (fluidbox's demo, see
// site/record-demos.ts).
function cycleQuickRotation(): void {
  const i = QUICK_ROT_ORDER.indexOf(quickDeg as (typeof QUICK_ROT_ORDER)[number]);
  const next = QUICK_ROT_ORDER[(i < 0 ? 0 : i + 1) % QUICK_ROT_ORDER.length]!;
  setQuickRotation(next);
}

function fireShakeSensor(now: number, source: string): void {
  if (shakeSensorIndex < 0 || replayer) return;
  // Also called every frame from pollWindowShake below, unconditionally --
  // guardedAbiCall's own deadState check is what stops this from calling
  // into an already-trapped module once the engine has crashed, since
  // frame() keeps calling pollWindowShake() even after deadState is set (it
  // stops calling stepOnce, not the rest of the frame).
  guardedAbiCall(`sensor[${shakeSensorIndex}] (shake, ${source})`, (liveEmu) => {
    liveEmu.emu_sensor_event(shakeSensorIndex);
    recorder.record({ t: now, k: "sensor", i: shakeSensorIndex });
    consoleLog.push(`shake: ${source} accepted`);
  });
}

function pollWindowShake(now: number): void {
  const suppressed = liveTouch.fingers === 1 || pointerIdDown !== null;
  if (windowShake.poll(window.screenX, window.screenY, now, suppressed)) fireShakeSensor(now, "window jolt");
}

function onPuckDrag(clientX: number, clientY: number): void {
  const now = performance.now();
  if (puckDragShake.poll(clientX, clientY, now, liveTouch.fingers === 1)) fireShakeSensor(now, "puck drag");
}

// ---- replay ----
function startReplay(trace: Trace): void {
  if (!wasmBytes) {
    consoleLog.push("cannot replay: no wasm module loaded yet");
    return;
  }
  recorder.enabled = false;
  paused = true;
  btnPause.textContent = "resume";
  void bringUp(wasmBytes, `replay of trace recorded ${trace.recordedAt}`).then(() => {
    replayer = new Replayer(trace.events);
    updateReplayBar();
    consoleLog.push(`replay loaded: ${trace.events.length} events. step or resume to play.`);
  });
}
function stopReplay(): void {
  replayer = null;
  recorder.enabled = true;
  paused = false;
  btnPause.textContent = "pause";
  updateReplayBar();
  void reloadModule("resuming live input after replay");
}
function wireTraceFile(): void {
  const input = $<HTMLInputElement>("#traceFileInput");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    void (async () => {
      try {
        const text = await file.text();
        const trace = JSON.parse(text) as Trace;
        if (!Array.isArray(trace.events)) throw new Error("not a trace file (missing events array)");
        startReplay(trace);
      } catch (err) {
        consoleLog.push(`could not load trace: ${errMsg(err)}`);
      }
    })();
  });
}

// ---- freeze / trace save ----
// Found in the sweep for any remaining unguarded direct emu.emu_* call:
// runFreeze() (below) reads emu_app_current() straight from the "freeze"
// button's click handler, the exact same shape as the button/sensor/
// app-switch calls guardedAbiCall exists for. Kept as its own small
// function rather than routed through guardedAbiCall itself because it
// needs to return a VALUE (the app name for the bundle), not just fire an
// effect -- and because once the engine is already dead, the right answer
// is not "call into the dead module again", it's "fall back to
// lastAppIndex", the last index afterTick() actually observed succeed.
function currentAppNameForFreeze(): string | null {
  if (!device?.apps || device.apps.length === 0) return null;
  if (deadState) return device.apps[lastAppIndex] ?? null;
  if (!emu?.emu_app_current) return null;
  try {
    return device.apps[emu.emu_app_current()] ?? null;
  } catch (err) {
    enterDeadState(err, "app_current() (read while freezing)");
    return device.apps[lastAppIndex] ?? null;
  }
}

async function runFreeze(): Promise<void> {
  if (!emu || !device) {
    consoleLog.push("cannot freeze: no wasm module loaded");
    return;
  }
  const panelPngBase64 = canvasToPngBase64(panelEl);
  const currentApp = currentAppNameForFreeze();
  // The one field that keeps this bundle honest when the engine is dead
  // (see freeze.ts's EngineStatus header comment): a freeze taken after a
  // silent crash still reads the last-painted canvas and the recorder's
  // existing history just fine, neither of which needs the tick loop to be
  // alive, so without this an agent reading the bundle would have no way
  // to know the session it describes is over.
  const engine: EngineStatus = deadState
    ? {
        alive: false,
        error: deadState.error,
        diedOnTick: deadState.diedOnTick,
        cause: deadState.cause,
        lastInputEvent: deadState.lastInputEvent,
        diedAt: deadState.diedAt,
      }
    : { alive: true };
  const bundle: FreezeBundle = {
    schemaVersion: 2,
    capturedAt: new Date().toISOString(),
    device,
    currentApp,
    pushes: pushHistory.slice(-200),
    input: recorder.recent(200),
    console: consoleLog.recent(100),
    journal: emptyJournal(),
    panelPngBase64,
    engine,
  };
  const first = await postFreeze(bundle);
  if (!first.ok) {
    consoleLog.push(`freeze failed: ${first.error}`);
    return;
  }
  consoleLog.push(`frozen -> ${first.path}`);
  const journal = await openAnnotationModal(panelPngBase64, panelW, panelH);
  if (journal && (journal.strokes.length > 0 || journal.notes.length > 0)) {
    const second = await postFreeze({ ...bundle, journal }, first.id);
    consoleLog.push(second.ok ? `annotations saved -> ${second.path}` : `saving annotations failed: ${second.error}`);
  }
}

async function saveTraceToServer(): Promise<void> {
  if (!device) {
    consoleLog.push("nothing to save yet");
    return;
  }
  const trace = recorder.toTrace(device);
  try {
    const res = await fetch("/api/trace", { method: "POST", headers: { "content-type": "application/json", "x-puck-emulator": "1" }, body: JSON.stringify(trace) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { path: string };
    consoleLog.push(`trace saved -> ${data.path}`);
  } catch (err) {
    consoleLog.push(`save trace failed: ${errMsg(err)}`);
  }
}

// ---- hardware-free regression check: "did I just break something" ------
//
// Everything this needs already exists: recorder.ts captures the trace,
// src/regression.ts replays it deterministically against a FRESH module
// instance (never the live, ticking one - same reasoning as startReplay
// above) and diffs the result with the same compareFrames the differential
// harness uses. This file's only job is wiring the two buttons to that and
// to the server routes that make a baseline survive a reload (see
// server.ts / baselineStore.ts).
//
// BE HONEST: this compares the emulator against itself. It catches a
// firmware regression; it proves nothing about real hardware or timing -
// see docs/harness.md's "A regression check with no hardware" section, and
// this feature's own button tooltips in index.html.
function showRegressionPill(text: string, kind: "ok" | "fail" | "neutral"): void {
  const el = $("#regressionPill");
  el.textContent = text;
  el.className = kind === "neutral" ? "pill hint" : `pill status ${kind}`;
}

async function saveBaselineToServer(): Promise<void> {
  if (!emu || !device || !wasmBytes) {
    consoleLog.push("cannot save baseline: no wasm module loaded");
    return;
  }
  const trace = recorder.toTrace(device);
  if (trace.events.length === 0) {
    consoleLog.push("cannot save baseline: nothing recorded yet -- touch or press something first, or let a few ticks run");
    return;
  }
  consoleLog.push("saving baseline (replaying against a fresh module instance)...");
  try {
    const baseline = await captureBaseline(wasmBytes, trace.events);
    const res = await fetch("/api/baseline", {
      method: "POST",
      headers: { "content-type": "application/json", "x-puck-emulator": "1" },
      body: JSON.stringify(baseline),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { path: string };
    consoleLog.push(`baseline saved -> ${data.path} (${baseline.capturePoints.length} capture point(s))`);
    showRegressionPill(`baseline: ${baseline.capturePoints.length}pt`, "neutral");
  } catch (err) {
    consoleLog.push(`save baseline failed: ${errMsg(err)}`);
  }
}

async function checkBaseline(): Promise<void> {
  if (!wasmBytes) {
    consoleLog.push("cannot check: no wasm module loaded");
    return;
  }
  let baseline: BaselineBundle;
  try {
    const res = await fetch("/api/baseline");
    if (res.status === 404) {
      consoleLog.push('no baseline saved yet -- click "baseline" first');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    baseline = (await res.json()) as BaselineBundle;
  } catch (err) {
    consoleLog.push(`load baseline failed: ${errMsg(err)}`);
    return;
  }

  consoleLog.push("checking against baseline (replaying its trace against a fresh instance of the current module)...");
  let check: RegressionCheck;
  try {
    check = await checkAgainstBaseline(wasmBytes, baseline);
  } catch (err) {
    consoleLog.push(`regression check failed to run: ${errMsg(err)}`);
    return;
  }

  const failCount = check.points.filter((p) => !p.match).length;
  consoleLog.push(
    check.pass
      ? `regression check: PASS (${check.points.length} capture point(s), against the emulator only)`
      : `regression check: FAIL, ${failCount}/${check.points.length} capture point(s) diverged`
  );
  showRegressionPill(check.pass ? "regression: pass" : `regression: fail ${failCount}/${check.points.length}`, check.pass ? "ok" : "fail");

  try {
    const payload = toRegressionResultPayload(baseline, check);
    const res = await fetch("/api/regression-result", {
      method: "POST",
      headers: { "content-type": "application/json", "x-puck-emulator": "1" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = (await res.json()) as { path: string };
      consoleLog.push(`regression result -> ${data.path}`);
    }
  } catch {
    // Best-effort export: the in-page pill/modal already reported the
    // result regardless of whether writing it to disk for an agent works.
  }

  if (!check.pass) void openRegressionModal(check);
}

// ---- live reload: watch server tells us when the wasm build changed ----
function connectLiveReload(): void {
  const dot = $("#reloadDot");
  try {
    const ws = new WebSocket(`ws://${location.host}/api/livereload`);
    ws.addEventListener("open", () => dot.classList.add("connected"));
    ws.addEventListener("close", () => {
      dot.classList.remove("connected");
      setTimeout(connectLiveReload, 2000);
    });
    ws.addEventListener("error", () => ws.close());
    ws.addEventListener("message", (e) => {
      if (e.data === "reload" && !replayer) void reloadModule("wasm file changed on disk");
    });
  } catch {
    // No websocket route to connect to (e.g. served through a read-only
    // static file server): fine, just no live reload there.
  }
}

// ---- touch controller sliders ----
function buildTouchControls(): void {
  const el = $("#touchControls");
  el.innerHTML = `
    <div class="slider-row">
      <div class="row-head"><b>report rate</b><span id="rrVal">${touchCfg.reportRateHz}Hz</span></div>
      <input id="rrInput" type="range" min="10" max="240" step="5" value="${touchCfg.reportRateHz}" />
    </div>
    <div class="toggle-row">
      <input id="dropoutsOn" type="checkbox" ${touchCfg.dropoutsEnabled ? "checked" : ""} />
      <label for="dropoutsOn">dropouts mid-stroke</label>
    </div>
    <div class="slider-row">
      <div class="row-head"><b>dropout rate</b><span id="dpVal">${touchCfg.dropoutsPerSec}/s</span></div>
      <input id="dpInput" type="range" min="0" max="5" step="0.1" value="${touchCfg.dropoutsPerSec}" />
    </div>
    <div class="toggle-row">
      <input id="straysOn" type="checkbox" ${touchCfg.straysEnabled ? "checked" : ""} />
      <label for="straysOn">stray contacts</label>
    </div>
    <div class="slider-row">
      <div class="row-head"><b>stray rate</b><span id="stVal">${touchCfg.straysPerSec}/s</span></div>
      <input id="stInput" type="range" min="0" max="2" step="0.05" value="${touchCfg.straysPerSec}" />
    </div>
  `;
  $<HTMLInputElement>("#rrInput").addEventListener("input", (e) => {
    touchCfg.reportRateHz = Number((e.target as HTMLInputElement).value);
    $("#rrVal").textContent = `${touchCfg.reportRateHz}Hz`;
  });
  $<HTMLInputElement>("#dropoutsOn").addEventListener("change", (e) => {
    touchCfg.dropoutsEnabled = (e.target as HTMLInputElement).checked;
  });
  $<HTMLInputElement>("#dpInput").addEventListener("input", (e) => {
    touchCfg.dropoutsPerSec = Number((e.target as HTMLInputElement).value);
    $("#dpVal").textContent = `${touchCfg.dropoutsPerSec}/s`;
  });
  $<HTMLInputElement>("#straysOn").addEventListener("change", (e) => {
    touchCfg.straysEnabled = (e.target as HTMLInputElement).checked;
  });
  $<HTMLInputElement>("#stInput").addEventListener("input", (e) => {
    touchCfg.straysPerSec = Number((e.target as HTMLInputElement).value);
    $("#stVal").textContent = `${touchCfg.straysPerSec}/s`;
  });
}

// ---- static UI: everything not dependent on a loaded module ----
function wireStaticUI(): void {
  applyEmbedMode(); // before anything below, so the strip is already in place for first paint
  buildEmbedControls(); // no-op outside embed mode; must exist before phoneMotion's own chip can mount into it
  window.addEventListener("resize", () => fitDeviceToStage()); // no-op outside embed mode

  // Keyboard shortcuts' supporting fix, secondary to the buttons above: R/S
  // only reach this page's own `window` (ShortcutRegistry's listener) once
  // THIS document actually holds page/frame focus, which an embedded
  // iframe with no focusable child does not reliably get from a touch (see
  // this file's own EMBED header comment - "keydown goes to the outer
  // document until the iframe is clicked" was the root cause report this
  // whole feature responds to). Grabbing focus explicitly on the very
  // first pointerdown anywhere in the embed means a key pressed right
  // after the first tap/click reaches this document instead of silently
  // landing on the parent page. Idempotent and cheap, so it stays wired on
  // every subsequent pointerdown too rather than trying to fire "only
  // once".
  if (EMBED) {
    document.addEventListener("pointerdown", () => window.focus());
  }

  wireContactSize();

  // Free bezel repositioning is a dev-UI convenience, not something an
  // embed should ever offer: the iframe is fixed inside someone else's
  // page layout, so "drag the plastic" only ever reads as a miss-click
  // (see this file's EMBED header comment). Left uncalled entirely in
  // embed mode - for EVERY pointer type, not just touch - rather than
  // gated inside device.ts's makeDraggable, so the dev UI keeps its exact
  // prior behaviour byte for byte. The embed's own accelerometer
  // simulation (motion.ts's DragMotion, constructed above, fine-pointer
  // only, listening on the whole stage) is unaffected either way - this is
  // purely about not registering the free-drag listener at all when
  // embedded.
  if (!EMBED) {
    makeDraggable(bezelEl, deviceWrapEl, onPuckDrag);
    bezelEl.title = "drag to move; shake it back and forth to trigger the shake sensor";
  }
  wirePanelInput();
  connectLiveReload();
  wireTraceFile();

  // AudioContext creation (and resuming a suspended one) must happen
  // inside a real user gesture, per the browser's autoplay policy. Every
  // pointerdown/keydown anywhere on the page qualifies; ensureContext() is
  // idempotent, so wiring it broadly rather than guessing "the first
  // click" is the simplest thing that is still always correct.
  const unlockAudio = () => soundPlayer.ensureContext((text) => consoleLog.push(text));
  document.addEventListener("pointerdown", unlockAudio);
  document.addEventListener("keydown", unlockAudio);

  $<HTMLButtonElement>("#btnMute").addEventListener("click", (e) => {
    const muted = soundPlayer.toggleMute();
    (e.currentTarget as HTMLElement).classList.toggle("active", muted);
    (e.currentTarget as HTMLElement).title = muted ? "sound muted, click to unmute" : "mute";
  });

  $<HTMLInputElement>("#overlayOn").addEventListener("change", (e) => {
    overlayEnabled = (e.target as HTMLInputElement).checked;
    if (!overlayEnabled) overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);
  });
  $<HTMLInputElement>("#pushesOn").addEventListener("change", (e) => {
    pushOverlay.enabled = (e.target as HTMLInputElement).checked;
    if (!pushOverlay.enabled) overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);
  });

  $("#rotQuick")
    .querySelectorAll<HTMLButtonElement>("button")
    .forEach((b) => {
      b.addEventListener("click", () => setQuickRotation(Number(b.dataset.deg)));
    });
  $<HTMLInputElement>("#tilt").addEventListener("input", (e) => {
    tiltDeg = Number((e.target as HTMLInputElement).value);
    applyRotation(bezelEl, quickDeg + tiltDeg, puckMotion.offsetX, puckMotion.offsetY);
  });
  // The "active" class on one #rotQuick button is just markup matching
  // quickDeg's actual default above; nothing paints the rotation from CSS
  // alone, so without this call the puck would sit at visual 0deg until
  // the first frame runs (harmless here since the default IS 0deg, but
  // kept so a future default change doesn't silently desync the button).
  applyRotation(bezelEl, quickDeg + tiltDeg);

  btnPause.addEventListener("click", () => {
    paused = !paused;
    btnPause.textContent = paused ? "resume" : "pause";
  });
  $<HTMLButtonElement>("#btnStep").addEventListener("click", () => {
    if (!deadState) stepOnce(); // dead: stepping would just re-enter a module that already crashed
  });
  btnStopReplay.addEventListener("click", stopReplay);

  $<HTMLButtonElement>("#btnPng").addEventListener("click", () => {
    panelEl.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `panel-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  });

  $<HTMLButtonElement>("#btnFreeze").addEventListener("click", () => {
    void runFreeze();
  });
  $<HTMLButtonElement>("#btnSaveTrace").addEventListener("click", () => {
    void saveTraceToServer();
  });
  $<HTMLButtonElement>("#btnSaveBaseline").addEventListener("click", () => {
    void saveBaselineToServer();
  });
  $<HTMLButtonElement>("#btnCheckBaseline").addEventListener("click", () => {
    void checkBaseline();
  });

  $<HTMLInputElement>("#touchDefectsOn").addEventListener("change", (e) => {
    touchDefectsEnabled = (e.target as HTMLInputElement).checked;
  });
  buildTouchControls();

  $<HTMLButtonElement>("#btnResetTouch").addEventListener("click", () => {
    Object.assign(touchCfg, TOUCHSIM_DEFAULTS);
    touchDefectsEnabled = TOUCH_DEFECTS_DEFAULT;
    $<HTMLInputElement>("#touchDefectsOn").checked = touchDefectsEnabled;
    buildTouchControls();
  });

  $<HTMLButtonElement>("#btnQuit").addEventListener("click", () => {
    void (async () => {
      await fetch("/api/quit", { method: "POST", headers: { "x-puck-emulator": "1" } });
      document.body.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font:14px monospace;color:#888">emulator stopped. you can close this window.</div>';
    })();
  });
}

// ---- boot ----
async function boot(): Promise<void> {
  accentColor = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || accentColor;
  wireStaticUI();
  await reloadModule("initial load");
  requestAnimationFrame(frame);
}

// Exposed for headless verification (scripts/verify.ts and ad hoc checks).
// Not used by the UI itself.
(window as unknown as { __debug: unknown }).__debug = {
  reloadModule,
  getEmu: () => emu,
  getDevice: () => device,
  getRecorder: () => recorder,
  // Re-renders the gestures panel from the current `device` object. Lets an
  // ad hoc check mutate getDevice().gestures (e.g. attach a script to a
  // gesture the loaded firmware did not declare one for) and see the
  // "perform" button/honest-degrade text update without a real firmware
  // rebuild.
  rebuildGestures: () => device && buildGestures(device),
  // Re-derives the WHOLE chrome (buttons, sensor controls, the embed shake
  // button's own visibility, ...) from the current device object, the same
  // "mutate getDevice()'s reference then re-derive" trick rebuildGestures
  // above already uses, generalised past just the gestures panel. Exists
  // for scripts/verify-embed.ts's negative case (the embed shake button
  // must stay hidden for a device with no declared "shake" event sensor):
  // every device pack and the example firmware in this repo declare one
  // unconditionally today, so there is no real "no shake" module to load
  // via ?module= for that proof, and this reaches the same code path
  // (buildChrome) a real reload against such a module would.
  rebuildChrome: () => device && buildChrome(device),
  getSoundPlayer: () => soundPlayer,
  getPhoneMotion: () => phoneMotion,
  // Engine-death state (see enterDeadState): exposed so the hostile-firmware
  // regression suite (test/hostile-firmware/) can assert on it directly
  // rather than only scraping banner text.
  getDeadState: () => deadState,
  getTickCount: () => tickCount,
};

void boot();
