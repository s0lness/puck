// harness/links/devlinkProtocol.ts
class BoardResetError extends Error {
  constructor(message) {
    super(message);
    this.name = "BoardResetError";
  }
}

class ShotTruncatedError extends Error {
  headerBytes;
  decodedBytes;
  constructor(headerBytes, decodedBytes) {
    super(`SHOT truncated: header promised ${headerBytes} RLE bytes, ${decodedBytes} arrived. The firmware caps one reply at ` + `DEVLINK_SHOT_BUDGET_US (750ms) and drops the rest of the body rather than starving the watchdog, so this means the ` + `screen being captured does not RLE-compress small enough to leave the board inside that budget at this baud rate. ` + `See docs/harness.md's pacing section.`);
    this.name = "ShotTruncatedError";
    this.headerBytes = headerBytes;
    this.decodedBytes = decodedBytes;
  }
}

class DevlinkTimeoutError extends Error {
  constructor(what, timeoutMs, where) {
    super(`no ${what} within ${timeoutMs}ms on ${where}`);
    this.name = "DevlinkTimeoutError";
  }
}

class DevlinkClosedError extends Error {
  constructor(what, where) {
    super(`the devlink transport closed while waiting for ${what} on ${where}. The port was released under the run ` + `(board unplugged, bridge process exited, or something else took the port), so nothing captured after this ` + `point exists to compare.`);
    this.name = "DevlinkClosedError";
  }
}
var BASE64_LINE_RE = /^[A-Za-z0-9+/]*={0,2}$/;
function isBase64Line(line) {
  return line.length > 0 && line.length % 4 === 0 && BASE64_LINE_RE.test(line);
}
function decodeRLE(rle, w, h) {
  const out = new Uint8Array(w * h);
  let o = 0;
  for (let i = 0;i + 1 < rle.length; i += 2) {
    const value = rle[i];
    const count = rle[i + 1];
    for (let k = 0;k < count && o < out.length; k++)
      out[o++] = value;
  }
  if (o !== out.length) {
    throw new Error(`RLE decoded ${o} pixels, expected ${w * h} (${w}x${h}); payload is corrupt or truncated`);
  }
  return out;
}
var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var B64_REVERSE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0;i < B64_ALPHABET.length; i++)
    table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();
