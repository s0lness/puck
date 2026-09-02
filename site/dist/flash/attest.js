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
  async pushStats() {
    const reply = await this.expect(/^(PUSHSTATS \d+ \d+|ERR .*)$/, 3000, "PUSHSTATS reply", "PUSHSTATS");
    const m = /^PUSHSTATS (\d+) (\d+)$/.exec(reply);
    if (!m)
      return null;
    return { pushes: Number(m[1]), pixels: Number(m[2]) };
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
  async pushStats() {
    return this.requireSession().pushStats();
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
var ATTESTATION_KINDS = ["pixel-exact", "invariants"];
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
    const rawKinds = v.kinds ?? {};
    const kinds = {};
    for (const kind of ATTESTATION_KINDS) {
      const entry = rawKinds[kind];
      kinds[kind] = {
        confirmations: typeof entry?.confirmations === "number" ? entry.confirmations : 0,
        diverged: typeof entry?.diverged === "number" ? entry.diverged : 0
      };
    }
    out[key] = {
      app: typeof v.app === "string" ? v.app : key.split(":")[0],
      pack: typeof v.pack === "string" ? v.pack : key.split(":").slice(1).join(":"),
      confirmations: v.confirmations,
      lastConfirmedAt: typeof v.lastConfirmedAt === "string" ? v.lastConfirmedAt : null,
      diverged: typeof v.diverged === "number" ? v.diverged : 0,
      kinds
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
  const kind = describeKinds(count);
  const age = describeAge(count.lastConfirmedAt);
  return [kind ? `${runs} (${kind})` : runs, age].filter(Boolean).join(" · ");
}
function describeKinds(count) {
  const seen = ATTESTATION_KINDS.filter((k) => count.kinds[k].confirmations > 0 || count.kinds[k].diverged > 0);
  if (seen.length < 2)
    return "";
  const confirmed = ATTESTATION_KINDS.filter((k) => count.kinds[k].confirmations > 0);
  return confirmed.join(" and ");
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
    let pushStatsSupported = typeof link.pushStats === "function";
    const pushWindows = [];
    async function captureFrame(atMs) {
      if (pushStatsSupported) {
        const stats = await link.pushStats();
        if (stats)
          pushWindows.push(stats);
        else
          pushStatsSupported = false;
      }
      frames.push({ atMs, frame: await link.screenshot() });
    }
    if (events.length === 0) {
      for (const p of sortedPoints)
        await captureFrame(p);
      return { frames, pushStats: summarisePushWindows(pushStatsSupported, pushWindows) };
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
        await captureFrame(sortedPoints[capIdx]);
        capIdx++;
      }
    }
    while (capIdx < sortedPoints.length) {
      const targetWall = wallStart + (sortedPoints[capIdx] - traceStart);
      await sleep2(targetWall - Date.now());
      await captureFrame(sortedPoints[capIdx]);
      capIdx++;
    }
    return { frames, pushStats: summarisePushWindows(pushStatsSupported, pushWindows) };
  } finally {
    await link.disconnect();
  }
}
function summarisePushWindows(supported, windows) {
  if (!supported || windows.length === 0)
    return;
  let maxPushesPerTick = 0;
  let maxPushPixelsPerTick = 0;
  let sumPushPixelsPerTick = 0;
  for (const w of windows) {
    if (w.pushes > maxPushesPerTick)
      maxPushesPerTick = w.pushes;
    if (w.pixels > maxPushPixelsPerTick)
      maxPushPixelsPerTick = w.pixels;
    sumPushPixelsPerTick += w.pixels;
  }
  return {
    tickCount: windows.length,
    maxPushesPerTick,
    maxPushPixelsPerTick,
    meanPushPixelsPerTick: sumPushPixelsPerTick / windows.length
  };
}