function decodeBase64(text) {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61)
    end--;
  const out = new Uint8Array(Math.floor(end * 6 / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0;i < end; i++) {
    const code = text.charCodeAt(i);
    const v = code < 128 ? B64_REVERSE[code] : -1;
    if (v < 0)
      throw new Error(`base64 payload contains a character outside the alphabet at offset ${i}`);
    acc = acc << 6 | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = acc >> bits & 255;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}
function greyToRGB(grey, width, height) {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, p = 0;i < width * height; i++, p += 3) {
    const v = grey[i];
    const g6 = v >> 2;
    const c5 = v >> 3;
    const g8 = g6 << 2 | g6 >> 4;
    const rb8 = c5 << 3 | c5 >> 2;
    rgb[p] = rb8;
    rgb[p + 1] = g8;
    rgb[p + 2] = rb8;
  }
  return { width, height, rgb };
}
function commandsForEvent(event, fingerDown) {
  switch (event.k) {
    case "touch": {
      if (event.down) {
        return { commands: [fingerDown ? `MOVE ${event.x} ${event.y}` : `DOWN ${event.x} ${event.y}`], fingerDown: true };
      }
      return { commands: ["UP"], fingerDown: false };
    }
    case "button":
      if (event.i === 0)
        return { commands: [event.down ? "BOOT DOWN" : "BOOT UP"], fingerDown };
      if (event.i === 1)
        return { commands: [event.down ? "KEY PRESS" : "KEY RELEASE"], fingerDown };
      throw new Error(`no devlink command for button index ${event.i} (this device declares 0 = BOOT, 1 = PWR)`);
    case "verdict":
      if (event.i === 1)
        return { commands: [event.long ? "KEY LONG" : "KEY SHORT"], fingerDown };
      throw new Error(`no devlink command for a press verdict on button index ${event.i} (only PWR, index 1, declares longPressMs)`);
    case "sensor":
      if (event.i === 0)
        return { commands: ["ERASE"], fingerDown };
      throw new Error(`no devlink command for sensor index ${event.i} (this device declares exactly one, 0 = shake)`);
    case "vector":
      throw new Error(`no devlink command for a vector sensor event (index ${event.i}): real-hardware tilt injection is not wired`);
    case "accel":
      throw new Error(`no devlink command for a raw accel sample (index ${event.i}): real-hardware accel injection is not wired`);
    case "tick":
      return { commands: [], fingerDown };
  }
}
var PROF_APP_RE = /^prof app=(\S+)\b/;
var PROF_CUMULATIVE = {
  core1restarts: /\bcore1restarts=(\d+)\b/,
  "shot drops": /\bshot drops=(\d+)\b/,
  uptime: /\buptime=(\d+)\b/
};
function parseProf(line) {
  const m = PROF_APP_RE.exec(line);
  if (!m)
    return null;
  const counters = {};
  for (const [name, re] of Object.entries(PROF_CUMULATIVE)) {
    const f = re.exec(line);
    if (f)
      counters[name] = Number(f[1]);
  }
  return { app: m[1], counters };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
var DEFAULT_SHOT_MIN_MS = 250;
var DEVLINK_DEFAULTS = {
  appIndex: 0,
  minShotIntervalMs: DEFAULT_SHOT_MIN_MS,
  restoreApp: true,
  appTracking: "strict"
};

class DevlinkSession {
  opts;
  transport;
  panelW = 0;
  panelH = 0;
  appOnConnect = null;
  expectedApp = null;
  fingerDown = false;
  lastShotEndedAt = 0;
  lastProf = null;
  resetEvidence = [];
  appTransitions = [];
  shots = [];
  constructor(transport, opts = {}) {
    this.transport = transport;
    this.opts = { ...DEVLINK_DEFAULTS, ...opts };
  }
  get panel() {
    return { w: this.panelW, h: this.panelH };
  }
  get where() {
    return this.transport.description;
  }
  get appAtHandshake() {
    return this.appOnConnect;
  }
  async handshake() {
    const ping = await this.expect(/^(OK devlink \d+ \d+ \d+|ERR .*)$/, 3000, "PING reply", "PING");
    const m = /^OK devlink (\d+) (\d+) (\d+)$/.exec(ping);
    if (!m)
      throw new Error(`devlink refused PING: ${ping}`);
    this.panelW = Number(m[2]);
    this.panelH = Number(m[3]);
    this.appOnConnect = await this.readApp();
    this.expectedApp = this.appOnConnect;
  }
  async reset() {
    const target = this.opts.appIndex;
    await this.expect(/^(OK|ERR .*)$/, 3000, "SWITCH reply", `SWITCH ${target}`, (line) => {
      if (line.startsWith("ERR")) {
        throw new Error(`SWITCH ${target} was refused (${line}). Valid indices are g_apps[] positions on the RUNNING firmware.`);
      }
    });
    const deadline = Date.now() + 2000;
    for (;; ) {
      const app = await this.readApp();
      if (app.index === target) {
        this.expectedApp = app;
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`the board did not enter app ${target} within 2s (still reporting ${app.index} ${app.name})`);
      }
      await sleep(50);
    }
    await sleep(200);
  }
  async sendEvent(event) {
    const mapped = commandsForEvent(event, this.fingerDown);
    this.fingerDown = mapped.fingerDown;
    for (const cmd of mapped.commands) {
      await this.expect(/^(OK|ERR .*)$/, 3000, `${cmd.split(" ")[0]} reply`, cmd, (line) => {
        if (line.startsWith("ERR"))
          throw new Error(`devlink refused "${cmd}": ${line}`);
      });
    }
  }
  async screenshot() {
    const raw = await this.captureRaw();
    if (!raw.grey)
      throw new ShotTruncatedError(raw.headerBytes, raw.decodedBytes);
    await this.assertStillTheSameBoard();
    return greyToRGB(raw.grey, raw.width, raw.height);
  }
  async captureRaw() {
    const wait = this.lastShotEndedAt + this.opts.minShotIntervalMs - Date.now();
    if (wait > 0)
      await sleep(wait);
    const started = Date.now();
    const header = await this.expect(/^(SHOT \d+ \d+ \d+|ERR .*)$/, 8000, "SHOT header", "SHOT");
    const m = /^SHOT (\d+) (\d+) (\d+)$/.exec(header);
    if (!m)
      throw new Error(`devlink refused SHOT: ${header}`);
    const width = Number(m[1]);
    const height = Number(m[2]);
    const headerBytes = Number(m[3]);
    let b64 = "";
    for (;; ) {
      const line = await this.readLine(8000, "SHOT body");
      if (line === "END")
        break;
      if (!isBase64Line(line)) {
        this.observeNoise(line);
        continue;
      }
      b64 += line;
    }
    const rle = decodeBase64(b64);
    const ms = Date.now() - started;
    this.lastShotEndedAt = Date.now();
    const truncated = rle.length !== headerBytes;
    let grey = null;
    if (!truncated) {
      try {
        grey = decodeRLE(rle, width, height);
      } catch {
        grey = null;
      }
    }
    const shot = { width, height, headerBytes, decodedBytes: rle.length, truncated: grey === null, grey, ms };
    this.shots.push(shot);
    return shot;
  }
  async readApp() {
    const reply = await this.expect(/^(APP -?\d+ \S+|ERR .*)$/, 3000, "APP reply", "APP");
    const m = /^APP (-?\d+) (\S+)$/.exec(reply);
    if (!m)
      throw new Error(`devlink refused APP: ${reply}`);
    return { index: Number(m[1]), name: m[2] };
  }
  async park() {
    await this.tryCommand("KEY RELEASE");
    await this.tryCommand("BOOT UP");
    if (this.fingerDown) {
      await this.tryCommand("UP");
      this.fingerDown = false;
    }
    if (this.opts.restoreApp && this.appOnConnect && this.expectedApp && this.appOnConnect.index !== this.expectedApp.index) {
      if (this.appOnConnect.index >= 0)
        await this.tryCommand(`SWITCH ${this.appOnConnect.index}`);
    }
  }
  observeNoise(line) {
    const prof = parseProf(line);
    if (!prof)
      return;
    const prev = this.lastProf;
    if (prev) {
      for (const [name, value] of Object.entries(prof.counters)) {
        const before = prev.counters[name];
        if (before === undefined)
          continue;
        if (value < before) {
          this.resetEvidence.push(`the profiler's cumulative "${name}" went backwards (${before} -> ${value}): the board rebooted`);
        }
        if (name === "shot drops" && value > before) {
          this.resetEvidence.push(`the firmware dropped a SHOT body (shot drops ${before} -> ${value}): a screenshot ran past the firmware's ` + `own reply budget, so screenshots are being asked for faster or on a busier screen than this board can serve`);
        }
      }
    }
    if (this.opts.appTracking === "strict" && this.expectedApp && prof.app !== this.expectedApp.name) {
      this.resetEvidence.push(`the profiler reports app=${prof.app} while this run put the board in "${this.expectedApp.name}": ` + `the board reset (a reset re-enters app 0) or something else switched apps under the run`);
    }
    this.lastProf = prof;
  }
  async assertStillTheSameBoard() {
    const app = await this.readApp();
    const was = this.expectedApp;
    const changed = was !== null && (app.index !== was.index || app.name !== was.name);
    if (changed && this.opts.appTracking === "follow") {
      this.appTransitions.push(`${was.index} "${was.name}" -> ${app.index} "${app.name}"`);
      this.expectedApp = app;
      return;
    }
    if (changed) {
      throw new BoardResetError(`the board is now running app ${app.index} "${app.name}", but this run put it in ${was.index} ` + `"${was.name}". A reset re-enters app 0 with a zeroed arena, so every frame from here on would be a ` + `comparison against a different device state. Aborting instead of reporting a divergence.`);
    }
    if (this.resetEvidence.length > 0) {
      throw new BoardResetError(`the board did not stay put during this run:
  - ${this.resetEvidence.join(`
  - `)}`);
    }
  }
  async readLine(timeoutMs, what) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DevlinkTimeoutError(what, timeoutMs, this.where)), timeoutMs);
    });
    try {
      const line = await Promise.race([this.transport.readLine(), timeout]);
      if (line === null)
        throw new DevlinkClosedError(what, this.where);
      return line;
    } finally {
      clearTimeout(timer);
    }
  }
  async expect(shape, timeoutMs, what, cmd, onReply) {
    if (cmd)
      await this.transport.send(cmd);
    const deadline = Date.now() + timeoutMs;
    for (;; ) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new DevlinkTimeoutError(what, timeoutMs, this.where);
      const line = await this.readLine(remaining, what);
      if (shape.test(line)) {
        onReply?.(line);
        return line;
      }
      this.observeNoise(line);
    }
  }
  async tryCommand(cmd) {
    try {
      await this.expect(/^(OK|ERR .*)$/, 2000, `${cmd} reply`, cmd);
    } catch {}
  }
}