// src/compare.ts
function compareFrames(a, b, tolerance) {
  if (a.width !== b.width || a.height !== b.height) {
    return { match: false, diffPixels: -1, totalPixels: a.width * a.height, firstDiffAt: null, diffBox: null, maxChannelDelta: 255, diffImage: null };
  }
  const expectedLength = a.width * a.height * 3;
  if (a.rgb.length !== expectedLength || b.rgb.length !== expectedLength) {
    return { match: false, diffPixels: -1, totalPixels: a.width * a.height, firstDiffAt: null, diffBox: null, maxChannelDelta: 255, diffImage: null };
  }
  const { width: w, height: h } = a;
  let diffPixels = 0;
  let firstDiffAt = null;
  let maxChannelDelta = 0;
  let boxX0 = w, boxY0 = h, boxX1 = -1, boxY1 = -1;
  const diffRgb = new Uint8Array(w * h * 3);
  for (let i = 0, p = 0;i < w * h; i++, p += 3) {
    const dr = Math.abs(a.rgb[p] - b.rgb[p]);
    const dg = Math.abs(a.rgb[p + 1] - b.rgb[p + 1]);
    const db = Math.abs(a.rgb[p + 2] - b.rgb[p + 2]);
    const maxD = Math.max(dr, dg, db);
    if (maxD > tolerance) {
      diffPixels++;
      const x = i % w;
      const y = Math.floor(i / w);
      if (!firstDiffAt)
        firstDiffAt = { x, y };
      if (x < boxX0)
        boxX0 = x;
      if (x > boxX1)
        boxX1 = x;
      if (y < boxY0)
        boxY0 = y;
      if (y > boxY1)
        boxY1 = y;
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
  const diffBox = boxX1 >= 0 ? { x: boxX0, y: boxY0, w: boxX1 - boxX0 + 1, h: boxY1 - boxY0 + 1 } : null;
  return { match: diffPixels === 0, diffPixels, totalPixels: w * h, firstDiffAt, diffBox, maxChannelDelta, diffImage: diffPixels > 0 ? diffRgb : null };
}

// harness/invariantTypes.ts
function held(id, name, fails, passMessage) {
  return fails.length > 0 ? { id, name, status: "fail", message: fails.join("; ") } : { id, name, status: "pass", message: passMessage };
}
function summariseInvariants(outcomes) {
  const failures = outcomes.filter((o) => o.status === "fail").map((o) => o.message);
  return { pass: failures.length === 0, failures, invariants: outcomes };
}

// apps/fluidbox/invariants.ts
var BG_R = 0;
var BG_G = 0;
var BG_B = 0;
function isBackground(rgb, idx) {
  return rgb[idx] === BG_R && rgb[idx + 1] === BG_G && rgb[idx + 2] === BG_B;
}
function countNonBackground(frame) {
  const { width, height, rgb } = frame;
  let n = 0;
  for (let i = 0;i < width * height; i++) {
    if (!isBackground(rgb, i * 3))
      n++;
  }
  return n;
}
function topRowPerColumn(frame) {
  const { width, height, rgb } = frame;
  const top = new Array(width).fill(-1);
  for (let y = 0;y < height; y++) {
    for (let x = 0;x < width; x++) {
      if (top[x] !== -1)
        continue;
      if (!isBackground(rgb, (y * width + x) * 3))
        top[x] = y;
    }
  }
  return top;
}
var CORNER_MARGIN_PX = 57;
var FLATNESS_BINS = 10;
function bucketFlatness(frame) {
  const top = topRowPerColumn(frame);
  const lo = CORNER_MARGIN_PX, hi = frame.width - CORNER_MARGIN_PX;
  const binWidth = Math.floor((hi - lo) / FLATNESS_BINS);
  const medians = [];
  for (let b = 0;b < FLATNESS_BINS; b++) {
    const vals = [];
    for (let x = lo + b * binWidth;x < lo + (b + 1) * binWidth; x++) {
      if (top[x] !== -1)
        vals.push(top[x]);
    }
    if (vals.length === 0)
      continue;
    vals.sort((a, c) => a - c);
    medians.push(vals[Math.floor(vals.length / 2)]);
  }
  if (medians.length === 0)
    return Infinity;
  return Math.max(...medians) - Math.min(...medians);
}
function diffPixelCount(a, b) {
  let diff = 0;
  const n = Math.min(a.rgb.length, b.rgb.length);
  for (let i = 0;i < n; i += 3) {
    if (a.rgb[i] !== b.rgb[i] || a.rgb[i + 1] !== b.rgb[i + 1] || a.rgb[i + 2] !== b.rgb[i + 2])
      diff++;
  }
  return diff;
}
var MASS_DRIFT_MAX_PCT = 5;
var FLATNESS_MAX_SPREAD_PX = 40;
var SHAKE_DIFF_MIN_PX = 1500;
function borderIsClean(frame) {
  const { width, height, rgb } = frame;
  for (let x = 0;x < width; x++) {
    if (!isBackground(rgb, (0 * width + x) * 3))
      return false;
    if (!isBackground(rgb, ((height - 1) * width + x) * 3))
      return false;
  }
  for (let y = 0;y < height; y++) {
    if (!isBackground(rgb, (y * width + 0) * 3))
      return false;
    if (!isBackground(rgb, (y * width + (width - 1)) * 3))
      return false;
  }
  return true;
}
var PUSH_PIXELS_MAX = 90000;
var PUSH_COUNT_MAX = 4;
function check(frames, meta) {
  if (frames.length !== 3) {
    return summariseInvariants([
      {
        id: "capture-contract",
        name: "the trace's own three capture points arrived",
        status: "fail",
        message: `expected exactly 3 captures (settled1, afterShake, settled2) per this trace's own contract, got ${frames.length}`
      }
    ]);
  }
  const [settled1, afterShake, settled2] = frames;
  const outcomes = [];
  const mass1 = countNonBackground(settled1.frame);
  const mass2 = countNonBackground(settled2.frame);
  const massDriftPct = mass1 === 0 ? 100 : Math.abs(mass1 - mass2) / mass1 * 100;
  const massFails = [];
  if (mass1 === 0) {
    massFails.push(`mass proxy: settled1 (t=${settled1.atMs}) has zero non-background pixels - nothing rendered`);
  } else if (massDriftPct > MASS_DRIFT_MAX_PCT) {
    massFails.push(`mass proxy: non-background pixel count drifted ${massDriftPct.toFixed(2)}% between settled1 (${mass1}px) and settled2 (${mass2}px), max allowed ${MASS_DRIFT_MAX_PCT}%`);
  }
  outcomes.push(held("mass", "the same fluid is still there after the shake", massFails, `mass proxy: ${mass1}px non-background at settled1, ${mass2}px at settled2, a ${massDriftPct.toFixed(2)}% drift (max allowed ${MASS_DRIFT_MAX_PCT}%)`));
  const flat1 = bucketFlatness(settled1.frame);
  const flat2 = bucketFlatness(settled2.frame);
  const flatFails = [];
  if (flat1 > FLATNESS_MAX_SPREAD_PX) {
    flatFails.push(`flat surface: settled1 (t=${settled1.atMs}) bucket-median spread ${flat1}px exceeds max ${FLATNESS_MAX_SPREAD_PX}px`);
  }
  if (flat2 > FLATNESS_MAX_SPREAD_PX) {
    flatFails.push(`flat surface: settled2 (t=${settled2.atMs}) bucket-median spread ${flat2}px exceeds max ${FLATNESS_MAX_SPREAD_PX}px`);
  }
  outcomes.push(held("flatness", "the settled surface lies roughly flat", flatFails, `flat surface: bucket-median spread ${flat1}px at settled1 and ${flat2}px at settled2 (max allowed ${FLATNESS_MAX_SPREAD_PX}px)`));
  const shakeDiff = diffPixelCount(settled1.frame, afterShake.frame);
  const shakeFails = [];
  if (shakeDiff < SHAKE_DIFF_MIN_PX) {
    shakeFails.push(`shake agitation: only ${shakeDiff}px differ between settled1 (t=${settled1.atMs}) and afterShake (t=${afterShake.atMs}), min required ${SHAKE_DIFF_MIN_PX}px`);
  }
  outcomes.push(held("shake", "a shake visibly agitates the fluid", shakeFails, `shake agitation: ${shakeDiff}px differ between settled1 (t=${settled1.atMs}) and afterShake (t=${afterShake.atMs}), min required ${SHAKE_DIFF_MIN_PX}px`));
  const boundsFails = [];
  for (const f of frames) {
    if (!borderIsClean(f.frame)) {
      boundsFails.push(`bounds: fluid pixel found in the panel's outermost 1px border at t=${f.atMs} (wall containment broken)`);
    }
  }
  outcomes.push(held("bounds", "wall containment keeps every particle off the panel edge", boundsFails, `bounds: the panel's outermost 1px border is clear on all ${frames.length} captures`));
  if (meta.device.name !== "RP2350-Touch-AMOLED-1.8") {
    outcomes.push({
      id: "push",
      name: "one tick never pushes the whole panel",
      status: "skip",
      message: `panel push: not checked on ${meta.device.name ?? "this device"} - this bound is the RP2350 pack's own QSPI and panel finding, and its numbers are that pack's alone`
    });
  } else if (!meta.pushStats) {
    outcomes.push({
      id: "push",
      name: "one tick never pushes the whole panel",
      status: "unevaluable",
      message: `panel push: this run reports the framebuffer and not what was pushed to the panel, so the ${PUSH_PIXELS_MAX}px-per-tick ` + `bound cannot be answered from it. A board answers SHOT with its framebuffer; the bound is checked against the emulator ` + `by "bun run verify-bundle".`
    });
  } else {
    const { maxPushesPerTick, maxPushPixelsPerTick, tickCount } = meta.pushStats;
    const pushFails = [];
    if (maxPushPixelsPerTick > PUSH_PIXELS_MAX) {
      pushFails.push(`panel push: worst tick pushed ${maxPushPixelsPerTick}px (of ${tickCount} ticks replayed), max allowed ${PUSH_PIXELS_MAX}px - see this port's README's "Panel push" section`);
    }
    if (maxPushesPerTick > PUSH_COUNT_MAX) {
      pushFails.push(`panel push: worst tick issued ${maxPushesPerTick} gfx_push call(s), max allowed ${PUSH_COUNT_MAX} - looks like a return of per-particle pushes`);
    }
    outcomes.push(held("push", "one tick never pushes the whole panel", pushFails, `panel push: worst of ${tickCount} ticks pushed ${maxPushPixelsPerTick}px in ${maxPushesPerTick} call(s), max allowed ${PUSH_PIXELS_MAX}px in ${PUSH_COUNT_MAX}`));
  }
  return summariseInvariants(outcomes);
}

// apps/tinydraw/invariants.ts
function isWhite(rgb, idx) {
  return rgb[idx] === 255 && rgb[idx + 1] === 255 && rgb[idx + 2] === 255;
}
function countInk(frame) {
  const { width, height, rgb } = frame;
  let n = 0;
  for (let i = 0;i < width * height; i++) {
    if (!isWhite(rgb, i * 3))
      n++;
  }
  return n;
}
function colHeights(frame) {
  const { width, height, rgb } = frame;
  const heights = new Array(width).fill(0);
  for (let x = 0;x < width; x++) {
    let c = 0;
    for (let y = 0;y < height; y++) {
      if (!isWhite(rgb, (y * width + x) * 3))
        c++;
    }
    heights[x] = c;
  }
  return heights;
}
function bandAvgHeight(heights, lo, hi) {
  const vals = [];
  for (let x = lo;x < hi; x++) {
    if (heights[x] > 0)
      vals.push(heights[x]);
  }
  if (vals.length === 0)
    return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}
function diffPixelCount2(a, b) {
  let diff = 0;
  const n = Math.min(a.rgb.length, b.rgb.length);
  for (let i = 0;i < n; i += 3) {
    if (a.rgb[i] !== b.rgb[i] || a.rgb[i + 1] !== b.rgb[i + 1] || a.rgb[i + 2] !== b.rgb[i + 2])
      diff++;
  }
  return diff;
}
var MIN_INK_PX = 500;
var WIDTH_RATIO_MIN = 1.1;
var ZOOM_RATIO_MIN = 2.2;
var ZOOM_RATIO_MAX = 4.4;
var MIN_SECOND_STROKE_DELTA_PX = 150;
var MAX_UNDO_DIFF_PX = 0;
function check2(frames, meta) {
  if (frames.length !== 4) {
    return summariseInvariants([
      {
        id: "capture-contract",
        name: "the trace's own four capture points arrived",
        status: "fail",
        message: `expected exactly 4 captures (drawn, zoomed, twoStrokes, afterUndo) per this trace's own contract, got ${frames.length}`
      }
    ]);
  }
  const [drawn, zoomed, twoStrokes, afterUndo] = frames;
  const outcomes = [];
  const inkDrawn = countInk(drawn.frame);
  const inkFails = [];
  if (inkDrawn < MIN_INK_PX) {
    inkFails.push(`ink drawn: only ${inkDrawn}px non-white at drawn (t=${drawn.atMs}), min required ${MIN_INK_PX}px`);
  }
  outcomes.push(held("ink", "the stroke is actually drawn", inkFails, `ink drawn: ${inkDrawn}px non-white at drawn (t=${drawn.atMs}), min required ${MIN_INK_PX}px`));
  const heights = colHeights(drawn.frame);
  const nonZeroXs = [];
  for (let x = 0;x < heights.length; x++)
    if (heights[x] > 0)
      nonZeroXs.push(x);
  const widthFails = [];
  let widthPassMessage = "";
  if (nonZeroXs.length < 10) {
    widthFails.push(`variable width: too little ink at drawn (t=${drawn.atMs}) to measure a width profile (${nonZeroXs.length} ink columns)`);
  } else {
    const lo = nonZeroXs[0], hi = nonZeroXs[nonZeroXs.length - 1];
    const span = hi - lo;
    const startAvg = bandAvgHeight(heights, lo, lo + Math.floor(span * 0.15));
    const midAvg = bandAvgHeight(heights, lo + Math.floor(span * 0.4), lo + Math.floor(span * 0.6));
    const endAvg = bandAvgHeight(heights, hi - Math.floor(span * 0.15), hi);
    const ratioStart = startAvg > 0 ? midAvg / startAvg : 0;
    const ratioEnd = endAvg > 0 ? midAvg / endAvg : 0;
    if (ratioStart < WIDTH_RATIO_MIN || ratioEnd < WIDTH_RATIO_MIN) {
      widthFails.push(`variable width: mid-band avg height ${midAvg.toFixed(2)}px is not >= ${WIDTH_RATIO_MIN}x both end bands (start ${startAvg.toFixed(2)}px, end ${endAvg.toFixed(2)}px) at drawn (t=${drawn.atMs}) - line reads roughly constant width`);
    }
    widthPassMessage = `variable width: mid-band avg height ${midAvg.toFixed(2)}px against start ${startAvg.toFixed(2)}px (${ratioStart.toFixed(2)}x) and ` + `end ${endAvg.toFixed(2)}px (${ratioEnd.toFixed(2)}x), min required ${WIDTH_RATIO_MIN}x`;
  }
  outcomes.push(held("width", "the stroke is thicker in its middle than at either end", widthFails, widthPassMessage));
  const inkZoomed = countInk(zoomed.frame);
  const zoomRatio = inkDrawn > 0 ? inkZoomed / inkDrawn : 0;
  const zoomFails = [];
  if (zoomRatio < ZOOM_RATIO_MIN || zoomRatio > ZOOM_RATIO_MAX) {
    zoomFails.push(`zoom scaling: ink went from ${inkDrawn}px (drawn, t=${drawn.atMs}) to ${inkZoomed}px (zoomed, t=${zoomed.atMs}), a ${zoomRatio.toFixed(2)}x change, expected between ${ZOOM_RATIO_MIN}x and ${ZOOM_RATIO_MAX}x`);
  }
  outcomes.push(held("zoom", "zoom reprojects the ink already there, at about 2x", zoomFails, `zoom scaling: ${inkDrawn}px (drawn) to ${inkZoomed}px (zoomed), a ${zoomRatio.toFixed(2)}x change, expected between ${ZOOM_RATIO_MIN}x and ${ZOOM_RATIO_MAX}x`));
  const inkTwoStrokes = countInk(twoStrokes.frame);
  const secondStrokeDelta = inkTwoStrokes - inkZoomed;
  const secondFails = [];
  if (secondStrokeDelta < MIN_SECOND_STROKE_DELTA_PX) {
    secondFails.push(`second stroke: only +${secondStrokeDelta}px between zoomed (t=${zoomed.atMs}, ${inkZoomed}px) and twoStrokes (t=${twoStrokes.atMs}, ${inkTwoStrokes}px), min required +${MIN_SECOND_STROKE_DELTA_PX}px`);
  }
  outcomes.push(held("second-stroke", "a second stroke adds real ink of its own", secondFails, `second stroke: +${secondStrokeDelta}px between zoomed (${inkZoomed}px) and twoStrokes (${inkTwoStrokes}px), min required +${MIN_SECOND_STROKE_DELTA_PX}px`));
  const undoDiff = diffPixelCount2(zoomed.frame, afterUndo.frame);
  const undoFails = [];
  if (undoDiff > MAX_UNDO_DIFF_PX) {
    undoFails.push(`undo exactness: afterUndo (t=${afterUndo.atMs}) differs from zoomed (t=${zoomed.atMs}) by ${undoDiff}px, expected ${MAX_UNDO_DIFF_PX} (undo must reproduce the pre-second-stroke panel exactly)`);
  }
  outcomes.push(held("undo", "undo removes exactly the most recent stroke and nothing else", undoFails, `undo exactness: afterUndo (t=${afterUndo.atMs}) differs from zoomed (t=${zoomed.atMs}) by ${undoDiff}px, expected ${MAX_UNDO_DIFF_PX}`));
  return summariseInvariants(outcomes);
}

// apps/gameos/invariants.ts
function diffPixelCount3(a, b) {
  let diff = 0;
  const n = Math.min(a.rgb.length, b.rgb.length);
  for (let i = 0;i < n; i += 3) {
    if (a.rgb[i] !== b.rgb[i] || a.rgb[i + 1] !== b.rgb[i + 1] || a.rgb[i + 2] !== b.rgb[i + 2])
      diff++;
  }
  return diff;
}
function countDark(frame, thresh) {
  const { width, height, rgb } = frame;
  let n = 0;
  for (let i = 0;i < width * height; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    if ((r + g + b) / 3 < thresh)
      n++;
  }
  return n;
}
function countCyan(frame) {
  const { width, height, rgb } = frame;
  let n = 0;
  for (let i = 0;i < width * height; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    if (r < 120 && g > 150 && b > 150)
      n++;
  }
  return n;
}
function countGold(frame) {
  const { width, height, rgb } = frame;
  let n = 0;
  for (let i = 0;i < width * height; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    if (r > 180 && g > 130 && b < 120)
      n++;
  }
  return n;
}
var MIN_GRID_DARK_PX = 500;
var MIN_GRID_CYAN_PX = 300;
var MIN_LAUNCH_DIFF_PX = 50000;
var MIN_TICK_DIFF_PX = 5000;
var MAX_GUNSHIP_GOLD_PX = 0;
var MAX_RETURN_DIFF_PX = 0;
var MIN_GOLF_SWING_DIFF_PX = 30000;
var MAX_GOLF_RETURN_DIFF_PX = 0;
var MIN_OPEN_DIFF_PX = 50000;
function check3(frames, meta) {
  if (frames.length !== 12 && frames.length !== 21) {
    return summariseInvariants([
      {
        id: "capture-contract",
        name: "one of this checker's two known capture-point shapes arrived",
        status: "fail",
        message: `expected exactly 12 (rp2350 port, its own bespoke picker) or 21 (esp32 port, the real donor shell) captures per this trace's own contract, got ${frames.length}`
      }
    ]);
  }
  const outcomes = [];
  if (frames.length === 12) {
    const [launcher16, launcher48, launcher80, briefing2, missionStart2, firing2, wave2, backToLauncher, idle2, midSpin2, landed2, win2] = frames;
    const contentFails = [];
    const brights = [];
    for (const [label, f] of [["launcher16", launcher16], ["launcher48", launcher48], ["launcher80", launcher80]]) {
      const bright = (() => {
        const { width, height, rgb } = f.frame;
        let n = 0;
        for (let i = 0;i < width * height; i++) {
          const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
          if ((r + g + b) / 3 > 200)
            n++;
        }
        return n;
      })();
      brights.push(`${label} ${bright}px`);
      if (bright < 1500)
        contentFails.push(`launcher content: only ${bright}px bright(>200) at ${label} (t=${f.atMs}), min required 1500px`);
    }
    outcomes.push(held("launcher", "the launcher draws its cards, not a blank field", contentFails, `launcher content: bright(>200) ${brights.join(", ")}, min required 1500px`));
    const launchDiff2 = diffPixelCount3(launcher80.frame, briefing2.frame);
    const launchFails2 = [];
    if (launchDiff2 < 50000)
      launchFails2.push(`launch transition: only ${launchDiff2}px differ between launcher80 and briefing, min required 50000px`);
    outcomes.push(held("launch", "tapping a card launches its game", launchFails2, `launch transition: ${launchDiff2}px differ between launcher80 and briefing, min required 50000px`));
    const ticks2 = [
      ["briefing->missionStart", briefing2, missionStart2],
      ["missionStart->firing", missionStart2, firing2],
      ["firing->wave", firing2, wave2],
      ["idle->midSpin", idle2, midSpin2],
      ["midSpin->landed", midSpin2, landed2],
      ["landed->win", landed2, win2]
    ];
    const simFails2 = [];
    const simSeen2 = [];
    for (const [label, a, b] of ticks2) {
      const d = diffPixelCount3(a.frame, b.frame);
      simSeen2.push(`${label} ${d}px`);
      if (d < 5000)
        simFails2.push(`simulation alive: only ${d}px differ across ${label}, min required 5000px`);
    }
    outcomes.push(held("sim", "each game's own simulation keeps advancing", simFails2, `simulation alive: ${simSeen2.join(", ")}, min required 5000px each`));
    const goldFails2 = [];
    const goldSeen2 = [];
    for (const [label, f] of [["briefing", briefing2], ["missionStart", missionStart2], ["firing", firing2], ["wave", wave2]]) {
      const gold = countGold(f.frame);
      goldSeen2.push(`${label} ${gold}px`);
      if (gold > 0)
        goldFails2.push(`gunship palette: ${gold}px read as gold/amber at ${label}, max allowed 0px`);
    }
    outcomes.push(held("palette", "GUNSHIP's thermal palette holds during play", goldFails2, `gunship palette: gold/amber ${goldSeen2.join(", ")}, max allowed 0px`));
    const returnDiff = diffPixelCount3(launcher80.frame, backToLauncher.frame);
    const returnFails2 = [];
    if (returnDiff > 0)
      returnFails2.push(`launcher exactness: backToLauncher differs from launcher80 by ${returnDiff}px, expected 0`);
    outcomes.push(held("launcher-exact", "leaving a game reproduces the launcher exactly", returnFails2, `launcher exactness: backToLauncher differs from launcher80 by ${returnDiff}px, expected 0`));
    return summariseInvariants(outcomes);
  }
  const [
    grid16,
    grid48,
    grid80,
    briefing,
    missionStart,
    firing,
    wave,
    pauseOverlay,
    backToGrid,
    idle,
    midSpin,
    landed,
    win,
    backToGridFromLucky7,
    golfReady,
    golfSwingImpact,
    backToGridFromGolf,
    aimTestOpen,
    backToGridFromAimTest,
    diagOpen,
    backToGridFromDiag
  ] = frames;
  const gridFails = [];
  const gridSeen = [];
  for (const [label, f] of [["grid16", grid16], ["grid48", grid48], ["grid80", grid80]]) {
    const dark = countDark(f.frame, 100);
    const cyan = countCyan(f.frame);
    gridSeen.push(`${label} ${dark}px dark / ${cyan}px cyan`);
    if (dark < MIN_GRID_DARK_PX) {
      gridFails.push(`grid content: only ${dark}px dark(<100) at ${label} (t=${f.atMs}), min required ${MIN_GRID_DARK_PX}px - grid reads as a blank field`);
    }
    if (cyan < MIN_GRID_CYAN_PX) {
      gridFails.push(`grid content: only ${cyan}px cyan (tile icons) at ${label} (t=${f.atMs}), min required ${MIN_GRID_CYAN_PX}px - tile icons missing`);
    }
  }
  outcomes.push(held("grid", "the grid draws its five tiles, borders and title, not a flat field", gridFails, `grid content: ${gridSeen.join(", ")}, min required ${MIN_GRID_DARK_PX}px dark and ${MIN_GRID_CYAN_PX}px cyan`));
  const launchDiff = diffPixelCount3(grid80.frame, briefing.frame);
  const launchFails = [];
  if (launchDiff < MIN_LAUNCH_DIFF_PX) {
    launchFails.push(`launch transition: only ${launchDiff}px differ between grid80 (t=${grid80.atMs}) and briefing (t=${briefing.atMs}), min required ${MIN_LAUNCH_DIFF_PX}px - tapping the GUNSHIP tile does not appear to launch it`);
  }
  outcomes.push(held("launch", "tapping a tile launches its game", launchFails, `launch transition: ${launchDiff}px differ between grid80 (t=${grid80.atMs}) and briefing (t=${briefing.atMs}), min required ${MIN_LAUNCH_DIFF_PX}px`));
  const ticks = [
    ["briefing->missionStart", briefing, missionStart],
    ["missionStart->firing", missionStart, firing],
    ["firing->wave", firing, wave],
    ["idle->midSpin", idle, midSpin],
    ["midSpin->landed", midSpin, landed],
    ["landed->win", landed, win]
  ];
  const simFails = [];
  const simSeen = [];
  for (const [label, a, b] of ticks) {
    const d = diffPixelCount3(a.frame, b.frame);
    simSeen.push(`${label} ${d}px`);
    if (d < MIN_TICK_DIFF_PX) {
      simFails.push(`simulation alive: only ${d}px differ across ${label} (t=${a.atMs}->t=${b.atMs}), min required ${MIN_TICK_DIFF_PX}px - looks frozen`);
    }
  }
  outcomes.push(held("sim", "each game's own simulation keeps advancing", simFails, `simulation alive: ${simSeen.join(", ")}, min required ${MIN_TICK_DIFF_PX}px each`));
  const goldFails = [];
  const goldSeen = [];
  for (const [label, f] of [["briefing", briefing], ["missionStart", missionStart], ["firing", firing], ["wave", wave]]) {
    const gold = countGold(f.frame);
    goldSeen.push(`${label} ${gold}px`);
    if (gold > MAX_GUNSHIP_GOLD_PX) {
      goldFails.push(`gunship palette: ${gold}px read as gold/amber at ${label} (t=${f.atMs}), max allowed ${MAX_GUNSHIP_GOLD_PX}px - the thermal ramp is not holding during play`);
    }
  }
  outcomes.push(held("palette", "GUNSHIP's thermal palette holds during play", goldFails, `gunship palette: gold/amber ${goldSeen.join(", ")}, max allowed ${MAX_GUNSHIP_GOLD_PX}px`));
  const returnFails = [];
  const returnSeen = [];
  for (const [label, f] of [["backToGrid", backToGrid], ["backToGridFromLucky7", backToGridFromLucky7]]) {
    const d = diffPixelCount3(grid80.frame, f.frame);
    returnSeen.push(`${label} ${d}px`);
    if (d > MAX_RETURN_DIFF_PX) {
      returnFails.push(`grid exactness: ${label} (t=${f.atMs}) differs from grid80 (t=${grid80.atMs}) by ${d}px, expected ${MAX_RETURN_DIFF_PX} (returning to the grid must reproduce it exactly)`);
    }
  }
  outcomes.push(held("grid-exact", "leaving a game reproduces the grid exactly", returnFails, `grid exactness: ${returnSeen.join(", ")} against grid80, expected ${MAX_RETURN_DIFF_PX}`));
  const swingDiff = diffPixelCount3(golfReady.frame, golfSwingImpact.frame);
  const swingFails = [];
  if (swingDiff < MIN_GOLF_SWING_DIFF_PX) {
    swingFails.push(`golf swing: only ${swingDiff}px differ between golfReady (t=${golfReady.atMs}) and golfSwingImpact (t=${golfSwingImpact.atMs}), min required ${MIN_GOLF_SWING_DIFF_PX}px - the swing does not appear to have armed and fired a shot`);
  }
  outcomes.push(held("golf-swing", "a swing arms and fires a shot", swingFails, `golf swing: ${swingDiff}px differ between golfReady (t=${golfReady.atMs}) and golfSwingImpact (t=${golfSwingImpact.atMs}), min required ${MIN_GOLF_SWING_DIFF_PX}px`));
  const golfReturnDiff = diffPixelCount3(grid80.frame, backToGridFromGolf.frame);
  const golfReturnFails = [];
  if (golfReturnDiff > MAX_GOLF_RETURN_DIFF_PX) {
    golfReturnFails.push(`golf grid exactness: backToGridFromGolf (t=${backToGridFromGolf.atMs}) differs from grid80 (t=${grid80.atMs}) by ${golfReturnDiff}px, expected ${MAX_GOLF_RETURN_DIFF_PX} (returning to the grid from GOLF must reproduce it exactly - GOLF's own direct565 mode must be fully undone)`);
  }
  outcomes.push(held("golf-grid-exact", "leaving GOLF undoes its direct565 mode and reproduces the grid exactly", golfReturnFails, `golf grid exactness: backToGridFromGolf differs from grid80 by ${golfReturnDiff}px, expected ${MAX_GOLF_RETURN_DIFF_PX}`));
  const harnessFails = [];
  const harnessSeen = [];
  for (const [label, openFrame, backLabel, backFrame] of [
    ["aimTestOpen", aimTestOpen, "backToGridFromAimTest", backToGridFromAimTest],
    ["diagOpen", diagOpen, "backToGridFromDiag", backToGridFromDiag]
  ]) {
    const openDiff = diffPixelCount3(grid80.frame, openFrame.frame);
    const backDiff = diffPixelCount3(grid80.frame, backFrame.frame);
    harnessSeen.push(`${label} ${openDiff}px, ${backLabel} ${backDiff}px`);
    if (openDiff < MIN_OPEN_DIFF_PX) {
      harnessFails.push(`${label}: only ${openDiff}px differ from grid80 (t=${grid80.atMs}) at t=${openFrame.atMs}, min required ${MIN_OPEN_DIFF_PX}px - tapping the tile does not appear to open it`);
    }
    if (backDiff > MAX_RETURN_DIFF_PX) {
      harnessFails.push(`${backLabel}: differs from grid80 (t=${grid80.atMs}) by ${backDiff}px at t=${backFrame.atMs}, expected ${MAX_RETURN_DIFF_PX} (returning to the grid must reproduce it exactly)`);
    }
  }
  outcomes.push(held("harness-apps", "AIM TEST and DIAG each open from the grid and return to it exactly", harnessFails, `${harnessSeen.join("; ")} (open min ${MIN_OPEN_DIFF_PX}px, return expected ${MAX_RETURN_DIFF_PX}px)`));
  return summariseInvariants(outcomes);
}

// site/attest/checkers.ts
var INVARIANT_CHECKERS = {
  "apps/fluidbox/invariants.ts": check,
  "apps/tinydraw/invariants.ts": check2,
  "apps/gameos/invariants.ts": check3
};
function checkerFor(path) {
  return INVARIANT_CHECKERS[path] ?? null;
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
  return opts.plan.kind === "invariants" ? runInvariantsAttestation({ ...opts, plan: opts.plan }) : runPixelExactAttestation({ ...opts, plan: opts.plan });
}
async function runPixelExactAttestation(opts) {
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
  return { kind: "pixel-exact", verdict, points, invariants: [], incomplete: false };
}
async function runInvariantsAttestation(opts) {
  const { plan, link } = opts;
  const report = opts.report ?? (() => {});
  const check4 = checkerFor(plan.checker);
  if (!check4) {
    throw new Error(`this page carries no bundled checker for ${plan.checker}, so ${plan.app}'s own invariants cannot be run here. ` + `site/attest/checkers.ts is the list, and site/build.ts refuses to emit a plan that is not in it.`);
  }
  const totalPoints = plan.traces.reduce((n, t) => n + t.captureAt.length, 0);
  if (totalPoints === 0) {
    throw new Error(`${plan.combo}'s bundle states no capture points, so there is nothing for its invariants to read`);
  }
  const frames = [];
  let donePoints = 0;
  let pushStats;
  report({ phase: "connecting", percent: 0, message: "Opening the board's devlink port…" });
  await link.connect();
  try {
    for (const trace of plan.traces) {
      report({
        phase: "replaying",
        percent: Math.round(donePoints / totalPoints * 100),
        message: `Replaying ${trace.name} on the board (${trace.events.length} events)…`
      });
      const replay = await replayHardware(persistentLink(link), trace.events, trace.captureAt);
      pushStats = replay.pushStats;
      for (const atMs of trace.captureAt) {
        const captured = replay.frames.find((f) => f.atMs === atMs);
        if (!captured) {
          throw new Error(`the board never produced a capture at ${atMs}ms of ${trace.name}, so this port's invariants cannot be checked on it`);
        }
        frames.push({ atMs: captured.atMs, frame: captured.frame });
        donePoints++;
      }
    }
  } finally {
    await link.disconnect();
  }
  const panel = plan.device.panel;
  const wrong = frames.find((f) => f.frame.width !== panel.w || f.frame.height !== panel.h);
  if (wrong) {
    throw new Error(`the board captured ${wrong.frame.width}x${wrong.frame.height} frames, but ${plan.pack} declares a ${panel.w}x${panel.h} panel. ` + `This port's invariants are pixel counts against that panel, so the run is void rather than divergent.`);
  }
  report({ phase: "checking", percent: 100, message: `Running ${plan.app}'s own invariants on ${frames.length} captured frame(s)…` });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = check4(frames, { device: plan.device, pushStats });
  const outcomes = result.invariants ?? [];
  if (outcomes.length === 0) {
    throw new Error(`${plan.checker} reported no per-invariant outcomes, so this page cannot say which invariant held and which did not. ` + `A checker must return them (harness/invariantTypes.ts's summariseInvariants).`);
  }
  const invariants = outcomes.map((o) => ({ id: o.id, name: o.name, status: o.status, message: o.message }));
  const failed = invariants.filter((i) => i.status === "fail").length;
  const unanswered = invariants.filter((i) => i.status === "unevaluable");
  const verdict = failed === 0 ? "match" : "diverge";
  report({
    phase: "done",
    percent: 100,
    message: unanswered.length > 0 ? `${unanswered.length} invariant(s) could not be answered by this board.` : verdict === "match" ? `${invariants.filter((i) => i.status === "pass").length} invariant(s) held on this board.` : `${failed} invariant(s) failed on this board.`
  });
  return { kind: "invariants", verdict, points: [], invariants, incomplete: unanswered.length > 0 };
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
function row(mark, markClass, label, detail) {
  const li = document.createElement("li");
  li.className = `attest-point ${markClass}`;
  const markEl = document.createElement("span");
  markEl.className = "attest-point-mark";
  markEl.textContent = mark;
  const labelEl = document.createElement("span");
  labelEl.className = "attest-point-label";
  labelEl.textContent = label;
  const detailEl = document.createElement("span");
  detailEl.className = "attest-point-detail";
  detailEl.textContent = detail;
  li.append(markEl, labelEl, detailEl);
  return li;
}
function renderChecks(list, result) {
  list.textContent = "";
  for (const point of result.points) {
    list.appendChild(row(point.match ? "MATCH" : "DIVERGE", point.match ? "attest-point-match" : "attest-point-diverge", `${point.trace} at ${point.atMs}ms`, point.match ? `${point.totalPixels} pixels identical` : `${point.diffPixels}/${point.totalPixels} pixels differ`));
  }
  for (const inv of result.invariants) {
    const mark = inv.status === "pass" ? "PASS" : inv.status === "fail" ? "FAIL" : inv.status === "skip" ? "N/A" : "UNANSWERED";
    const cls = inv.status === "pass" ? "attest-point-match" : inv.status === "fail" ? "attest-point-diverge" : inv.status === "skip" ? "attest-point-skip" : "attest-point-unevaluable";
    list.appendChild(row(mark, cls, inv.name, inv.message));
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
function verdictSentence(result) {
  if (result.kind === "pixel-exact") {
    const matched = result.points.filter((p) => p.match).length;
    return result.verdict === "match" ? `✓ Runs on this board: ${matched}/${result.points.length} frames matched the recorded ones, pixel for pixel.` : `This board drew something else: ${result.points.length - matched}/${result.points.length} frames diverged. That is a result worth posting too.`;
  }
  const held2 = result.invariants.filter((i) => i.status === "pass").length;
  const failed = result.invariants.filter((i) => i.status === "fail");
  if (result.incomplete) {
    const unanswered = result.invariants.filter((i) => i.status === "unevaluable");
    return `This run is incomplete: ${unanswered.map((i) => i.name).join(", ")} cannot be answered by a board, only by the emulator. ` + `Nothing is posted, because a verdict that counted an unanswered check as a passed one would be a claim this run cannot support.`;
  }
  return result.verdict === "match" ? `✓ Runs on this board: all ${held2} of this port's own invariants held on the frames it drew.` : `This board behaves differently: ${failed.length} of this port's own invariants failed (${failed.map((i) => i.name).join(", ")}). That is a result worth posting too.`;
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
    statusEl.textContent = "Loading this port's own trace…";
    try {
      if (!navigator.serial) {
        throw new Error("Web Serial isn't available in this browser, so a board can't be driven from this page. Use Chrome or Edge on desktop.");
      }
      const loaded = await loadPlan(planUrl);
      const plan = loaded.kind === "pixel-exact" ? { ...loaded, framesBase: resolveFramesBase(planUrl, loaded.framesBase) } : loaded;
      const link = new WebSerialLink({
        dataTerminalReady: plan.dataTerminalReady,
        appIndex: plan.appIndex
      });
      const result = await runAttestation({
        plan,
        link,
        report: (p) => {
          statusEl.textContent = p.message;
        }
      });
      renderChecks(pointsEl, result);
      verdictEl.className = result.incomplete ? "attest-verdict attest-verdict-incomplete" : result.verdict === "match" ? "attest-verdict attest-verdict-match" : "attest-verdict attest-verdict-diverge";
      show(verdictEl, verdictSentence(result));
      hide(progressEl);
      if (result.incomplete)
        return;
      const portSha = await fetchArtifactSha(planUrl, plan.artifact);
      pending = {
        app: plan.app,
        pack: plan.pack,
        portSha,
        kind: result.kind,
        verdict: result.verdict,
        boardFamily: plan.boardFamily,
        date: todayISO(),
        ...result.kind === "pixel-exact" ? { points: result.points } : { invariants: result.invariants }
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