// harness/links/webSerialLink.ts
var DEFAULT_BAUD_RATE = 115200;
class LineQueue {
  queue = [];
  waiters = [];
  done = false;
  push(line) {
    const waiter = this.waiters.shift();
    if (waiter)
      waiter(line);
    else
      this.queue.push(line);
  }
  finish() {
    this.done = true;
    while (this.waiters.length)
      this.waiters.shift()(null);
  }
  readLine() {
    if (this.queue.length > 0)
      return Promise.resolve(this.queue.shift());
    if (this.done)
      return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

class WebSerialLink {
  opts;
  port = null;
  reader = null;
  writer = null;
  session = null;
  lines = new LineQueue;
  released = false;
  opened = false;
  constructor(opts = {}) {
    this.opts = opts;
  }
  get description() {
    const info = this.port?.getInfo?.();
    if (info && info.usbVendorId !== undefined) {
      const vid = info.usbVendorId.toString(16).padStart(4, "0");
      const pid = (info.usbProductId ?? 0).toString(16).padStart(4, "0");
      return `the serial port at USB ${vid}:${pid}, over Web Serial`;
    }
    return "the serial port picked in this browser, over Web Serial";
  }
  get panel() {
    return this.session?.panel ?? { w: 0, h: 0 };
  }
  get resetEvidence() {
    return this.session?.resetEvidence ?? [];
  }
  get appTransitions() {
    return this.session?.appTransitions ?? [];
  }
  get shots() {
    return this.session?.shots ?? [];
  }
  async connect() {
    const serial = this.opts.serial ?? (typeof navigator !== "undefined" ? navigator.serial : undefined);
    if (!this.opts.port && !serial) {
      throw new Error("Web Serial isn't available in this browser. Use Chrome or Edge on desktop.");
    }
    if (this.opts.port) {
      this.port = this.opts.port;
    } else {
      try {
        this.port = await serial.requestPort({ filters: this.opts.filters ?? [] });
      } catch (err) {
        throw new Error(`no serial port was selected, so there is no board to run the trace on. Plug the board in, then pick its ` + `port in the browser's list. (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    this.released = false;
    try {
      if (!this.port.readable || !this.port.writable) {
        await this.port.open({ baudRate: this.opts.baudRate ?? DEFAULT_BAUD_RATE });
        this.opened = true;
      }
      await this.port.setSignals({
        dataTerminalReady: this.opts.dataTerminalReady ?? true,
        requestToSend: false
      });
      if (!this.port.readable || !this.port.writable) {
        throw new Error("the serial port opened but exposes no readable/writable stream, so nothing can be sent to the board");
      }
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.pump();
      this.session = new DevlinkSession(this.transport(), this.opts);
      await this.session.handshake();
    } catch (err) {
      await this.release();
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`no board answered devlink on ${this.description}: ${msg}. Either this is not the board's devlink port, or its ` + `firmware does not speak devlink, or the DTR signal is wrong for this board (the RP2350 needs it asserted, ` + `the ESP32-S3 is rebooted by it).`);
    }
  }
  async disconnect() {
    try {
      if (this.session)
        await this.session.park();
    } catch {}
    await this.release();
  }
  async reset() {
    await this.requireSession().reset();
  }
  async send(event) {
    await this.requireSession().sendEvent(event);
  }
  async screenshot() {
    return this.requireSession().screenshot();
  }
  async readApp() {
    return this.requireSession().readApp();
  }
  async release() {
    if (this.released)
      return;
    this.released = true;
    this.session = null;
    const reader = this.reader;
    this.reader = null;
    if (reader) {
      try {
        await reader.cancel();
      } catch {}
      try {
        reader.releaseLock();
      } catch {}
    }
    const writer = this.writer;
    this.writer = null;
    if (writer) {
      try {
        await writer.close();
      } catch {}
      try {
        writer.releaseLock();
      } catch {}
    }
    this.lines.finish();
    const port = this.port;
    this.port = null;
    if (port && this.opened) {
      try {
        await port.close();
      } catch {}
    }
    this.opened = false;
  }
  transport() {
    return {
      description: this.description,
      readLine: () => this.lines.readLine(),
      send: async (cmd) => {
        const writer = this.writer;
        if (!writer)
          throw new Error("the serial port was released before this command could be sent");
        await writer.write(new TextEncoder().encode(cmd + `
`));
      },
      close: () => this.release()
    };
  }
  pump() {
    const reader = this.reader;
    if (!reader)
      return;
    const decoder = new TextDecoder;
    let buf = "";
    (async () => {
      try {
        for (;; ) {
          const { value, done } = await reader.read();
          if (done)
            break;
          if (value)
            buf += decoder.decode(value, { stream: true });
          for (;; ) {
            const nl = buf.indexOf(`
`);
            if (nl < 0)
              break;
            let line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.endsWith("\r"))
              line = line.slice(0, -1);
            this.lines.push(line);
          }
        }
      } catch {} finally {
        if (buf.length > 0)
          this.lines.push(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
        this.lines.finish();
      }
    })();
  }
  requireSession() {
    if (!this.session)
      throw new Error("web serial devlink link used before connect(), or after it was released");
    return this.session;
  }
}

// site/flasher/flash-ui-common.ts
function onSections(selector, init) {
  function go() {
    const sections = document.querySelectorAll(selector);
    for (let i = 0;i < sections.length; i++)
      init(sections[i]);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", go);
  } else {
    go();
  }
}

// site/attest-client.ts
function attestationKey(app, pack) {
  return `${app}:${pack}`;
}
async function fetchAttestations(endpoint = "/api/attest") {
  let resp;
  try {
    resp = await fetch(endpoint, { headers: { accept: "application/json" } });
  } catch {
    return null;
  }
  if (!resp.ok)
    return null;
  let body;
  try {
    body = await resp.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || !("counts" in body))
    return null;
  const counts = body.counts;
  if (!counts || typeof counts !== "object")
    return null;
  const out = {};
  for (const [key, value] of Object.entries(counts)) {
    if (!value || typeof value !== "object")
      continue;
    const v = value;
    if (typeof v.confirmations !== "number")
      continue;
    out[key] = {
      app: typeof v.app === "string" ? v.app : key.split(":")[0],
      pack: typeof v.pack === "string" ? v.pack : key.split(":").slice(1).join(":"),
      confirmations: v.confirmations,
      lastConfirmedAt: typeof v.lastConfirmedAt === "string" ? v.lastConfirmedAt : null,
      diverged: typeof v.diverged === "number" ? v.diverged : 0
    };
  }
  return { counts: out };
}
var ATTEST_EMPTY_STATE = "no board has confirmed this yet";
function daysBetween(fromISO, now) {
  const then = Date.parse(`${fromISO}T00:00:00Z`);
  if (Number.isNaN(then))
    return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((today - then) / 86400000));
}
function describeAge(lastConfirmedAt, now = new Date) {
  if (!lastConfirmedAt)
    return "";
  const days = daysBetween(lastConfirmedAt, now);
  if (days === null)
    return "";
  if (days === 0)
    return "last confirmed today";
  if (days === 1)
    return "last confirmed yesterday";
  return `last confirmed ${days} days ago`;
}
function describeAttestation(count) {
  if (!count || count.confirmations === 0)
    return ATTEST_EMPTY_STATE;
  const runs = count.confirmations === 1 ? "1 confirmation" : `${count.confirmations} confirmations`;
  const age = describeAge(count.lastConfirmedAt);
  return age ? `${runs} · ${age}` : runs;
}
async function paintAttestCounters(root = document, endpoint = "/api/attest") {
  const nodes = Array.from(root.querySelectorAll("[data-attest-app][data-attest-pack]"));
  if (nodes.length === 0)
    return;
  const index = await fetchAttestations(endpoint);
  for (const node of nodes) {
    const app = node.dataset.attestApp;
    const pack = node.dataset.attestPack;
    const count = index?.counts[attestationKey(app, pack)];
    node.textContent = describeAttestation(count);
    node.classList.toggle("attest-counter-empty", !count || count.confirmations === 0);
  }
}

// harness/hardwareSide.ts
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
async function replayHardware(link, events, capturePoints) {
  await link.connect();
  try {
    if (link.reset)
      await link.reset();
    const sortedPoints = [...capturePoints].sort((a, b) => a - b);
    const frames = [];
    if (events.length === 0) {
      for (const p of sortedPoints)
        frames.push({ atMs: p, frame: await link.screenshot() });
      return { frames };
    }
    const wallStart = Date.now();
    const traceStart = events[0].t;
    let capIdx = 0;
    for (const ev of events) {
      const targetWall = wallStart + (ev.t - traceStart);
      await sleep2(targetWall - Date.now());
      if (ev.k !== "tick")
        await link.send(ev);
      while (capIdx < sortedPoints.length && sortedPoints[capIdx] <= ev.t) {
        frames.push({ atMs: sortedPoints[capIdx], frame: await link.screenshot() });
        capIdx++;
      }
    }
    while (capIdx < sortedPoints.length) {
      const targetWall = wallStart + (sortedPoints[capIdx] - traceStart);
      await sleep2(targetWall - Date.now());
      frames.push({ atMs: sortedPoints[capIdx], frame: await link.screenshot() });
      capIdx++;
    }
    return { frames };
  } finally {
    await link.disconnect();
  }
}

// src/compare.ts
function compareFrames(a, b, tolerance) {
  if (a.width !== b.width || a.height !== b.height) {
    return { match: false, diffPixels: -1, totalPixels: a.width * a.height, firstDiffAt: null, maxChannelDelta: 255, diffImage: null };
  }
  const expectedLength = a.width * a.height * 3;
  if (a.rgb.length !== expectedLength || b.rgb.length !== expectedLength) {
    return { match: false, diffPixels: -1, totalPixels: a.width * a.height, firstDiffAt: null, maxChannelDelta: 255, diffImage: null };
  }
  const { width: w, height: h } = a;
  let diffPixels = 0;
  let firstDiffAt = null;
  let maxChannelDelta = 0;
  const diffRgb = new Uint8Array(w * h * 3);
  for (let i = 0, p = 0;i < w * h; i++, p += 3) {
    const dr = Math.abs(a.rgb[p] - b.rgb[p]);
    const dg = Math.abs(a.rgb[p + 1] - b.rgb[p + 1]);
    const db = Math.abs(a.rgb[p + 2] - b.rgb[p + 2]);
    const maxD = Math.max(dr, dg, db);
    if (maxD > tolerance) {
      diffPixels++;
      if (!firstDiffAt)
        firstDiffAt = { x: i % w, y: Math.floor(i / w) };
      if (maxD > maxChannelDelta)
        maxChannelDelta = maxD;
      diffRgb[p] = 255;
      diffRgb[p + 1] = 0;
      diffRgb[p + 2] = 0;
    } else {
      diffRgb[p] = a.rgb[p];
      diffRgb[p + 1] = a.rgb[p + 1];
      diffRgb[p + 2] = a.rgb[p + 2];
    }
  }
  return { match: diffPixels === 0, diffPixels, totalPixels: w * h, firstDiffAt, maxChannelDelta, diffImage: diffPixels > 0 ? diffRgb : null };
}

// harness/png.ts
function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
function u32beAt(buf, offset) {
  return (buf[offset] << 24 | buf[offset + 1] << 16 | buf[offset + 2] << 8 | buf[offset + 3]) >>> 0;
}
var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
function parseRGBPNG(bytes) {
  for (let i = 0;i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i])
      throw new Error("decodeRGBPNG: not a PNG file (bad signature)");
  }
  let width = -1;
  let height = -1;
  let bitDepth = -1;
  let colorType = -1;
  const idatParts = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < bytes.length) {
    const length = u32beAt(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const data = bytes.subarray(dataStart, dataStart + length);
    if (type === "IHDR") {
      width = u32beAt(data, 0);
      height = u32beAt(data, 4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4;
  }
  if (width < 0 || height < 0)
    throw new Error("decodeRGBPNG: no IHDR chunk found");
  if (bitDepth !== 8 || colorType !== 2) {
    throw new Error(`decodeRGBPNG: only 8-bit RGB (colour type 2) is supported, got bit depth ${bitDepth}, colour type ${colorType}`);
  }
  if (idatParts.length === 0)
    throw new Error("decodeRGBPNG: no IDAT chunk found");
  const zlibStream = idatParts.length === 1 ? idatParts[0] : concat(idatParts);
  return { width, height, deflated: new Uint8Array(zlibStream.subarray(2, zlibStream.length - 4)) };
}
function unfilterRGBScanlines(raw, width, height) {
  const stride = width * 3;
  const expectedRawLength = (stride + 1) * height;
  if (raw.length !== expectedRawLength) {
    throw new Error(`decodeRGBPNG: decompressed size ${raw.length} does not match the expected ${expectedRawLength} for ${width}x${height} RGB`);
  }
  const rgb = new Uint8Array(stride * height);
  for (let y = 0;y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    if (filterType !== 0) {
      throw new Error(`decodeRGBPNG: scanline ${y} uses filter type ${filterType}, only filter type 0 (None) is supported`);
    }
    rgb.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  }
  return rgb;
}

// site/attest/pngFrame.ts
async function inflateRaw(deflated) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("this browser has no DecompressionStream, so a recorded reference frame cannot be read back");
  }
  const stream = new Blob([deflated]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function decodeFramePNG(bytes) {
  const { width, height, deflated } = parseRGBPNG(bytes);
  const raw = await inflateRaw(deflated);
  return { width, height, rgb: unfilterRGBScanlines(raw, width, height) };
}
async function fetchFramePNG(url) {
  const resp = await fetch(url);
  if (!resp.ok)
    throw new Error(`could not fetch the recorded reference frame ${url}: HTTP ${resp.status}`);
  return decodeFramePNG(new Uint8Array(await resp.arrayBuffer()));
}

// site/attest/run.ts
function persistentLink(link) {
  const facade = {
    connect: async () => {},
    disconnect: async () => {},
    send: (event) => link.send(event),
    screenshot: () => link.screenshot()
  };
  if (link.reset)
    facade.reset = () => link.reset();
  return facade;
}
async function runAttestation(opts) {
  const { plan, link } = opts;
  const report = opts.report ?? (() => {});
  const loadFrame = opts.loadFrame ?? fetchFramePNG;
  const totalPoints = plan.traces.reduce((n, t) => n + t.points.length, 0);
  if (totalPoints === 0) {
    throw new Error(`${plan.combo} has no recorded frames to compare against, so there is nothing to attest`);
  }
  const points = [];
  let donePoints = 0;
  report({ phase: "connecting", percent: 0, message: "Opening the board's devlink port…" });
  await link.connect();
  try {
    for (const trace of plan.traces) {
      report({
        phase: "replaying",
        percent: Math.round(donePoints / totalPoints * 100),
        message: `Replaying ${trace.name} on the board (${trace.events.length} events)…`
      });
      const capturePoints = trace.points.map((p) => p.atMs);
      const replay = await replayHardware(persistentLink(link), trace.events, capturePoints);
      for (const captured of replay.frames) {
        const point = trace.points.find((p) => p.atMs === captured.atMs);
        if (!point)
          continue;
        report({
          phase: "comparing",
          percent: Math.round(donePoints / totalPoints * 100),
          message: `Comparing ${trace.name} at ${captured.atMs}ms against the recorded frame…`
        });
        const expected = await loadFrame(`${plan.framesBase}${point.frame}`);
        const diff = compareFrames(captured.frame, expected, plan.tolerance);
        points.push({
          trace: trace.name,
          atMs: captured.atMs,
          match: diff.match,
          diffPixels: diff.diffPixels,
          totalPixels: diff.totalPixels
        });
        donePoints++;
      }
    }
  } finally {
    await link.disconnect();
  }
  const verdict = points.length > 0 && points.every((p) => p.match) ? "match" : "diverge";
  report({
    phase: "done",
    percent: 100,
    message: verdict === "match" ? `${points.length}/${points.length} frames matched, pixel for pixel.` : `${points.filter((p) => !p.match).length}/${points.length} frames diverged.`
  });
  return { verdict, points };
}
async function sha256Hex(bytes) {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("this browser exposes no crypto.subtle, so the firmware artifact cannot be identified by its own hash");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// site/attest/attest-ui.ts
var ATTEST_ENDPOINT = "/api/attest";
function el(section, selector) {
  return section.querySelector(selector);
}
function show(node, text) {
  if (!node)
    return;
  if (text !== undefined)
    node.textContent = text;
  node.hidden = false;
}
function hide(node) {
  if (node)
    node.hidden = true;
}
function renderPoints(list, result) {
  list.textContent = "";
  for (const point of result.points) {
    const li = document.createElement("li");
    li.className = point.match ? "attest-point attest-point-match" : "attest-point attest-point-diverge";
    const mark = document.createElement("span");
    mark.className = "attest-point-mark";
    mark.textContent = point.match ? "MATCH" : "DIVERGE";
    const label = document.createElement("span");
    label.className = "attest-point-label";
    label.textContent = `${point.trace} at ${point.atMs}ms`;
    const detail = document.createElement("span");
    detail.className = "attest-point-detail";
    detail.textContent = point.match ? `${point.totalPixels} pixels identical` : `${point.diffPixels}/${point.totalPixels} pixels differ`;
    li.append(mark, label, detail);
    list.appendChild(li);
  }
  list.hidden = false;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
async function loadPlan(url) {
  const resp = await fetch(url);
  if (!resp.ok)
    throw new Error(`could not load this port's attestation plan (${url}): HTTP ${resp.status}`);
  return await resp.json();
}
async function fetchArtifactSha(planUrl, artifact) {
  const url = new URL(artifact, new URL(planUrl, window.location.href)).href;
  const resp = await fetch(url);
  if (!resp.ok)
    throw new Error(`could not fetch the firmware artifact ${artifact} to identify it: HTTP ${resp.status}`);
  return sha256Hex(new Uint8Array(await resp.arrayBuffer()));
}
function resolveFramesBase(planUrl, framesBase) {
  return new URL(framesBase, new URL(planUrl, window.location.href)).href;
}
function wireAttestSection(section) {
  const planUrl = section.dataset.attestPlan;
  if (!planUrl)
    return;
  const runBtn = el(section, ".attest-btn");
  const statusEl = el(section, ".attest-status");
  const progressEl = el(section, ".attest-progress");
  const pointsEl = el(section, ".attest-points");
  const verdictEl = el(section, ".attest-verdict");
  const errorEl = el(section, ".attest-error");
  const postWrap = el(section, ".attest-post");
  const postBtn = el(section, ".attest-post-btn");
  const postedEl = el(section, ".attest-posted");
  if (!runBtn || !statusEl || !progressEl || !pointsEl || !verdictEl || !errorEl || !postWrap || !postBtn || !postedEl)
    return;
  let pending = null;
  async function attestOnce() {
    hide(errorEl);
    hide(verdictEl);
    hide(postWrap);
    hide(postedEl);
    pointsEl.hidden = true;
    pending = null;
    runBtn.disabled = true;
    show(progressEl);
    statusEl.textContent = "Loading this port's recorded frames…";
    try {
      if (!navigator.serial) {
        throw new Error("Web Serial isn't available in this browser, so a board can't be driven from this page. Use Chrome or Edge on desktop.");
      }
      const plan = await loadPlan(planUrl);
      const framesBase = resolveFramesBase(planUrl, plan.framesBase);
      const link = new WebSerialLink({
        dataTerminalReady: plan.dataTerminalReady,
        appIndex: plan.appIndex
      });
      const result = await runAttestation({
        plan: { ...plan, framesBase },
        link,
        report: (p) => {
          statusEl.textContent = p.message;
        }
      });
      renderPoints(pointsEl, result);
      const matched = result.points.filter((p) => p.match).length;
      verdictEl.className = result.verdict === "match" ? "attest-verdict attest-verdict-match" : "attest-verdict attest-verdict-diverge";
      show(verdictEl, result.verdict === "match" ? `✓ Runs on this board: ${matched}/${result.points.length} frames matched the recorded ones, pixel for pixel.` : `This board drew something else: ${result.points.length - matched}/${result.points.length} frames diverged. That is a result worth posting too.`);
      hide(progressEl);
      const portSha = await fetchArtifactSha(planUrl, plan.artifact);
      pending = {
        app: plan.app,
        pack: plan.pack,
        portSha,
        verdict: result.verdict,
        points: result.points,
        boardFamily: plan.boardFamily,
        date: todayISO()
      };
      show(postWrap);
    } catch (err) {
      hide(progressEl);
      show(errorEl, err instanceof Error ? err.message : String(err));
    } finally {
      runBtn.disabled = false;
    }
  }
  async function postOnce() {
    if (!pending)
      return;
    postBtn.disabled = true;
    hide(errorEl);
    try {
      const resp = await fetch(ATTEST_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pending)
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`the attestation was not accepted (HTTP ${resp.status}): ${text.slice(0, 200)}`);
      }
      show(postedEl, "Posted. This board's run now counts on the card.");
      hide(postWrap);
      await paintAttestCounters(document, ATTEST_ENDPOINT);
    } catch (err) {
      show(errorEl, err instanceof Error ? err.message : String(err));
    } finally {
      postBtn.disabled = false;
    }
  }
  runBtn.addEventListener("click", () => void attestOnce());
  postBtn.addEventListener("click", () => void postOnce());
}
onSections(".attest-section[data-attest-plan]", wireAttestSection);
paintAttestCounters(document, ATTEST_ENDPOINT);
