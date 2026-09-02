// src/abiGuard.ts
class FirmwareBug extends Error {
  constructor(message) {
    super(message);
    this.name = "FirmwareBug";
  }
}
function describe(n) {
  if (!Number.isFinite(n))
    return String(n);
  if (!Number.isInteger(n))
    return String(n);
  return `${n} (0x${(n >>> 0).toString(16)})`;
}
function validateFbPtr(memory, fbPtr, panelW, panelH) {
  const bytesPerPixel = 2;
  const bytesNeeded = panelW * panelH * bytesPerPixel;
  if (!Number.isInteger(fbPtr) || fbPtr < 0) {
    throw new FirmwareBug(`emu_fb() returned ${describe(fbPtr)}, which is not a valid (non-negative integer) memory offset`);
  }
  if (fbPtr % bytesPerPixel !== 0) {
    throw new FirmwareBug(`emu_fb() returned ${describe(fbPtr)}, which is not ${bytesPerPixel}-byte aligned (required to read the panel as 16-bit pixels)`);
  }
  if (fbPtr + bytesNeeded > memory.buffer.byteLength) {
    throw new FirmwareBug(`emu_fb() returned ${describe(fbPtr)}, but the declared panel is ${panelW}x${panelH} (needs ${bytesNeeded} bytes there) ` + `and the module's own memory is only ${memory.buffer.byteLength} bytes; this pointer runs off the end of the module's own memory`);
  }
}
function validatePushRect(rect, panelW, panelH) {
  const { x, y, w, h } = rect;
  for (const [name, v] of [
    ["x", x],
    ["y", y],
    ["w", w],
    ["h", h]
  ]) {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      return { ok: false, reason: `${name}=${describe(v)} is not a finite integer` };
    }
  }
  if (w < 0 || h < 0)
    return { ok: false, reason: `w=${w}, h=${h} is negative` };
  if (w === 0 || h === 0)
    return { ok: true };
  if (x < 0 || y < 0)
    return { ok: false, reason: `x=${x}, y=${y} is negative` };
  if (x + w > panelW || y + h > panelH) {
    return { ok: false, reason: `rect (${x},${y} ${w}x${h}) extends past the declared panel (${panelW}x${panelH})` };
  }
  return { ok: true };
}
var MAX_PUSHES_PER_TICK = 256;
function validatePushCount(count) {
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
    return { count: 0, reason: `emu_push_count() returned ${describe(count)}, not a valid non-negative integer; reading 0 pushes this tick` };
  }
  if (count > MAX_PUSHES_PER_TICK) {
    return {
      count: MAX_PUSHES_PER_TICK,
      reason: `emu_push_count() returned ${count}, more than the ${MAX_PUSHES_PER_TICK} this emulator will read in one tick ` + `(is g_push_count being reset at the top of emu_tick(), per emu_abi.h?); reading only the first ${MAX_PUSHES_PER_TICK}`
    };
  }
  return { count };
}
function validateAudioBuffer(memory, framesPtr, frameCount, sampleRate) {
  if (!Number.isFinite(frameCount) || !Number.isInteger(frameCount) || frameCount <= 0) {
    return { ok: false, reason: `emu_sound_frames() returned ${describe(frameCount)}, not a positive integer` };
  }
  if (!Number.isFinite(framesPtr) || !Number.isInteger(framesPtr) || framesPtr < 0) {
    return { ok: false, reason: `emu_sound_buffer() returned ${describe(framesPtr)}, not a valid memory offset` };
  }
  if (framesPtr % 2 !== 0) {
    return { ok: false, reason: `emu_sound_buffer() returned ${describe(framesPtr)}, not 2-byte aligned (required to read int16 samples)` };
  }
  const bytesNeeded = frameCount * 2;
  if (framesPtr + bytesNeeded > memory.buffer.byteLength) {
    return {
      ok: false,
      reason: `emu_sound_buffer()/emu_sound_frames() describe a ${bytesNeeded}-byte region at ${describe(framesPtr)} ` + `that runs off the end of the module's ${memory.buffer.byteLength}-byte memory`
    };
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 384000) {
    return { ok: false, reason: `emu_sound_sample_rate() returned ${describe(sampleRate)}, not a plausible sample rate` };
  }
  return { ok: true };
}

// src/wasiLite.ts
var WASI_MODULE = "wasi_snapshot_preview1";
var SUPPORTED_WASI_IMPORTS = ["clock_time_get", "fd_write", "proc_exit", "random_get"];
var DEFAULT_TRACE_SEED = 1347767089;
var ERRNO_SUCCESS = 0;
var ERRNO_BADF = 8;
var FD_STDOUT = 1;
var FD_STDERR = 2;
function makePrng(seed) {
  let state = seed >>> 0;
  return () => {
    state = state + 1831565813 >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return (t ^ t >>> 14) >>> 0 & 255;
  };
}
function wasiImportNames(imports) {
  const seen = new Set;
  for (const imp of imports) {
    if (imp.module === WASI_MODULE)
      seen.add(imp.name);
  }
  return [...seen];
}
function unsupportedWasiImports(names) {
  const supported = new Set(SUPPORTED_WASI_IMPORTS);
  return names.filter((n) => !supported.has(n)).sort();
}
function unsupportedWasiMessage(unsupported) {
  return `wasm module imports ${unsupported.map((n) => `${WASI_MODULE}.${n}`).join(", ")}, which this emulator does not provide. ` + `Supported ${WASI_MODULE} imports: ${SUPPORTED_WASI_IMPORTS.join(", ")}. ` + `This is WASI-lite, not WASI: only imports that can be answered deterministically from a trace are shimmed ` + `(see docs/decisions/0004-wasi-lite-not-wasi.md). Build against wasm32-freestanding, or stop linking whatever pulls these in.`;
}

class ProcExitError extends Error {
  code;
  constructor(code) {
    super(`module called ${WASI_MODULE}.proc_exit(${code}): a puck module never exits, it returns from emu_tick() and is called again. ` + `This halt is fatal for this instance; nothing after it ran.`);
    this.code = code;
    this.name = "ProcExitError";
  }
}
function buildWasiLite(host) {
  const nextByte = makePrng(host.seed);
  const view = () => {
    const memory = host.getMemory();
    return memory ? new DataView(memory.buffer) : null;
  };
  return {
    fd_write: (fd, iovsPtr, iovsLen, nwrittenPtr) => {
      if (fd !== FD_STDOUT && fd !== FD_STDERR)
        return ERRNO_BADF;
      const memory = host.getMemory();
      const dv = view();
      if (!memory || !dv)
        return ERRNO_BADF;
      const bytes = [];
      let written = 0;
      for (let i = 0;i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const ptr = dv.getUint32(base, true);
        const len = dv.getUint32(base + 4, true);
        const chunk = new Uint8Array(memory.buffer, ptr, len);
        for (const b of chunk)
          bytes.push(b);
        written += len;
      }
      const text = new TextDecoder().decode(new Uint8Array(bytes));
      const lines = text.split(`
`);
      if (lines.length > 1 && lines[lines.length - 1] === "")
        lines.pop();
      for (const line of lines)
        host.onLog(line);
      dv.setUint32(nwrittenPtr, written, true);
      return ERRNO_SUCCESS;
    },
    clock_time_get: (_clockId, _precision, timePtr) => {
      const dv = view();
      if (!dv)
        return ERRNO_BADF;
      const ns = BigInt(Math.max(0, Math.floor(host.nowMs()))) * 1000000n;
      dv.setBigUint64(timePtr, ns, true);
      return ERRNO_SUCCESS;
    },
    random_get: (bufPtr, bufLen) => {
      const memory = host.getMemory();
      if (!memory)
        return ERRNO_BADF;
      const out = new Uint8Array(memory.buffer, bufPtr, bufLen);
      for (let i = 0;i < bufLen; i++)
        out[i] = nextByte();
      return ERRNO_SUCCESS;
    },
    proc_exit: (code) => {
      throw new ProcExitError(code);
    }
  };
}

// src/wasm.ts
var DEFAULT_WASM_URL = "wasm/emu.wasm";
function buildImportObject(onLog, getMemory) {
  const readString = (ptr, len) => {
    const memory = getMemory();
    if (!memory)
      return "";
    return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
  };
  return {
    env: {
      sinf: Math.sin,
      cosf: Math.cos,
      atan2f: Math.atan2,
      sqrtf: Math.sqrt,
      fabsf: Math.abs,
      floorf: Math.floor,
      fmodf: (a, b) => a % b,
      powf: Math.pow,
      expf: Math.exp,
      js_log: (ptr, len) => onLog(readString(ptr, len))
    }
  };
}
async function fetchWasmBytes(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`wasm module not found at ${url} (HTTP ${res.status}). This half of the project builds separately ` + `(see wasm/emu_abi.h); build it, or point the watcher at it, then reload.`);
  }
  return res.arrayBuffer();
}
function hasWasmMagic(bytes) {
  if (bytes.byteLength < 8)
    return false;
  const b = new Uint8Array(bytes, 0, 4);
  return b[0] === 0 && b[1] === 97 && b[2] === 115 && b[3] === 109;
}
async function instantiate(bytes, onLog, options = {}) {
  if (!hasWasmMagic(bytes)) {
    throw new Error(`not a valid wasm module: bad magic bytes (${bytes.byteLength} bytes read). ` + `This usually means the file was read mid-rebuild; wait a moment and retry.`);
  }
  let module;
  try {
    module = await WebAssembly.compile(bytes);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  let memory;
  let lastNowMs = 0;
  const importObject = buildImportObject(onLog, () => memory);
  const wasiNames = wasiImportNames(WebAssembly.Module.imports(module));
  const wantsWasi = wasiNames.length > 0;
  if (wantsWasi) {
    const unsupported = unsupportedWasiImports(wasiNames);
    if (unsupported.length > 0)
      throw new Error(unsupportedWasiMessage(unsupported));
    importObject[WASI_MODULE] = buildWasiLite({
      onLog,
      getMemory: () => memory,
      nowMs: () => lastNowMs,
      seed: options.seed ?? DEFAULT_TRACE_SEED
    });
  }
  let instance;
  try {
    instance = await WebAssembly.instantiate(module, importObject);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  const exports = instance.exports;
  memory = exports.memory;
  if (!memory) {
    throw new Error("wasm module has no exported 'memory'; the emulator reads the framebuffer and emu_device() through it.");
  }
  if (!wantsWasi)
    return exports;
  const rawTick = exports.emu_tick.bind(exports);
  return {
    ...exports,
    emu_tick(nowMs) {
      lastNowMs = nowMs;
      rawTick(nowMs);
    }
  };
}
function readCString(memory, ptr) {
  const bytes = new Uint8Array(memory.buffer);
  let end = ptr;
  while (end < bytes.length && bytes[end] !== 0)
    end++;
  return new TextDecoder().decode(bytes.subarray(ptr, end));
}
function jsonOf(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
function readDeviceDescriptor(emu) {
  const ptr = emu.emu_device();
  const text = readCString(emu.memory, ptr);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`emu_device() returned invalid JSON: ${err instanceof Error ? err.message : String(err)}
${text}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`emu_device() must return a JSON object, got: ${text}`);
  }
  const d = parsed;
  if (typeof d.panel !== "object" || d.panel === null) {
    throw new Error(`emu_device() is missing a "panel" object: ${text}`);
  }
  const panel = d.panel;
  if (!Number.isInteger(panel.w) || panel.w <= 0 || !Number.isInteger(panel.h) || panel.h <= 0) {
    throw new Error(`emu_device()'s "panel" needs positive integer w/h, got w=${jsonOf(panel.w)} h=${jsonOf(panel.h)}: ${text}`);
  }
  if (typeof panel.format !== "string" || panel.format.length === 0) {
    throw new Error(`emu_device()'s "panel" is missing a valid string "format": ${text}`);
  }
  if (d.buttons !== undefined) {
    if (!Array.isArray(d.buttons))
      throw new Error(`emu_device()'s "buttons" must be an array: ${text}`);
    d.buttons.forEach((b, i) => {
      if (typeof b !== "object" || b === null)
        throw new Error(`emu_device()'s buttons[${i}] is not an object: ${text}`);
      const bb = b;
      if (typeof bb.id !== "string" || bb.id.length === 0) {
        throw new Error(`emu_device()'s buttons[${i}] is missing a valid string "id": ${text}`);
      }
      if (typeof bb.label !== "string") {
        throw new Error(`emu_device()'s buttons[${i}] ("${bb.id}") is missing a valid string "label": ${text}`);
      }
      if (bb.edge !== "left" && bb.edge !== "right" && bb.edge !== "top" && bb.edge !== "bottom") {
        throw new Error(`emu_device()'s buttons[${i}] ("${bb.id}") has an invalid "edge" (${jsonOf(bb.edge)}); must be one of left/right/top/bottom: ${text}`);
      }
      if (typeof bb.at !== "number" || !Number.isFinite(bb.at)) {
        throw new Error(`emu_device()'s buttons[${i}] ("${bb.id}") is missing a valid finite "at": ${text}`);
      }
    });
  }
  if (d.sensors !== undefined) {
    if (!Array.isArray(d.sensors))
      throw new Error(`emu_device()'s "sensors" must be an array: ${text}`);
    d.sensors.forEach((s, i) => {
      if (typeof s !== "object" || s === null)
        throw new Error(`emu_device()'s sensors[${i}] is not an object: ${text}`);
      const ss = s;
      if (typeof ss.id !== "string" || ss.id.length === 0) {
        throw new Error(`emu_device()'s sensors[${i}] is missing a valid string "id": ${text}`);
      }
      if (typeof ss.kind !== "string" || ss.kind.length === 0) {
        throw new Error(`emu_device()'s sensors[${i}] ("${ss.id}") is missing a valid string "kind": ${text}`);
      }
    });
  }
  if (d.apps !== undefined) {
    if (!Array.isArray(d.apps) || d.apps.some((a) => typeof a !== "string")) {
      throw new Error(`emu_device()'s "apps" must be an array of strings: ${text}`);
    }
  }
  if (d.gestures !== undefined) {
    if (!Array.isArray(d.gestures))
      throw new Error(`emu_device()'s "gestures" must be an array: ${text}`);
    d.gestures.forEach((g, i) => {
      if (typeof g !== "object" || g === null)
        throw new Error(`emu_device()'s gestures[${i}] is not an object: ${text}`);
      const gg = g;
      if (typeof gg.id !== "string" || gg.id.length === 0) {
        throw new Error(`emu_device()'s gestures[${i}] is missing a valid string "id": ${text}`);
      }
      if (typeof gg.label !== "string") {
        throw new Error(`emu_device()'s gestures[${i}] ("${gg.id}") is missing a valid string "label": ${text}`);
      }
      if (typeof gg.how !== "string") {
        throw new Error(`emu_device()'s gestures[${i}] ("${gg.id}") is missing a valid string "how": ${text}`);
      }
      if (gg.script !== undefined && !Array.isArray(gg.script)) {
        throw new Error(`emu_device()'s gestures[${i}] ("${gg.id}")'s "script" must be an array when present: ${text}`);
      }
    });
  }
  if (d.touch !== undefined) {
    if (typeof d.touch !== "object" || d.touch === null)
      throw new Error(`emu_device()'s "touch" must be an object: ${text}`);
    const t = d.touch;
    if (t.points !== undefined && (typeof t.points !== "number" || !Number.isFinite(t.points))) {
      throw new Error(`emu_device()'s "touch.points" must be a finite number when present: ${text}`);
    }
  }
  return d;
}
function readFramebufferPointer(emu, panel) {
  const fbPtr = emu.emu_fb();
  validateFbPtr(emu.memory, fbPtr, panel.w, panel.h);
  return fbPtr;
}

// src/panel.ts
function readPushes(emu, panelW, panelH) {
  const findings = [];
  const { count, reason: countReason } = validatePushCount(emu.emu_push_count());
  if (countReason)
    findings.push(countReason);
  const rects = [];
  for (let i = 0;i < count; i++) {
    const rect = { x: emu.emu_push_x(i), y: emu.emu_push_y(i), w: emu.emu_push_w(i), h: emu.emu_push_h(i) };
    const v = validatePushRect(rect, panelW, panelH);
    if (!v.ok) {
      findings.push(`push[${i}]: ${v.reason} -- not drawn`);
      continue;
    }
    rects.push(rect);
  }
  return { rects, findings };
}
function rgb565be(raw) {
  const v = (raw & 255) << 8 | raw >> 8 & 255;
  const r5 = v >> 11 & 31;
  const g6 = v >> 5 & 63;
  const b5 = v & 31;
  return [r5 << 3 | r5 >> 2, g6 << 2 | g6 >> 4, b5 << 3 | b5 >> 2];
}
function rgb565(raw) {
  const r5 = raw >> 11 & 31;
  const g6 = raw >> 5 & 63;
  const b5 = raw & 31;
  return [r5 << 3 | r5 >> 2, g6 << 2 | g6 >> 4, b5 << 3 | b5 >> 2];
}
var PIXEL_READERS = {
  rgb565be,
  rgb565
};
function pixelReaderFor(format) {
  const reader = PIXEL_READERS[format];
  if (!reader) {
    throw new Error(`unsupported panel pixel format "${format}" (this emulator implements: ${Object.keys(PIXEL_READERS).join(", ")}). ` + `Add a reader in src/panel.ts's PIXEL_READERS for your firmware's format.`);
  }
  return reader;
}
function readFramebufferRGB(memory, fbPtr, panelW, reader, rect) {
  const { x, y, w, h } = rect;
  const out = new Uint8Array(Math.max(0, w) * Math.max(0, h) * 3);
  if (w <= 0 || h <= 0)
    return out;
  const fb = new Uint16Array(memory.buffer, fbPtr, panelW * (y + h));
  let di = 0;
  for (let row = 0;row < h; row++) {
    const rowStart = (y + row) * panelW + x;
    for (let col = 0;col < w; col++) {
      const [r, g, b] = reader(fb[rowStart + col]);
      out[di] = r;
      out[di + 1] = g;
      out[di + 2] = b;
      di += 3;
    }
  }
  return out;
}
function blitRect(ctx, memory, fbPtr, panelW, reader, rect) {
  const { x, y, w, h } = rect;
  if (w <= 0 || h <= 0)
    return;
  const rgb = readFramebufferRGB(memory, fbPtr, panelW, reader, rect);
  const img = ctx.createImageData(w, h);
  for (let i = 0, di = 0;i < rgb.length; i += 3, di += 4) {
    img.data[di] = rgb[i];
    img.data[di + 1] = rgb[i + 1];
    img.data[di + 2] = rgb[i + 2];
    img.data[di + 3] = 255;
  }
  ctx.putImageData(img, x, y);
}
function blitAll(ctx, memory, fbPtr, panelW, panelH, reader) {
  blitRect(ctx, memory, fbPtr, panelW, reader, { x: 0, y: 0, w: panelW, h: panelH });
}

// src/constants.ts
var TOUCHSIM_DEFAULTS = {
  reportRateHz: 60,
  dropoutsEnabled: true,
  dropoutsPerSec: 2,
  straysEnabled: true,
  straysPerSec: 0.2
};
var TOUCH_DEFECTS_DEFAULT = false;
var PUSH_FADE_MS = 400;
var TRACE_MAX_EVENTS = 50000;

// src/overlay.ts
class PushOverlay {
  rects = [];
  enabled = true;
  lastCount = 0;
  lastWidth = 0;
  record(rects, nowMs) {
    if (rects.length > 0) {
      this.lastCount = rects.length;
      this.lastWidth = rects[rects.length - 1].w;
    }
    if (!this.enabled)
      return;
    for (const r of rects)
      this.rects.push({ ...r, bornAt: nowMs });
  }
  paint(ctx, nowMs, color) {
    if (!this.enabled) {
      this.rects.length = 0;
      return;
    }
    this.rects = this.rects.filter((r) => nowMs - r.bornAt < PUSH_FADE_MS);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    for (const r of this.rects) {
      const age = nowMs - r.bornAt;
      ctx.globalAlpha = Math.max(0, 1 - age / PUSH_FADE_MS);
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(r.w - 1, 0), Math.max(r.h - 1, 0));
    }
    ctx.globalAlpha = 1;
  }
}

// src/touchoverlay.ts
var CONTACT_PRESETS = [
  { id: "adult", mm: 8, label: "adult" },
  { id: "child", mm: 6, label: "child" }
];
var DEFAULT_PX_PER_MM = 12.7;
var TRAIL_FADE_MS = 1000;

class TouchOverlay {
  contactMm;
  pxPerMm;
  trail = [];
  down = false;
  downX = 0;
  downY = 0;
  hoverX = null;
  hoverY = null;
  constructor(contactMm = CONTACT_PRESETS[1].mm, pxPerMm = DEFAULT_PX_PER_MM) {
    this.contactMm = contactMm;
    this.pxPerMm = pxPerMm;
  }
  recordTouch(down, x, y, nowMs) {
    this.down = down;
    if (down) {
      this.downX = x;
      this.downY = y;
      this.trail.push({ x, y, t: nowMs });
      this.hoverX = null;
      this.hoverY = null;
    }
  }
  recordHover(x, y) {
    if (this.down)
      return;
    this.hoverX = x;
    this.hoverY = y;
  }
  paint(ctx, nowMs, color) {
    this.trail = this.trail.filter((p) => nowMs - p.t < TRAIL_FADE_MS);
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    for (let i = 1;i < this.trail.length; i++) {
      const a = this.trail[i - 1];
      const b = this.trail[i];
      const age = nowMs - b.t;
      ctx.globalAlpha = Math.max(0, 1 - age / TRAIL_FADE_MS) * 0.55;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const radiusPx = this.contactMm * this.pxPerMm / 2;
    if (this.down) {
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.3;
      ctx.arc(this.downX, this.downY, radiusPx, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.arc(this.downX, this.downY, 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (this.hoverX !== null && this.hoverY !== null) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.arc(this.hoverX, this.hoverY, radiusPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }
}

// src/rotate.ts
function clampRound(v, max) {
  return Math.max(0, Math.min(max - 1, Math.round(v)));
}
function mapClientPoint(clientX, clientY, canvas, quickDeg, tiltDeg, panelW, panelH) {
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = clientX - cx;
  const dy = clientY - cy;
  const totalDeg = quickDeg + tiltDeg;
  const theta = totalDeg * Math.PI / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const localDx = dx * cos + dy * sin;
  const localDy = -dx * sin + dy * cos;
  const cw = canvas.clientWidth || 1;
  const ch = canvas.clientHeight || 1;
  const panel = {
    x: clampRound((localDx + cw / 2) * panelW / cw, panelW),
    y: clampRound((localDy + ch / 2) * panelH / ch, panelH)
  };
  const quarterTurned = (Math.round(quickDeg / 90) % 2 + 2) % 2 === 1;
  const viewCssW = quarterTurned ? ch : cw;
  const viewCssH = quarterTurned ? cw : ch;
  const viewW = quarterTurned ? panelH : panelW;
  const viewH = quarterTurned ? panelW : panelH;
  const view = {
    x: clampRound((dx + viewCssW / 2) * viewW / viewCssW, viewW),
    y: clampRound((dy + viewCssH / 2) * viewH / viewCssH, viewH)
  };
  return { panel, view, viewW, viewH };
}
function gravityForQuickDeg(quickDeg) {
  const theta = quickDeg * Math.PI / 180;
  return { x: Math.sin(theta), y: Math.cos(theta), z: 0 };
}
function composeViewVectorWithQuickDeg(view, quickDeg) {
  const theta = quickDeg * Math.PI / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    x: view.x * cos + view.y * sin,
    y: -view.x * sin + view.y * cos,
    z: view.z
  };
}

// src/device.ts
function makeDraggable(bezel, wrapper, onDrag) {
  let dragging = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;
  bezel.addEventListener("pointerdown", (e) => {
    if (e.target !== bezel)
      return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = wrapper.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    bezel.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  bezel.addEventListener("pointermove", (e) => {
    if (!dragging)
      return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    wrapper.style.left = `${origLeft + dx}px`;
    wrapper.style.top = `${origTop + dy}px`;
    onDrag?.(e.clientX, e.clientY);
  });
  const stop = () => {
    dragging = false;
  };
  bezel.addEventListener("pointerup", stop);
  bezel.addEventListener("pointercancel", stop);
}
function wireButton(el, events, longPressMs) {
  let longFired = false;
  let longTimer = null;
  if (longPressMs !== undefined)
    el.style.setProperty("--hold-ms", `${longPressMs}ms`);
  function clearTimer() {
    if (longTimer) {
      clearTimeout(longTimer);
      longTimer = null;
    }
  }
  function down() {
    if (el.classList.contains("pressed"))
      return;
    longFired = false;
    el.classList.add("pressed");
    if (longPressMs !== undefined)
      el.classList.add("holding");
    events.onDown?.();
    if (longPressMs !== undefined) {
      longTimer = setTimeout(() => {
        longFired = true;
        el.classList.add("long");
        events.onVerdict?.(true);
      }, longPressMs);
    }
  }
  function up() {
    if (!el.classList.contains("pressed"))
      return;
    el.classList.remove("pressed", "long", "holding");
    clearTimer();
    events.onUp?.();
    if (!longFired)
      events.onVerdict?.(false);
  }
  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId);
    down();
    e.preventDefault();
  });
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  return { down, up };
}
var BTN_LENGTH_PX = 56;
var BTN_THICKNESS_PX = 14;
var BTN_OFFSET_PX = -8;
function createButtonElement(edge, at, bezelWidthPx, bezelHeightPx) {
  const el = document.createElement("div");
  el.className = `dev-btn edge-${edge}`;
  const clampedAt = Math.max(0, Math.min(1, at));
  if (edge === "left" || edge === "right") {
    const top = clampedAt * Math.max(0, bezelHeightPx - BTN_LENGTH_PX);
    el.style.top = `${top}px`;
    el.style.height = `${BTN_LENGTH_PX}px`;
    el.style.width = `${BTN_THICKNESS_PX}px`;
    el.style[edge] = `${BTN_OFFSET_PX}px`;
  } else {
    const left = clampedAt * Math.max(0, bezelWidthPx - BTN_LENGTH_PX);
    el.style.left = `${left}px`;
    el.style.width = `${BTN_LENGTH_PX}px`;
    el.style.height = `${BTN_THICKNESS_PX}px`;
    el.style[edge] = `${BTN_OFFSET_PX}px`;
  }
  return el;
}
function applyRotation(bezel, totalDeg, dx = 0, dy = 0) {
  bezel.style.transform = `translate(${dx}px, ${dy}px) rotate(${totalDeg}deg)`;
}

// src/shortcuts.ts
function isTypingTarget(target) {
  const el = target;
  if (!el)
    return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

class ShortcutRegistry {
  clicks = new Map;
  held = new Map;
  activeKeys = new Set;
  constructor() {
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));
  }
  clear() {
    this.clicks.clear();
    this.held.clear();
    this.activeKeys.clear();
  }
  bindClick(key, fn) {
    this.clicks.set(key.toLowerCase(), fn);
  }
  bindHeld(key, handlers) {
    this.held.set(key.toLowerCase(), handlers);
  }
  onKeyDown(e) {
    if (isTypingTarget(e.target))
      return;
    const key = e.key.toLowerCase();
    if (e.repeat)
      return;
    const heldFn = this.held.get(key);
    if (heldFn) {
      this.activeKeys.add(key);
      heldFn.down();
      e.preventDefault();
      return;
    }
    const clickFn = this.clicks.get(key);
    if (clickFn) {
      clickFn();
      e.preventDefault();
    }
  }
  onKeyUp(e) {
    const key = e.key.toLowerCase();
    const heldFn = this.held.get(key);
    if (heldFn && this.activeKeys.has(key)) {
      this.activeKeys.delete(key);
      heldFn.up();
    }
  }
}
function assignShortcut(id, used) {
  for (const ch of id.toLowerCase()) {
    if (/[a-z]/.test(ch) && !used.has(ch)) {
      used.add(ch);
      return ch;
    }
  }
  for (const ch of "123456789") {
    if (!used.has(ch)) {
      used.add(ch);
      return ch;
    }
  }
  for (let c = 97;c <= 122; c++) {
    const ch = String.fromCharCode(c);
    if (!used.has(ch)) {
      used.add(ch);
      return ch;
    }
  }
  return null;
}

// src/sensors.ts
function buildSensorControls(container, sensors, shortcuts, usedKeys, log, onFire, guardedCall) {
  container.innerHTML = "";
  const firers = new Map;
  sensors.forEach((sensor, index) => {
    if (sensor.kind !== "event")
      return;
    const fire = () => {
      guardedCall(`sensor[${index}] ("${sensor.id}")`, (liveEmu) => {
        liveEmu.emu_sensor_event(index);
        log(`sensor: ${sensor.id}`);
        onFire?.(sensor, index);
      });
    };
    firers.set(sensor.id.toLowerCase(), fire);
    const key = assignShortcut(sensor.id, usedKeys);
    const btn = document.createElement("button");
    btn.className = "btn sec sm sensor-btn";
    btn.textContent = sensor.label || sensor.id;
    if (key) {
      const kbd = document.createElement("span");
      kbd.className = "kbd";
      kbd.textContent = key.toUpperCase();
      btn.appendChild(kbd);
      shortcuts.bindClick(key, fire);
    }
    btn.addEventListener("click", fire);
    container.appendChild(btn);
  });
  return {
    fire(id) {
      const fn = firers.get(id.toLowerCase());
      if (!fn)
        return false;
      fn();
      return true;
    }
  };
}

// src/appstrip.ts
function buildAppStrip(container, apps, emu, guardedCall) {
  container.innerHTML = "";
  if (apps.length === 0 || typeof emu.emu_app_switch !== "function" || typeof emu.emu_app_current !== "function") {
    container.parentElement?.classList.add("hidden");
    return null;
  }
  container.parentElement?.classList.remove("hidden");
  const buttons = apps.map((name, i) => {
    const btn = document.createElement("button");
    btn.className = "btn sec sm app-strip-btn";
    btn.textContent = name;
    btn.addEventListener("click", () => {
      guardedCall(`app switch to ${i} ("${name}")`, (liveEmu) => liveEmu.emu_app_switch?.(i));
    });
    container.appendChild(btn);
    return btn;
  });
  function refresh() {
    const current = emu.emu_app_current?.() ?? -1;
    buttons.forEach((b, i) => b.classList.toggle("active", i === current));
  }
  refresh();
  return { refresh };
}

// src/consolelog.ts
class ConsoleLog {
  lines = [];
  max;
  onLine;
  constructor(max = 500, onLine) {
    this.max = max;
    this.onLine = onLine;
  }
  push(text) {
    const line = { t: performance.now(), text };
    this.lines.push(line);
    if (this.lines.length > this.max)
      this.lines.shift();
    console.log("[fw]", text);
    this.onLine?.(line);
  }
  recent(n) {
    return this.lines.slice(-n);
  }
}

// src/recorder.ts
class Recorder {
  events = [];
  enabled = true;
  record(ev) {
    if (!this.enabled)
      return;
    this.events.push(ev);
    if (this.events.length > TRACE_MAX_EVENTS)
      this.events.shift();
  }
  recent(n) {
    return this.events.slice(-n);
  }
  clear() {
    this.events.length = 0;
  }
  toTrace(device) {
    return {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      device,
      events: this.events.slice()
    };
  }
}

// src/replay.ts
class Replayer {
  events;
  index = 0;
  constructor(events) {
    this.events = events;
  }
  get done() {
    return this.index >= this.events.length;
  }
  get progress() {
    return { at: this.index, total: this.events.length };
  }
  reset() {
    this.index = 0;
  }
  stepFrame(emu) {
    while (this.index < this.events.length) {
      const ev = this.events[this.index++];
      switch (ev.k) {
        case "touch":
          emu.emu_touch(ev.down, ev.x, ev.y);
          break;
        case "button":
          emu.emu_button(ev.i, ev.down);
          break;
        case "verdict":
          emu.emu_button_verdict(ev.i, ev.long);
          break;
        case "sensor":
          emu.emu_sensor_event(ev.i);
          break;
        case "vector":
          emu.emu_sensor_vector?.(ev.i, ev.x, ev.y, ev.z);
          break;
        case "accel":
          emu.emu_accel_sample?.(ev.i, ev.t, ev.ax, ev.ay, ev.az);
          break;
        case "tick":
          emu.emu_tick(ev.t);
          return ev.t;
      }
    }
    return null;
  }
}

// src/journal.ts
var MARK_COLORS = {
  f: "#c0392b",
  q: "#2f6fb0",
  n: "#2f8f4f"
};
var MARK_LABELS = {
  f: "fix",
  q: "question",
  n: "new"
};
function emptyJournal() {
  return { strokes: [], notes: [] };
}

// src/freeze.ts
async function postFreeze(bundle, id) {
  try {
    const res = await fetch("/api/freeze", {
      method: "POST",
      headers: { "content-type": "application/json", "x-puck-emulator": "1" },
      body: JSON.stringify(id ? { ...bundle, id } : bundle)
    });
    if (!res.ok)
      return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };
    const data = await res.json();
    return { ok: true, id: data.id, path: data.path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function canvasToPngBase64(canvas) {
  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
function openAnnotationModal(panelDataUrl, panelW, panelH) {
  return new Promise((resolve) => {
    const scale = Math.min(3, Math.max(1, Math.floor(560 / panelW)));
    const w = panelW * scale;
    const h = panelH * scale;
    const overlayEl = document.createElement("div");
    overlayEl.className = "modalov";
    const box = document.createElement("div");
    box.className = "modalbox freeze-modal";
    overlayEl.appendChild(box);
    const title = document.createElement("div");
    title.className = "freeze-modal-title";
    title.innerHTML = '<b>annotate the freeze</b> <span class="hint">draw = mark, click type below, add a note, then save</span>';
    box.appendChild(title);
    const canvasWrap = document.createElement("div");
    canvasWrap.className = "freeze-canvas-wrap";
    canvasWrap.style.width = `${w}px`;
    canvasWrap.style.height = `${h}px`;
    box.appendChild(canvasWrap);
    const img = new Image;
    img.src = `data:image/png;base64,${panelDataUrl}`;
    img.className = "freeze-img";
    img.width = w;
    img.height = h;
    canvasWrap.appendChild(img);
    const inkCanvas = document.createElement("canvas");
    inkCanvas.width = w;
    inkCanvas.height = h;
    inkCanvas.className = "freeze-ink";
    canvasWrap.appendChild(inkCanvas);
    const ictx = inkCanvas.getContext("2d");
    const journal = emptyJournal();
    let nextId = 1;
    let currentType = "f";
    let drawing = false;
    let current = null;
    function redraw() {
      ictx.clearRect(0, 0, w, h);
      for (const s of journal.strokes) {
        if (s.points.length < 2)
          continue;
        ictx.strokeStyle = MARK_COLORS[s.type];
        ictx.lineWidth = 3;
        ictx.lineCap = "round";
        ictx.lineJoin = "round";
        ictx.beginPath();
        ictx.moveTo(s.points[0].x * scale, s.points[0].y * scale);
        for (const p of s.points.slice(1))
          ictx.lineTo(p.x * scale, p.y * scale);
        ictx.stroke();
      }
    }
    inkCanvas.addEventListener("pointerdown", (e) => {
      drawing = true;
      inkCanvas.setPointerCapture(e.pointerId);
      const rect = inkCanvas.getBoundingClientRect();
      current = { id: nextId++, type: currentType, points: [{ x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale }] };
      journal.strokes.push(current);
    });
    inkCanvas.addEventListener("pointermove", (e) => {
      if (!drawing || !current)
        return;
      const rect = inkCanvas.getBoundingClientRect();
      current.points.push({ x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale });
      redraw();
    });
    function stopDrawing() {
      drawing = false;
      current = null;
    }
    inkCanvas.addEventListener("pointerup", stopDrawing);
    inkCanvas.addEventListener("pointercancel", stopDrawing);
    const typeRow = document.createElement("div");
    typeRow.className = "segtog freeze-typetog";
    ["f", "q", "n"].forEach((t) => {
      const b = document.createElement("button");
      b.textContent = `${MARK_LABELS[t]}`;
      b.style.color = MARK_COLORS[t];
      if (t === currentType)
        b.classList.add("active");
      b.addEventListener("click", () => {
        currentType = t;
        typeRow.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      });
      typeRow.appendChild(b);
    });
    box.appendChild(typeRow);
    const notesList = document.createElement("div");
    notesList.className = "freeze-notes";
    box.appendChild(notesList);
    function renderNotes() {
      notesList.innerHTML = "";
      for (const n of journal.notes) {
        const row = document.createElement("div");
        row.className = "freeze-note-row";
        row.innerHTML = `<span class="pill" style="color:${MARK_COLORS[n.type]}">${MARK_LABELS[n.type]}</span> ${escapeHtml(n.text)}`;
        notesList.appendChild(row);
      }
    }
    const noteRow = document.createElement("div");
    noteRow.className = "freeze-note-add";
    const noteInput = document.createElement("input");
    noteInput.className = "control";
    noteInput.placeholder = "add a note...";
    const noteBtn = document.createElement("button");
    noteBtn.className = "btn sec sm";
    noteBtn.textContent = "add";
    noteBtn.addEventListener("click", () => {
      const text = noteInput.value.trim();
      if (!text)
        return;
      journal.notes.push({ id: nextId++, type: currentType, text });
      noteInput.value = "";
      renderNotes();
    });
    noteRow.appendChild(noteInput);
    noteRow.appendChild(noteBtn);
    box.appendChild(noteRow);
    const actions = document.createElement("div");
    actions.className = "freeze-modal-actions";
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn sm";
    saveBtn.textContent = "save annotations";
    const closeBtn = document.createElement("button");
    closeBtn.className = "btn sec sm";
    closeBtn.textContent = "close";
    actions.appendChild(closeBtn);
    actions.appendChild(saveBtn);
    box.appendChild(actions);
    function close(result) {
      overlayEl.remove();
      resolve(result);
    }
    saveBtn.addEventListener("click", () => close(journal));
    closeBtn.addEventListener("click", () => close(null));
    document.body.appendChild(overlayEl);
  });
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// src/replayCore.ts
async function replayFromBytes(bytes, events, capturePoints, options = {}) {
  const log = [];
  const emu = await instantiate(bytes, (text) => log.push(text), { seed: options.seed });
  if (emu.emu_init() === 0)
    throw new Error("emu_init() returned 0");
  const device = readDeviceDescriptor(emu);
  const reader = pixelReaderFor(device.panel.format);
  const fbPtr = emu.emu_fb();
  const remainingPoints = [...capturePoints].sort((a, b) => a - b);
  const frames = [];
  const tracksPushes = typeof emu.emu_push_count === "function";
  let pushTickCount = 0;
  let maxPushesPerTick = 0;
  let maxPushPixelsPerTick = 0;
  let sumPushPixelsPerTick = 0;
  function recordPushLoad() {
    if (!tracksPushes)
      return;
    const count = emu.emu_push_count();
    let pixels = 0;
    for (let i = 0;i < count; i++)
      pixels += emu.emu_push_w(i) * emu.emu_push_h(i);
    pushTickCount++;
    if (count > maxPushesPerTick)
      maxPushesPerTick = count;
    if (pixels > maxPushPixelsPerTick)
      maxPushPixelsPerTick = pixels;
    sumPushPixelsPerTick += pixels;
  }
  function captureNow(atMs) {
    const rgb = readFramebufferRGB(emu.memory, fbPtr, device.panel.w, reader, {
      x: 0,
      y: 0,
      w: device.panel.w,
      h: device.panel.h
    });
    frames.push({ atMs, frame: { width: device.panel.w, height: device.panel.h, rgb } });
  }
  for (const ev of events) {
    switch (ev.k) {
      case "touch":
        emu.emu_touch(ev.down, ev.x, ev.y);
        break;
      case "button":
        emu.emu_button(ev.i, ev.down);
        break;
      case "verdict":
        emu.emu_button_verdict(ev.i, ev.long);
        break;
      case "sensor":
        emu.emu_sensor_event(ev.i);
        break;
      case "vector":
        emu.emu_sensor_vector?.(ev.i, ev.x, ev.y, ev.z);
        break;
      case "accel":
        emu.emu_accel_sample?.(ev.i, ev.t, ev.ax, ev.ay, ev.az);
        break;
      case "tick":
        emu.emu_tick(ev.t);
        recordPushLoad();
        while (remainingPoints.length > 0 && remainingPoints[0] <= ev.t) {
          captureNow(remainingPoints.shift());
        }
        break;
    }
  }
  for (const p of remainingPoints)
    captureNow(p);
  const pushStats = tracksPushes ? {
    tickCount: pushTickCount,
    maxPushesPerTick,
    maxPushPixelsPerTick,
    meanPushPixelsPerTick: pushTickCount > 0 ? sumPushPixelsPerTick / pushTickCount : 0
  } : undefined;
  const arena = typeof emu.emu_arena_used === "function" && typeof emu.emu_arena_capacity === "function" ? { usedBytes: emu.emu_arena_used(), capacityBytes: emu.emu_arena_capacity() } : undefined;
  return { device, frames, log, pushStats, arena };
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

// src/regression.ts
var BASE64_CHUNK = 32768;
function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0;i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0;i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function pickCapturePoints(tickTimes, max) {
  if (tickTimes.length === 0)
    return [];
  if (tickTimes.length <= max)
    return [...tickTimes];
  const points = [];
  const step = (tickTimes.length - 1) / (max - 1);
  for (let i = 0;i < max; i++) {
    points.push(tickTimes[Math.round(i * step)]);
  }
  return [...new Set(points)];
}
var DEFAULT_MAX_CAPTURE_POINTS = 8;
async function captureBaseline(wasmBytes, events, maxCapturePoints = DEFAULT_MAX_CAPTURE_POINTS) {
  const tickTimes = events.filter((e) => e.k === "tick").map((e) => e.t);
  const capturePoints = pickCapturePoints(tickTimes, maxCapturePoints);
  if (capturePoints.length === 0) {
    throw new Error("nothing to baseline: the recorded trace has no tick events yet");
  }
  const replay = await replayFromBytes(wasmBytes, events, capturePoints);
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    device: replay.device,
    events,
    capturePoints,
    frames: replay.frames.map((f) => ({ atMs: f.atMs, width: f.frame.width, height: f.frame.height, rgbBase64: bytesToBase64(f.frame.rgb) }))
  };
}
async function checkAgainstBaseline(wasmBytes, baseline, tolerance = 0) {
  const replay = await replayFromBytes(wasmBytes, baseline.events, baseline.capturePoints);
  const baselineFrames = baseline.frames.map((f) => ({ atMs: f.atMs, frame: { width: f.width, height: f.height, rgb: base64ToBytes(f.rgbBase64) } }));
  const byAtMs = new Map(baselineFrames.map((f) => [f.atMs, f.frame]));
  const points = [];
  const diffImages = [];
  for (const cur of replay.frames) {
    const base = byAtMs.get(cur.atMs);
    if (!base) {
      points.push({ atMs: cur.atMs, match: false, diffPixels: -1, totalPixels: cur.frame.width * cur.frame.height, firstDiffAt: null, maxChannelDelta: 255 });
      continue;
    }
    const d = compareFrames(base, cur.frame, tolerance);
    points.push({ atMs: cur.atMs, match: d.match, diffPixels: d.diffPixels, totalPixels: d.totalPixels, firstDiffAt: d.firstDiffAt, maxChannelDelta: d.maxChannelDelta });
    if (!d.match && d.diffImage)
      diffImages.push({ atMs: cur.atMs, rgb: d.diffImage });
  }
  return { pass: points.length > 0 && points.every((p) => p.match), points, baselineFrames, currentFrames: replay.frames, diffImages };
}
function toRegressionResultPayload(baseline, check) {
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    pass: check.pass,
    device: baseline.device,
    input: baseline.events,
    points: check.points,
    diverged: check.points.filter((p) => !p.match).map((p) => {
      const base = check.baselineFrames.find((f) => f.atMs === p.atMs).frame;
      const cur = check.currentFrames.find((f) => f.atMs === p.atMs).frame;
      const diff = check.diffImages.find((d) => d.atMs === p.atMs);
      return {
        atMs: p.atMs,
        width: cur.width,
        height: cur.height,
        baselineRgbBase64: bytesToBase64(base.rgb),
        currentRgbBase64: bytesToBase64(cur.rgb),
        diffRgbBase64: diff ? bytesToBase64(diff.rgb) : null
      };
    })
  };
}
function frameCanvas(frame) {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(frame.width, frame.height);
  for (let i = 0, di = 0;i < frame.rgb.length; i += 3, di += 4) {
    img.data[di] = frame.rgb[i];
    img.data[di + 1] = frame.rgb[i + 1];
    img.data[di + 2] = frame.rgb[i + 2];
    img.data[di + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
function frameThumb(frame, label) {
  const wrap = document.createElement("div");
  wrap.className = "regression-thumb";
  wrap.appendChild(frameCanvas(frame));
  const cap = document.createElement("div");
  cap.className = "regression-thumb-label";
  cap.textContent = label;
  wrap.appendChild(cap);
  return wrap;
}
function openRegressionModal(check) {
  return new Promise((resolve) => {
    const overlayEl = document.createElement("div");
    overlayEl.className = "modalov";
    const box = document.createElement("div");
    box.className = "modalbox regression-modal";
    overlayEl.appendChild(box);
    const failCount = check.points.filter((p) => !p.match).length;
    const title = document.createElement("div");
    title.className = "regression-modal-title";
    title.innerHTML = check.pass ? `<b>regression check: pass</b> <span class="hint">${check.points.length} capture point(s), against the emulator only - see docs/harness.md</span>` : `<b>regression check: ${failCount}/${check.points.length} capture point(s) diverged</b>`;
    box.appendChild(title);
    for (const p of check.points) {
      const row = document.createElement("div");
      row.className = "regression-row";
      const label = document.createElement("span");
      label.className = `pill status ${p.match ? "ok" : "fail"}`;
      label.textContent = p.match ? `t=${p.atMs}ms match` : `t=${p.atMs}ms  ${p.diffPixels}/${p.totalPixels}px`;
      row.appendChild(label);
      if (!p.match) {
        const base = check.baselineFrames.find((f) => f.atMs === p.atMs);
        const cur = check.currentFrames.find((f) => f.atMs === p.atMs);
        const diff = check.diffImages.find((d) => d.atMs === p.atMs);
        const imgs = document.createElement("div");
        imgs.className = "regression-imgs";
        if (base)
          imgs.appendChild(frameThumb(base.frame, "baseline"));
        if (cur)
          imgs.appendChild(frameThumb(cur.frame, "current"));
        if (diff && cur)
          imgs.appendChild(frameThumb({ width: cur.frame.width, height: cur.frame.height, rgb: diff.rgb }, "diff"));
        row.appendChild(imgs);
      }
      box.appendChild(row);
    }
    const actions = document.createElement("div");
    actions.className = "regression-modal-actions";
    const closeBtn = document.createElement("button");
    closeBtn.className = "btn sec sm";
    closeBtn.textContent = "close";
    closeBtn.addEventListener("click", () => {
      overlayEl.remove();
      resolve();
    });
    actions.appendChild(closeBtn);
    box.appendChild(actions);
    document.body.appendChild(overlayEl);
  });
}

// src/touchsim.ts
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

class TouchSim {
  cfg;
  panelW;
  panelH;
  realDown = false;
  realX = 0;
  realY = 0;
  repFingers = 0;
  repX = 0;
  repY = 0;
  nextReportAt = 0;
  simDropouts = 0;
  simStrays = 0;
  constructor(cfg, panelW, panelH) {
    this.cfg = cfg;
    this.panelW = panelW;
    this.panelH = panelH;
  }
  setBounds(panelW, panelH) {
    this.panelW = panelW;
    this.panelH = panelH;
  }
  setPointer(down, x, y) {
    this.realDown = down;
    this.realX = clamp(x, 0, this.panelW - 1);
    this.realY = clamp(y, 0, this.panelH - 1);
  }
  resetStats() {
    this.simDropouts = 0;
    this.simStrays = 0;
  }
  poll(nowMs) {
    const periodMs = 1000 / Math.max(1, this.cfg.reportRateHz);
    if (nowMs >= this.nextReportAt) {
      this.nextReportAt = nowMs + periodMs;
      this.refresh(periodMs / 1000);
    }
    return { fingers: this.repFingers, x: this.repX, y: this.repY };
  }
  refresh(periodSec) {
    if (this.realDown) {
      if (this.cfg.dropoutsEnabled && Math.random() < this.cfg.dropoutsPerSec * periodSec) {
        this.repFingers = 0;
        this.simDropouts++;
        return;
      }
      this.repFingers = 1;
      this.repX = this.realX;
      this.repY = this.realY;
      return;
    }
    if (this.cfg.straysEnabled && Math.random() < this.cfg.straysPerSec * periodSec) {
      const jitter = 40;
      this.repFingers = 1;
      this.repX = clamp(this.repX + (Math.random() * 2 - 1) * jitter, 0, this.panelW - 1);
      this.repY = clamp(this.repY + (Math.random() * 2 - 1) * jitter, 0, this.panelH - 1);
      this.simStrays++;
      return;
    }
    this.repFingers = 0;
  }
}

// src/windowshake.ts
var WINDOW_SHAKE_DEFAULTS = {
  joltDevPx: 12,
  joltWindowMs: 700,
  joltMinCount: 4,
  cooldownMs: 1200
};
var JOLT_MAX = 16;

class WindowShakeDetector {
  cfg;
  lastJoltCount = 0;
  lastX = null;
  lastY = null;
  lastDirX = 0;
  lastDirY = 0;
  joltTimes = [];
  cooldownUntil = 0;
  constructor(cfg = WINDOW_SHAKE_DEFAULTS) {
    this.cfg = cfg;
  }
  poll(screenX, screenY, nowMs, suppressed) {
    if (this.lastX === null || this.lastY === null) {
      this.lastX = screenX;
      this.lastY = screenY;
      return false;
    }
    const dx = screenX - this.lastX;
    const dy = screenY - this.lastY;
    this.lastX = screenX;
    this.lastY = screenY;
    const dirX = Math.sign(dx);
    const dirY = Math.sign(dy);
    const dist = Math.hypot(dx, dy);
    const reversed = dirX !== 0 && dirX === -this.lastDirX || dirY !== 0 && dirY === -this.lastDirY;
    if (dirX !== 0)
      this.lastDirX = dirX;
    if (dirY !== 0)
      this.lastDirY = dirY;
    if (reversed && dist >= this.cfg.joltDevPx) {
      this.joltTimes = this.joltTimes.filter((t) => nowMs - t <= this.cfg.joltWindowMs);
      this.joltTimes.push(nowMs);
      if (this.joltTimes.length > JOLT_MAX)
        this.joltTimes.shift();
    } else {
      this.joltTimes = this.joltTimes.filter((t) => nowMs - t <= this.cfg.joltWindowMs);
    }
    this.lastJoltCount = this.joltTimes.length;
    if (this.joltTimes.length >= this.cfg.joltMinCount && nowMs >= this.cooldownUntil && !suppressed) {
      this.cooldownUntil = nowMs + this.cfg.cooldownMs;
      this.joltTimes = [];
      this.lastJoltCount = 0;
      return true;
    }
    return false;
  }
}

// src/puckmotion.ts
function clamp2(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

class PuckMotion {
  offsetX = 0;
  offsetY = 0;
  lastNow = null;
  lastWinX = 0;
  lastWinY = 0;
  velX = 0;
  velY = 0;
  stiffness = 140;
  damping = 12;
  dragGain = 0.12;
  maxOffset = 26;
  tick(screenX, screenY, nowMs) {
    if (this.lastNow === null) {
      this.lastNow = nowMs;
      this.lastWinX = screenX;
      this.lastWinY = screenY;
      return;
    }
    const dtSec = clamp2((nowMs - this.lastNow) / 1000, 0, 0.05);
    this.lastNow = nowMs;
    const winVx = dtSec > 0 ? (screenX - this.lastWinX) / dtSec : 0;
    const winVy = dtSec > 0 ? (screenY - this.lastWinY) / dtSec : 0;
    this.lastWinX = screenX;
    this.lastWinY = screenY;
    const targetX = clamp2(-winVx * this.dragGain, -this.maxOffset, this.maxOffset);
    const targetY = clamp2(-winVy * this.dragGain, -this.maxOffset, this.maxOffset);
    const ax = (targetX - this.offsetX) * this.stiffness - this.velX * this.damping;
    const ay = (targetY - this.offsetY) * this.stiffness - this.velY * this.damping;
    this.velX += ax * dtSec;
    this.velY += ay * dtSec;
    this.offsetX += this.velX * dtSec;
    this.offsetY += this.velY * dtSec;
  }
  impulse(dx, dy) {
    this.velX += dx;
    this.velY += dy;
  }
}

// src/audio.ts
class SoundPlayer {
  ctx = null;
  currentNode = null;
  gain = null;
  lastPlaySeq = -1;
  lastStopSeq = -1;
  loggedOnce = false;
  muted = false;
  get status() {
    if (this.currentNode)
      return "playing";
    if (!this.ctx || this.ctx.state === "suspended")
      return "suspended";
    return "idle";
  }
  ensureContext(onFirstUnlock) {
    if (!this.ctx) {
      this.ctx = new AudioContext;
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended")
      this.ctx.resume();
    if (!this.loggedOnce) {
      this.loggedOnce = true;
      onFirstUnlock("sound: same samples the firmware plays, judge the tune here; a real speaker is tiny and will change how it sounds, judge that on hardware");
    }
  }
  poll(emu, onFinding) {
    if (!emu.emu_sound_play_seq || !emu.emu_sound_stop_seq)
      return;
    const stopSeq = emu.emu_sound_stop_seq();
    if (stopSeq !== this.lastStopSeq) {
      this.lastStopSeq = stopSeq;
      this.stopCurrent();
    }
    const playSeq = emu.emu_sound_play_seq();
    if (playSeq !== this.lastPlaySeq) {
      this.lastPlaySeq = playSeq;
      this.play(emu, onFinding);
    }
  }
  resetForReload(emu) {
    this.stopCurrent();
    this.lastPlaySeq = emu.emu_sound_play_seq ? emu.emu_sound_play_seq() : -1;
    this.lastStopSeq = emu.emu_sound_stop_seq ? emu.emu_sound_stop_seq() : -1;
  }
  toggleMute() {
    this.muted = !this.muted;
    if (this.gain)
      this.gain.gain.value = this.muted ? 0 : 1;
    return this.muted;
  }
  stopCurrent() {
    if (this.currentNode) {
      try {
        this.currentNode.stop();
      } catch {}
      this.currentNode = null;
    }
  }
  play(emu, onFinding) {
    if (!this.ctx || !this.gain || this.ctx.state === "suspended")
      return;
    if (!emu.emu_sound_sample_rate || !emu.emu_sound_buffer || !emu.emu_sound_frames)
      return;
    const frameCount = emu.emu_sound_frames();
    const sampleRate = emu.emu_sound_sample_rate();
    const framesPtr = emu.emu_sound_buffer();
    const v = validateAudioBuffer(emu.memory, framesPtr, frameCount, sampleRate);
    if (!v.ok) {
      onFinding?.(`firmware bug: ${v.reason} -- sound_play() call ignored`);
      return;
    }
    const int16 = new Int16Array(emu.memory.buffer, framesPtr, frameCount);
    const buffer = this.ctx.createBuffer(1, frameCount, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0;i < frameCount; i++)
      channel[i] = int16[i] / 32768;
    this.stopCurrent();
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    node.addEventListener("ended", () => {
      if (this.currentNode === node)
        this.currentNode = null;
    });
    node.start();
    this.currentNode = node;
  }
}

// src/motion.ts
var STANDARD_GRAVITY = 9.80665;
var FILTER_TAU_MS = 200;
var SHAKE_THRESHOLD_G = 2.5;
var SHAKE_SAMPLES = 3;
var SHAKE_COOLDOWN_MS = 800;
function motionApisAvailable() {
  return window.DeviceMotionEvent !== undefined || window.DeviceOrientationEvent !== undefined;
}
function isTouchCapable() {
  const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return coarse || navigator.maxTouchPoints > 0;
}
function permissionRequesters() {
  const out = [];
  const orientation = window.DeviceOrientationEvent;
  const motion = window.DeviceMotionEvent;
  if (typeof orientation?.requestPermission === "function")
    out.push(() => orientation.requestPermission());
  if (typeof motion?.requestPermission === "function")
    out.push(() => motion.requestPermission());
  return out;
}
function isIOSSafariMotion() {
  return permissionRequesters().length > 0;
}
function mapAccelerationToVector(x, y, z, isIOS) {
  return isIOS ? { x: x / STANDARD_GRAVITY, y: -y / STANDARD_GRAVITY, z: z / STANDARD_GRAVITY } : { x: -x / STANDARD_GRAVITY, y: -y / STANDARD_GRAVITY, z: -z / STANDARD_GRAVITY };
}
function deviceOrientationToAbiGravity(betaDeg, gammaDeg) {
  const beta = betaDeg * Math.PI / 180;
  const gamma = gammaDeg * Math.PI / 180;
  return {
    x: Math.sin(gamma) * Math.cos(beta),
    y: Math.sin(beta),
    z: -Math.cos(beta) * Math.cos(gamma)
  };
}
function composePhoneVector(deviceVector, screenDeg, quickDeg) {
  const theta = screenDeg * Math.PI / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const view = {
    x: deviceVector.x * cos - deviceVector.y * sin,
    y: deviceVector.x * sin + deviceVector.y * cos,
    z: deviceVector.z
  };
  return composeViewVectorWithQuickDeg(view, quickDeg);
}
function screenOrientationDeg() {
  const modern = screen.orientation?.angle;
  if (typeof modern === "number")
    return modern;
  const legacy = window.orientation;
  return typeof legacy === "number" ? legacy : 0;
}

class PhoneMotion {
  opts;
  chip = null;
  hasShake = false;
  active = false;
  blocked = false;
  listening = false;
  filtered = null;
  latest = null;
  lastMotionTimestamp = null;
  motionReadingSeen = false;
  lastOrientation = null;
  raf = 0;
  shakeSamples = 0;
  shakeCooldownUntil = 0;
  constructor(opts) {
    this.opts = opts;
  }
  isActive() {
    return this.active;
  }
  onDeviceChanged(hasVector, hasShake, hasAccelStream) {
    this.hasShake = hasShake;
    const eligible = this.opts.embed && (hasVector || hasAccelStream) && motionApisAvailable() && isTouchCapable();
    if (!eligible) {
      this.unmount();
      return;
    }
    if (!this.chip)
      this.mount();
    if (this.active) {
      this.resumeIfVisible();
      this.scheduleFlush();
    }
  }
  onQuickRotationChanged() {
    if (this.active)
      this.scheduleFlush();
  }
  mount() {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.id = "motionChip";
    chip.className = "motion-chip chrome-btn";
    chip.dataset.state = this.blocked ? "blocked" : "idle";
    chip.textContent = this.blocked ? "tilt blocked in Safari settings" : "tilt with your phone";
    chip.disabled = this.blocked;
    chip.addEventListener("click", this.onChipClick);
    (this.opts.mountTo ? this.opts.mountTo() : this.opts.stage).appendChild(chip);
    this.opts.stage.classList.add("motion-available");
    this.chip = chip;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    this.opts.onLayoutChanged();
  }
  unmount() {
    const wasActive = this.active;
    this.active = false;
    this.suspend();
    if (this.chip) {
      this.chip.removeEventListener("click", this.onChipClick);
      this.chip.remove();
      this.chip = null;
    }
    this.opts.stage.classList.remove("motion-available");
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    if (wasActive)
      this.opts.onOwnershipReleased();
    this.opts.onLayoutChanged();
  }
  onChipClick = () => {
    if (this.blocked)
      return;
    if (this.active) {
      this.stop();
      return;
    }
    const requesters = permissionRequesters();
    if (requesters.length === 0) {
      this.start();
      return;
    }
    let requests;
    try {
      requests = requesters.map((request) => request());
    } catch {
      this.block();
      return;
    }
    if (this.chip) {
      this.chip.textContent = "requesting phone tilt...";
      this.chip.disabled = true;
    }
    Promise.all(requests).then((results) => {
      if (results.every((result) => result === "granted"))
        this.start();
      else
        this.block();
    }, () => this.block());
  };
  start() {
    this.active = true;
    if (this.chip) {
      this.chip.dataset.state = "active";
      this.chip.textContent = "phone tilt on";
      this.chip.disabled = false;
      this.chip.classList.add("active");
    }
    this.resumeIfVisible();
  }
  stop() {
    this.active = false;
    this.suspend();
    if (this.chip) {
      this.chip.dataset.state = "idle";
      this.chip.textContent = "tilt with your phone";
      this.chip.classList.remove("active");
    }
    this.opts.onOwnershipReleased();
  }
  block() {
    this.active = false;
    this.blocked = true;
    this.suspend();
    if (this.chip) {
      this.chip.dataset.state = "blocked";
      this.chip.textContent = "tilt blocked in Safari settings";
      this.chip.classList.remove("active");
      this.chip.disabled = true;
    }
  }
  resumeIfVisible() {
    if (!this.active || document.visibilityState === "hidden" || this.listening)
      return;
    window.addEventListener("devicemotion", this.onDeviceMotion);
    window.addEventListener("deviceorientation", this.onDeviceOrientation);
    this.listening = true;
  }
  suspend() {
    if (this.listening) {
      window.removeEventListener("devicemotion", this.onDeviceMotion);
      window.removeEventListener("deviceorientation", this.onDeviceOrientation);
      this.listening = false;
    }
    if (this.raf)
      cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.filtered = null;
    this.latest = null;
    this.lastMotionTimestamp = null;
    this.motionReadingSeen = false;
    this.lastOrientation = null;
    this.shakeSamples = 0;
  }
  onVisibilityChange = () => {
    if (document.visibilityState === "hidden")
      this.suspend();
    else
      this.resumeIfVisible();
  };
  onPageHide = () => this.suspend();
  onPageShow = () => this.resumeIfVisible();
  onDeviceMotion = (event) => {
    const raw = event.accelerationIncludingGravity;
    if (raw && raw.x !== null && raw.y !== null && raw.z !== null) {
      this.motionReadingSeen = true;
      const mapped = mapAccelerationToVector(raw.x, raw.y, raw.z, isIOSSafariMotion());
      this.opts.sendAccel(mapped.x, mapped.y, mapped.z, event.timeStamp, "phone tilt");
      this.ingestMotion(mapped, event.timeStamp);
    } else if (this.lastOrientation) {
      this.ingestGravity(this.lastOrientation, event.timeStamp);
    }
  };
  onDeviceOrientation = (event) => {
    if (event.beta === null || event.gamma === null)
      return;
    this.lastOrientation = deviceOrientationToAbiGravity(event.beta, event.gamma);
    if (!this.motionReadingSeen)
      this.ingestGravity(this.lastOrientation, event.timeStamp);
  };
  ingestMotion(raw, timestamp) {
    this.ingestGravity(raw, timestamp);
    if (!this.filtered)
      return;
    const highPass = Math.hypot(raw.x - this.filtered.x, raw.y - this.filtered.y, raw.z - this.filtered.z);
    if (highPass >= SHAKE_THRESHOLD_G)
      this.shakeSamples++;
    else
      this.shakeSamples = 0;
    const now = performance.now();
    if (this.hasShake && this.shakeSamples >= SHAKE_SAMPLES && now >= this.shakeCooldownUntil) {
      this.shakeCooldownUntil = now + SHAKE_COOLDOWN_MS;
      this.shakeSamples = 0;
      this.opts.fireShake(now, "phone shake");
    }
  }
  ingestGravity(raw, timestamp) {
    if (!this.filtered) {
      this.filtered = { ...raw };
    } else {
      const elapsed = this.lastMotionTimestamp === null ? 16.7 : timestamp - this.lastMotionTimestamp;
      const dt = Math.max(1, Math.min(250, Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 16.7));
      const alpha = dt / (FILTER_TAU_MS + dt);
      this.filtered.x += alpha * (raw.x - this.filtered.x);
      this.filtered.y += alpha * (raw.y - this.filtered.y);
      this.filtered.z += alpha * (raw.z - this.filtered.z);
    }
    this.lastMotionTimestamp = timestamp;
    this.latest = { ...this.filtered };
    this.scheduleFlush();
  }
  scheduleFlush() {
    if (!this.active || !this.latest || this.raf)
      return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.active || !this.latest || document.visibilityState === "hidden")
        return;
      const panel = composePhoneVector(this.latest, screenOrientationDeg(), this.opts.getQuickDeg());
      this.opts.sendVector(panel.x, panel.y, panel.z, "phone tilt");
    });
  }
}
var EXCLUDED_SELECTOR = ".panel, .embed-controls, .dev-btn";
var DRAG_TILT_RADIUS_FRACTION = 0.35;
var DRAG_MAX_TILT_DEG = 60;
var DRAG_SPRING_MS = 200;
function clamp3(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function easeOutCubic(t) {
  const u = 1 - t;
  return 1 - u * u * u;
}

class DragMotion {
  opts;
  capturing = false;
  activePointerId = null;
  startX = 0;
  startY = 0;
  offsetX = 0;
  offsetY = 0;
  boundLeft = 0;
  boundRight = 0;
  boundTop = 0;
  boundBottom = 0;
  tiltRadiusPx = 1;
  lastVector = { x: 0, y: 1, z: 0 };
  springRaf = 0;
  constructor(opts) {
    this.opts = opts;
    opts.stage.addEventListener("pointerdown", this.onPointerDown);
    opts.stage.addEventListener("pointermove", this.onPointerMove);
    opts.stage.addEventListener("pointerup", this.onPointerUp);
    opts.stage.addEventListener("pointercancel", this.onPointerUp);
  }
  baselineVector() {
    return composeViewVectorWithQuickDeg({ x: 0, y: 1, z: 0 }, this.opts.getQuickDeg());
  }
  onPointerDown = (e) => {
    if (e.target instanceof Element && e.target.closest(EXCLUDED_SELECTOR))
      return;
    if (isTouchCapable())
      return;
    if (!this.opts.isEligible() || !(this.opts.hasVector() || this.opts.hasShake() || this.opts.hasAccelStream()))
      return;
    if (this.springRaf) {
      cancelAnimationFrame(this.springRaf);
      this.springRaf = 0;
    }
    const stageRect = this.opts.stage.getBoundingClientRect();
    const bezelRect = this.opts.bezel.getBoundingClientRect();
    this.boundLeft = Math.max(0, bezelRect.left - stageRect.left);
    this.boundRight = Math.max(0, stageRect.right - bezelRect.right);
    this.boundTop = Math.max(0, bezelRect.top - stageRect.top);
    this.boundBottom = Math.max(0, stageRect.bottom - bezelRect.bottom);
    this.tiltRadiusPx = Math.max(1, Math.min(bezelRect.width, bezelRect.height) * DRAG_TILT_RADIUS_FRACTION);
    this.capturing = true;
    this.activePointerId = e.pointerId;
    this.startX = e.clientX;
    this.startY = e.clientY;
    document.documentElement.classList.add("dm-dragging");
    this.opts.stage.setPointerCapture(e.pointerId);
    e.stopImmediatePropagation();
    e.preventDefault();
    this.updateFromClient(e.clientX, e.clientY, performance.now());
  };
  onPointerMove = (e) => {
    if (!this.capturing || e.pointerId !== this.activePointerId)
      return;
    e.stopImmediatePropagation();
    this.updateFromClient(e.clientX, e.clientY, performance.now());
  };
  onPointerUp = (e) => {
    if (!this.capturing || e.pointerId !== this.activePointerId)
      return;
    e.stopImmediatePropagation();
    this.capturing = false;
    this.activePointerId = null;
    document.documentElement.classList.remove("dm-dragging");
    this.springBack();
  };
  updateFromClient(clientX, clientY, now) {
    const dx = clientX - this.startX;
    const dy = clientY - this.startY;
    this.offsetX = clamp3(dx, -this.boundLeft, this.boundRight);
    this.offsetY = clamp3(dy, -this.boundTop, this.boundBottom);
    this.opts.onOffsetChanged(this.offsetX, this.offsetY);
    if (this.opts.hasVector() || this.opts.hasAccelStream()) {
      const dist = Math.hypot(this.offsetX, this.offsetY);
      const ux = dist > 0 ? this.offsetX / dist : 0;
      const uy = dist > 0 ? this.offsetY / dist : 0;
      const ratio = Math.min(dist, this.tiltRadiusPx) / this.tiltRadiusPx;
      const tilt = ratio * DRAG_MAX_TILT_DEG * Math.PI / 180;
      const view = { x: Math.sin(tilt) * ux, y: Math.cos(tilt), z: Math.sin(tilt) * uy };
      this.lastVector = composeViewVectorWithQuickDeg(view, this.opts.getQuickDeg());
      if (this.opts.hasVector())
        this.opts.sendVector(this.lastVector.x, this.lastVector.y, this.lastVector.z, "drag tilt");
      if (this.opts.hasAccelStream())
        this.opts.sendAccel(this.lastVector.x, this.lastVector.y, this.lastVector.z, now, "drag tilt");
    }
    if (this.opts.hasShake() && this.opts.pollDragShake(clientX, clientY, now, false)) {
      this.opts.fireShake(now, "drag shake");
    }
  }
  springBack() {
    const fromX = this.offsetX;
    const fromY = this.offsetY;
    const fromVector = this.lastVector;
    const toVector = this.baselineVector();
    const start = performance.now();
    const step = (now) => {
      const t = clamp3((now - start) / DRAG_SPRING_MS, 0, 1);
      const eased = easeOutCubic(t);
      this.offsetX = lerp(fromX, 0, eased);
      this.offsetY = lerp(fromY, 0, eased);
      this.opts.onOffsetChanged(this.offsetX, this.offsetY);
      if (this.opts.hasVector() || this.opts.hasAccelStream()) {
        this.lastVector = {
          x: lerp(fromVector.x, toVector.x, eased),
          y: lerp(fromVector.y, toVector.y, eased),
          z: lerp(fromVector.z, toVector.z, eased)
        };
        if (this.opts.hasVector())
          this.opts.sendVector(this.lastVector.x, this.lastVector.y, this.lastVector.z, "drag tilt release");
        if (this.opts.hasAccelStream())
          this.opts.sendAccel(this.lastVector.x, this.lastVector.y, this.lastVector.z, now, "drag tilt release");
      }
      if (t < 1) {
        this.springRaf = requestAnimationFrame(step);
      } else {
        this.springRaf = 0;
      }
    };
    this.springRaf = requestAnimationFrame(step);
  }
}

// src/main.ts
var $ = (sel) => document.querySelector(sel);
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}
function escapeHtml2(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
var bezelEl = $("#bezel");
var deviceWrapEl = $("#deviceWrap");
var panelEl = $("#panel");
var overlayEl = $("#overlay");
var panelCtx = panelEl.getContext("2d", { willReadFrequently: true });
var overlayCtx = overlayEl.getContext("2d");
var wasmErrorEl = $("#wasmError");
var engineDeadEl = $("#engineDead");
var consolePaneEl = $("#consolePane");
var diagStripEl = $("#diagStrip");
var replayBarEl = $("#replayBar");
var btnStopReplay = $("#btnStopReplay");
var btnPause = $("#btnPause");
var stageEl = $("#stage");
var ROTATE_ICON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline>' + '<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';
var SHAKE_ICON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' + '<path d="M0 15h2V9H0v6zm3 2h2V7H3v10zm19-8v6h2V9h-2zm-3 10h2V7h-2v10zM16.5 3h-9C6.67 3 6 3.67 6 4.5v15c0 .83.67 1.5 1.5 1.5h9c.83 0 1.5-.67 1.5-1.5v-15c0-.83-.67-1.5-1.5-1.5zM16 19H8V5h8v14z"></path></svg>';
var WASM_URL = new URLSearchParams(location.search).get("module") || DEFAULT_WASM_URL;
var EMBED = new URLSearchParams(location.search).get("embed") === "1";
var emu = null;
var wasmBytes = null;
var device = null;
var panelW = 0;
var panelH = 0;
var fbPtr = 0;
var pixelReader = null;
var touchEnabled = false;
var accentColor = "#c4621f";
var recorder = new Recorder;
var consoleLog = new ConsoleLog(500, appendConsoleLine);
var pushOverlay = new PushOverlay;
pushOverlay.enabled = false;
var touchOverlay = new TouchOverlay;
var shortcuts = new ShortcutRegistry;
var windowShake = new WindowShakeDetector;
var puckDragShake = new WindowShakeDetector;
var puckMotion = new PuckMotion;
var soundPlayer = new SoundPlayer;
var shakeSensorIndex = -1;
var vectorSensorIndices = [];
var streamSensorIndices = [];
var centeredOnce = false;
var overlayEnabled = false;
var lastTouchMapped = null;
var lastReloadStatus = "";
var touchCfg = { ...TOUCHSIM_DEFAULTS };
var touchDefectsEnabled = TOUCH_DEFECTS_DEFAULT;
var touchSim = null;
var liveTouch = { fingers: 0, x: 0, y: 0 };
var pointerIdDown = null;
var quickDeg = 0;
var tiltDeg = 0;
var dragOffsetX = 0;
var dragOffsetY = 0;
var phoneMotion = new PhoneMotion({
  embed: EMBED,
  stage: stageEl,
  getQuickDeg: () => quickDeg,
  sendVector: (x, y, z, source) => sendVector(x, y, z, source),
  sendAccel: (ax, ay, az, tMs, source) => sendAccel(ax, ay, az, tMs, source),
  fireShake: (now, source) => fireShakeSensor(now, source),
  onLayoutChanged: () => fitDeviceToStage(),
  onOwnershipReleased: () => sendGravityForRotation(),
  mountTo: () => embedControlsRow ?? stageEl
});
var dragMotion = new DragMotion({
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
  }
});
var wiredButtons = [];
var wiredButtonById = new Map;
var buttonKeyById = new Map;
var appStripControl = null;
var lastAppIndex = 0;
var sensorControls = null;
var paused = false;
var replayer = null;
var tickCount = 0;
var deadState = null;
var pushHistory = [];
var PUSH_HISTORY_MAX = 400;
function appendConsoleLine(line) {
  const div = document.createElement("div");
  div.className = "console-line";
  div.textContent = line.text;
  consolePaneEl.appendChild(div);
  while (consolePaneEl.childElementCount > 300)
    consolePaneEl.removeChild(consolePaneEl.firstChild);
  consolePaneEl.scrollTop = consolePaneEl.scrollHeight;
}
function showWasmError(err) {
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
function hideWasmError() {
  wasmErrorEl.classList.add("hidden");
}
function failReload(err) {
  showWasmError(err);
  if (emu)
    consoleLog.push(`reload failed, keeping previous session running: ${errMsg(err)}`);
}
function describeTraceEvent(ev) {
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
function showEngineDead(state) {
  engineDeadEl.innerHTML = "";
  const title = document.createElement("div");
  title.className = "engine-dead-title";
  title.textContent = state.cause === "tick" ? "engine crashed: the tick loop threw and has stopped, the panel below is not necessarily what your firmware last drew" : `engine crashed: ${state.cause} threw and ticking has stopped too, the panel below is not necessarily what your firmware last drew`;
  const text = document.createElement("div");
  text.className = "engine-dead-text";
  text.textContent = state.error + (state.stack ? `
${state.stack}` : "");
  const meta = document.createElement("div");
  meta.className = "engine-dead-meta";
  meta.textContent = (state.cause === "tick" ? `died on tick ${state.diedOnTick}` : `died on ${state.cause}, shortly after tick ${state.diedOnTick}`) + `, ${state.diedAt}` + (state.lastInputEvent ? ` -- last input delivered: ${describeTraceEvent(state.lastInputEvent)}` : " -- no input had been delivered yet");
  const hint = document.createElement("div");
  hint.className = "engine-dead-hint";
  hint.textContent = "this could be a genuine wasm trap (a wild pointer write, an out-of-bounds access your firmware's own C committed) " + "or a bug in this emulator; the exception above is exact, use it to tell which. ticking has stopped so this does not " + "throw again 60 times a second -- reload once you've rebuilt, or to just try again.";
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
function hideEngineDead() {
  engineDeadEl.classList.add("hidden");
}
function enterDeadState(err, cause = "tick") {
  if (deadState)
    return;
  const last = recorder.recent(1);
  deadState = {
    error: errMsg(err),
    stack: err instanceof Error ? err.stack : undefined,
    diedOnTick: tickCount + 1,
    cause,
    lastInputEvent: last.length > 0 ? last[0] : null,
    diedAt: new Date().toISOString()
  };
  console.error(`engine crashed (${cause}):`, err);
  consoleLog.push(`engine crashed on ${cause}: ${deadState.error}`);
  showEngineDead(deadState);
}
function guardedAbiCall(cause, fn) {
  if (!emu || deadState)
    return;
  try {
    fn(emu);
  } catch (err) {
    enterDeadState(err, cause);
  }
}
function paintDeadOverlay(ctx, w, h) {
  ctx.save();
  ctx.fillStyle = "rgba(180, 30, 20, 0.28)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(180, 30, 20, 0.55)";
  ctx.lineWidth = 3;
  const step = 14;
  ctx.beginPath();
  for (let x = -h;x < w; x += step) {
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
function updateReloadStatus(byteLength) {
  const t = new Date;
  const pad = (n) => String(n).padStart(2, "0");
  lastReloadStatus = `reloaded ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())} ${byteLength.toLocaleString()}b`;
}
function derivePxPerMm(d) {
  const p = d.panel;
  if (typeof p.wMm === "number" && p.wMm > 0)
    return d.panel.w / p.wMm;
  if (typeof p.hMm === "number" && p.hMm > 0)
    return d.panel.h / p.hMm;
  return DEFAULT_PX_PER_MM;
}
function refreshContactInfo() {
  const mmInput = $("#contactMm");
  if (document.activeElement !== mmInput)
    mmInput.value = String(touchOverlay.contactMm);
  const px = Math.round(touchOverlay.contactMm * touchOverlay.pxPerMm);
  $("#contactPx").textContent = `${px}px`;
  $("#contactPreset").querySelectorAll("button").forEach((b) => b.classList.toggle("active", Number(b.dataset.mm) === touchOverlay.contactMm));
}
function wireContactSize() {
  const mmInput = $("#contactMm");
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
function emuButtonDown(index) {
  guardedAbiCall(`button[${index}] down`, (liveEmu) => {
    liveEmu.emu_button(index, 1);
    recorder.record({ t: performance.now(), k: "button", i: index, down: 1 });
  });
}
function emuButtonUp(index) {
  guardedAbiCall(`button[${index}] up`, (liveEmu) => {
    liveEmu.emu_button(index, 0);
    recorder.record({ t: performance.now(), k: "button", i: index, down: 0 });
  });
}
function emuButtonVerdict(index, isLong) {
  guardedAbiCall(`button[${index}] verdict (long=${isLong})`, (liveEmu) => {
    liveEmu.emu_button_verdict(index, isLong ? 1 : 0);
    recorder.record({ t: performance.now(), k: "verdict", i: index, long: isLong ? 1 : 0 });
  });
}
function buildChrome(d) {
  document.documentElement.style.setProperty("--panel-w", `${d.panel.w}px`);
  document.documentElement.style.setProperty("--panel-h", `${d.panel.h}px`);
  panelEl.width = d.panel.w;
  panelEl.height = d.panel.h;
  overlayEl.width = d.panel.w;
  overlayEl.height = d.panel.h;
  $("#deviceName").textContent = d.name || "device emulator";
  $("#deviceInfo").textContent = `${d.panel.w}×${d.panel.h}`;
  bezelEl.querySelectorAll(".dev-btn").forEach((el) => el.remove());
  wiredButtons = [];
  wiredButtonById = new Map;
  buttonKeyById = new Map;
  shortcuts.clear();
  const usedKeys = new Set;
  const shortcutListEl = $("#buttonShortcuts");
  shortcutListEl.innerHTML = "";
  if (EMBED) {
    usedKeys.add("r");
    shortcuts.bindClick("r", cycleQuickRotation);
  }
  const buttons = d.buttons || [];
  buttons.forEach((btn, index) => {
    const el = createButtonElement(btn.edge, btn.at, bezelEl.clientWidth, bezelEl.clientHeight);
    el.title = `${btn.label} (${btn.edge} @ ${(btn.at * 100).toFixed(0)}%)`;
    bezelEl.appendChild(el);
    const wired = wireButton(el, {
      onDown: () => emuButtonDown(index),
      onUp: () => emuButtonUp(index),
      onVerdict: (isLong) => emuButtonVerdict(index, isLong)
    }, btn.longPressMs);
    wiredButtons.push(wired);
    wiredButtonById.set(btn.id, wired);
    const key = assignShortcut(btn.id, usedKeys);
    if (key) {
      shortcuts.bindHeld(key, { down: wired.down, up: wired.up });
      buttonKeyById.set(btn.id, key);
    }
    const row = document.createElement("div");
    row.className = "shortcut-row";
    row.title = `${btn.edge} @ ${(btn.at * 100).toFixed(0)}%${btn.longPressMs ? `, hold ${btn.longPressMs}ms = long` : ""}`;
    row.innerHTML = `<span class="kbd">${key ? key.toUpperCase() : "-"}</span> ${escapeHtml2(btn.label)}`;
    shortcutListEl.appendChild(row);
  });
  if (emu) {
    sensorControls = buildSensorControls($("#sensorControls"), d.sensors || [], shortcuts, usedKeys, (t) => consoleLog.push(t), (sensor) => {
      if (sensor.id.toLowerCase() === "shake")
        puckMotion.impulse((Math.random() - 0.5) * 500, (Math.random() - 0.5) * 380);
    }, guardedAbiCall);
    appStripControl = buildAppStrip($("#appStrip"), d.apps || [], emu, guardedAbiCall);
  }
  shakeSensorIndex = (d.sensors || []).findIndex((s) => s.kind === "event" && s.id.toLowerCase() === "shake");
  vectorSensorIndices = (d.sensors || []).reduce((acc, s, i) => {
    if (s.kind === "vector")
      acc.push(i);
    return acc;
  }, []);
  streamSensorIndices = (d.sensors || []).reduce((acc, s, i) => {
    if (s.kind === "stream")
      acc.push(i);
    return acc;
  }, []);
  phoneMotion.onDeviceChanged(vectorSensorIndices.length > 0, shakeSensorIndex >= 0, streamSensorIndices.length > 0);
  if (embedShakeBtn)
    embedShakeBtn.hidden = shakeSensorIndex < 0;
  touchEnabled = (d.touch?.points ?? 0) > 0;
  panelEl.style.cursor = touchEnabled ? "crosshair" : "default";
  touchOverlay.pxPerMm = derivePxPerMm(d);
  refreshContactInfo();
  buildGestures(d);
  centerDeviceOnce();
  fitDeviceToStage();
}
function scriptButtonIds(script) {
  if (!Array.isArray(script) || script.length === 0)
    return null;
  const ids = [];
  for (const step of script) {
    if (typeof step !== "object" || step === null)
      return null;
    const s = step;
    if (typeof s.hold === "string") {
      if (!wiredButtonById.has(s.hold))
        return null;
      ids.push(s.hold);
    } else if (typeof s.release === "string") {
      if (!wiredButtonById.has(s.release))
        return null;
    } else if (typeof s.waitMs === "number") {
      if (!(s.waitMs > 0 && s.waitMs < 60000))
        return null;
    } else {
      return null;
    }
  }
  return ids;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function runGestureScript(script, log) {
  const steps = script;
  for (const step of steps) {
    if (step.hold !== undefined) {
      wiredButtonById.get(step.hold).down();
    } else if (step.release !== undefined) {
      wiredButtonById.get(step.release).up();
    } else if (step.waitMs !== undefined) {
      await sleep(step.waitMs);
    }
  }
  log("done");
}
function buildGestures(d) {
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
    det.open = false;
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
    const btn = document.createElement("button");
    btn.className = "chrome-btn";
    btn.textContent = "perform";
    if (holdIds) {
      btn.addEventListener("click", () => {
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = "...";
        consoleLog.push(`gesture: performing "${g.label}" through the real button path`);
        runGestureScript(g.script, (t) => consoleLog.push(`gesture: ${t}`)).finally(() => {
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
    const keys = uniqueIds.map((id) => buttonKeyById.get(id)?.toUpperCase()).filter((k) => !!k);
    if (keys.length > 0) {
      const keysEl = document.createElement("span");
      keysEl.className = "gesture-keys";
      keysEl.title = "same as holding these together";
      keysEl.innerHTML = keys.map((k) => `<span class="kbd">${escapeHtml2(k)}</span>`).join("+");
      actions.appendChild(keysEl);
    }
    body.appendChild(actions);
    det.appendChild(body);
    wrap.appendChild(det);
  }
}
function centerDeviceOnce() {
  if (centeredOnce)
    return;
  if (EMBED) {
    centeredOnce = true;
    return;
  }
  const stageRect = stageEl.getBoundingClientRect();
  const bw = bezelEl.offsetWidth;
  const bh = bezelEl.offsetHeight;
  if (bw === 0 || bh === 0 || stageRect.width === 0)
    return;
  deviceWrapEl.style.left = `${Math.max(20, Math.round((stageRect.width - bw) / 2))}px`;
  deviceWrapEl.style.top = `${Math.max(20, Math.round((stageRect.height - bh) / 2))}px`;
  centeredOnce = true;
}
function applyEmbedMode() {
  if (!EMBED)
    return;
  document.documentElement.classList.add("embed");
}
var embedControlsRow = null;
var embedShakeBtn = null;
function buildEmbedControls() {
  if (!EMBED)
    return;
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
function fitDeviceToStage() {
  if (!EMBED)
    return;
  const stageRect = stageEl.getBoundingClientRect();
  const bw = bezelEl.offsetWidth;
  const bh = bezelEl.offsetHeight;
  if (bw === 0 || bh === 0 || stageRect.width === 0 || stageRect.height === 0)
    return;
  const quarterTurned = (Math.round(quickDeg / 90) % 2 + 2) % 2 === 1;
  const boxW = quarterTurned ? bh : bw;
  const boxH = quarterTurned ? bw : bh;
  const margin = 16;
  const controlsReserve = 56;
  const scale = Math.min(1, (stageRect.width - margin) / boxW, (stageRect.height - margin - controlsReserve) / boxH);
  deviceWrapEl.style.setProperty("--embed-scale", String(scale > 0 ? scale : 1));
}
var reloadInFlight = false;
async function reloadModule(reason) {
  if (reloadInFlight) {
    consoleLog.push(`reload already in progress, ignoring (${reason})`);
    return;
  }
  reloadInFlight = true;
  consoleLog.push(`loading wasm module (${reason})...`);
  try {
    let bytes;
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
async function bringUp(bytes, reason) {
  let newEmu;
  try {
    newEmu = await instantiate(bytes, (text) => consoleLog.push(text));
  } catch (err) {
    failReload(err);
    return;
  }
  let initOk;
  try {
    initOk = newEmu.emu_init();
  } catch (err) {
    failReload(err);
    return;
  }
  if (initOk === 0) {
    failReload(new Error("emu_init() returned 0 (framebuffer allocation failed; see console pane above for why)"));
    return;
  }
  let newDevice;
  let reader;
  try {
    newDevice = readDeviceDescriptor(newEmu);
    reader = pixelReaderFor(newDevice.panel.format);
  } catch (err) {
    failReload(err);
    return;
  }
  let newFbPtr;
  try {
    newFbPtr = readFramebufferPointer(newEmu, newDevice.panel);
  } catch (err) {
    failReload(err);
    return;
  }
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
    deadState = null;
    tickCount = 0;
    hideEngineDead();
    if (touchSim)
      touchSim.setBounds(panelW, panelH);
    else
      touchSim = new TouchSim(touchCfg, panelW, panelH);
    buildChrome(newDevice);
    sendGravityForRotation();
    if (newDevice.apps && newDevice.apps.length > 0 && newEmu.emu_app_switch && newEmu.emu_app_current) {
      const idx = Math.min(prevAppIndex, newDevice.apps.length - 1);
      if (idx !== newEmu.emu_app_current()) {
        newEmu.emu_app_switch(idx);
        consoleLog.push(`resumed at app "${newDevice.apps[idx]}" (index preserved across reload; the app's own state was ` + `NOT, since state generally resets on init/switch -- this is a "which app", not a "where it was")`);
        appStripControl?.refresh();
      }
    }
    blitAll(panelCtx, newEmu.memory, fbPtr, panelW, panelH, reader);
    consoleLog.push(`ready: ${newDevice.name || "device"} ${panelW}x${panelH} ${newDevice.panel.format} (${reason})`);
    updateReloadStatus(bytes.byteLength);
  } catch (err) {
    failReload(err);
  }
}
function updateDiagStrip() {
  const parts = [];
  if (overlayEnabled && lastTouchMapped) {
    parts.push(`${lastTouchMapped.panel.x},${lastTouchMapped.panel.y}`);
  }
  parts.push(`push ${pushOverlay.lastCount}×${pushOverlay.lastWidth}px`);
  if (emu?.emu_sound_play_seq)
    parts.push(`sound ${soundPlayer.status}`);
  const shakeCount = Math.max(windowShake.lastJoltCount, puckDragShake.lastJoltCount);
  parts.push(`shake ${shakeCount}/${windowShake.cfg.joltMinCount}`);
  if (device)
    parts.push(device.panel.format);
  parts.push(`${recorder.events.length.toLocaleString()} rec`);
  if (lastReloadStatus)
    parts.push(lastReloadStatus);
  diagStripEl.textContent = parts.join("   ·   ");
}
function updateReplayBar() {
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
function wirePanelInput() {
  panelEl.addEventListener("pointerdown", (e) => {
    if (!touchEnabled || replayer)
      return;
    pointerIdDown = e.pointerId;
    panelEl.setPointerCapture(e.pointerId);
    const m = mapClientPoint(e.clientX, e.clientY, panelEl, quickDeg, tiltDeg, panelW, panelH);
    liveTouch = { fingers: 1, x: m.panel.x, y: m.panel.y };
    touchSim?.setPointer(true, m.panel.x, m.panel.y);
    lastTouchMapped = m;
    e.preventDefault();
  });
  panelEl.addEventListener("pointermove", (e) => {
    if (!touchEnabled)
      return;
    const m = mapClientPoint(e.clientX, e.clientY, panelEl, quickDeg, tiltDeg, panelW, panelH);
    if (pointerIdDown === e.pointerId) {
      liveTouch = { fingers: 1, x: m.panel.x, y: m.panel.y };
      touchSim?.setPointer(true, m.panel.x, m.panel.y);
      lastTouchMapped = m;
    } else if (pointerIdDown === null && !replayer) {
      if (overlayEnabled)
        touchOverlay.recordHover(m.panel.x, m.panel.y);
      lastTouchMapped = m;
    }
  });
  function release(e) {
    if (pointerIdDown !== e.pointerId)
      return;
    pointerIdDown = null;
    liveTouch = { fingers: 0, x: liveTouch.x, y: liveTouch.y };
    touchSim?.setPointer(false, liveTouch.x, liveTouch.y);
  }
  panelEl.addEventListener("pointerup", release);
  panelEl.addEventListener("pointercancel", release);
  panelEl.addEventListener("pointerleave", () => {
    if (pointerIdDown === null)
      touchOverlay.recordHover(null, null);
  });
}
function stepOnce() {
  if (!emu || !pixelReader)
    return;
  try {
    stepOnceUnguarded(emu);
  } catch (err) {
    enterDeadState(err);
  }
}
function stepOnceUnguarded(liveEmu) {
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
    const report = touchDefectsEnabled && touchSim ? touchSim.poll(now) : liveTouch;
    liveEmu.emu_touch(report.fingers, Math.round(report.x), Math.round(report.y));
    recorder.record({ t: now, k: "touch", down: report.fingers, x: Math.round(report.x), y: Math.round(report.y) });
    touchOverlay.recordTouch(report.fingers === 1, report.x, report.y, now);
  }
  liveEmu.emu_tick(now);
  tickCount++;
  recorder.record({ t: now, k: "tick" });
  afterTick(now);
}
function afterTick(now) {
  if (!emu || !pixelReader)
    return;
  const { rects, findings } = readPushes(emu, panelW, panelH);
  for (const f of findings)
    consoleLog.push(`firmware bug: ${f}`);
  for (const r of rects)
    blitRect(panelCtx, emu.memory, fbPtr, panelW, pixelReader, r);
  pushOverlay.record(rects, now);
  for (const r of rects)
    pushHistory.push({ tMs: now, ...r });
  while (pushHistory.length > PUSH_HISTORY_MAX)
    pushHistory.shift();
  if (device?.apps && device.apps.length > 0 && emu.emu_app_current)
    lastAppIndex = emu.emu_app_current();
  appStripControl?.refresh();
  soundPlayer.poll(emu, (text) => consoleLog.push(text));
}
function frame() {
  if (emu && !paused && !deadState)
    stepOnce();
  const now = performance.now();
  overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);
  if (deadState) {
    paintDeadOverlay(overlayCtx, overlayEl.width, overlayEl.height);
  } else {
    pushOverlay.paint(overlayCtx, now, accentColor);
    if (overlayEnabled)
      touchOverlay.paint(overlayCtx, now, accentColor);
  }
  pollWindowShake(now);
  puckMotion.tick(window.screenX, window.screenY, now);
  applyRotation(bezelEl, quickDeg + tiltDeg, puckMotion.offsetX + dragOffsetX, puckMotion.offsetY + dragOffsetY);
  updateDiagStrip();
  requestAnimationFrame(frame);
}
function sendVector(x, y, z, source) {
  if (!emu || !emu.emu_sensor_vector || vectorSensorIndices.length === 0)
    return;
  for (const i of vectorSensorIndices) {
    guardedAbiCall(`sensor[${i}] vector (${source})`, (liveEmu) => {
      liveEmu.emu_sensor_vector(i, x, y, z);
      recorder.record({ t: performance.now(), k: "vector", i, x, y, z });
    });
  }
}
function sendAccel(ax, ay, az, tMs, source) {
  if (!emu || !emu.emu_accel_sample || streamSensorIndices.length === 0)
    return;
  for (const i of streamSensorIndices) {
    guardedAbiCall(`sensor[${i}] accel (${source})`, (liveEmu) => {
      liveEmu.emu_accel_sample(i, tMs, ax, ay, az);
      recorder.record({ t: tMs, k: "accel", i, ax, ay, az });
    });
  }
}
function sendGravityForRotation() {
  if (phoneMotion.isActive())
    return;
  const g = gravityForQuickDeg(quickDeg);
  sendVector(g.x, g.y, g.z, "rotation");
}
var QUICK_ROT_ORDER = [0, 90, 180, -90];
function setQuickRotation(deg) {
  quickDeg = deg;
  $("#rotQuick").querySelectorAll("button").forEach((x) => x.classList.toggle("active", Number(x.dataset.deg) === deg));
  applyRotation(bezelEl, quickDeg + tiltDeg, puckMotion.offsetX + dragOffsetX, puckMotion.offsetY + dragOffsetY);
  phoneMotion.onQuickRotationChanged();
  sendGravityForRotation();
  fitDeviceToStage();
}
function cycleQuickRotation() {
  const i = QUICK_ROT_ORDER.indexOf(quickDeg);
  const next = QUICK_ROT_ORDER[(i < 0 ? 0 : i + 1) % QUICK_ROT_ORDER.length];
  setQuickRotation(next);
}
function fireShakeSensor(now, source) {
  if (shakeSensorIndex < 0 || replayer)
    return;
  guardedAbiCall(`sensor[${shakeSensorIndex}] (shake, ${source})`, (liveEmu) => {
    liveEmu.emu_sensor_event(shakeSensorIndex);
    recorder.record({ t: now, k: "sensor", i: shakeSensorIndex });
    consoleLog.push(`shake: ${source} accepted`);
  });
}
function pollWindowShake(now) {
  const suppressed = liveTouch.fingers === 1 || pointerIdDown !== null;
  if (windowShake.poll(window.screenX, window.screenY, now, suppressed))
    fireShakeSensor(now, "window jolt");
}
function onPuckDrag(clientX, clientY) {
  const now = performance.now();
  if (puckDragShake.poll(clientX, clientY, now, liveTouch.fingers === 1))
    fireShakeSensor(now, "puck drag");
}
function startReplay(trace) {
  if (!wasmBytes) {
    consoleLog.push("cannot replay: no wasm module loaded yet");
    return;
  }
  if (reloadInFlight) {
    consoleLog.push("reload already in progress, ignoring (starting replay)");
    return;
  }
  recorder.enabled = false;
  paused = true;
  btnPause.textContent = "resume";
  reloadInFlight = true;
  bringUp(wasmBytes, `replay of trace recorded ${trace.recordedAt}`).then(() => {
    replayer = new Replayer(trace.events);
    updateReplayBar();
    consoleLog.push(`replay loaded: ${trace.events.length} events. step or resume to play.`);
  }).finally(() => {
    reloadInFlight = false;
  });
}
function stopReplay() {
  replayer = null;
  recorder.enabled = true;
  paused = false;
  btnPause.textContent = "pause";
  updateReplayBar();
  reloadModule("resuming live input after replay");
}
function wireTraceFile() {
  const input = $("#traceFileInput");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file)
      return;
    (async () => {
      try {
        const text = await file.text();
        const trace = JSON.parse(text);
        if (!Array.isArray(trace.events))
          throw new Error("not a trace file (missing events array)");
        startReplay(trace);
      } catch (err) {
        consoleLog.push(`could not load trace: ${errMsg(err)}`);
      }
    })();
  });
}
function currentAppNameForFreeze() {
  if (!device?.apps || device.apps.length === 0)
    return null;
  if (deadState)
    return device.apps[lastAppIndex] ?? null;
  if (!emu?.emu_app_current)
    return null;
  try {
    return device.apps[emu.emu_app_current()] ?? null;
  } catch (err) {
    enterDeadState(err, "app_current() (read while freezing)");
    return device.apps[lastAppIndex] ?? null;
  }
}
async function runFreeze() {
  if (!emu || !device) {
    consoleLog.push("cannot freeze: no wasm module loaded");
    return;
  }
  const panelPngBase64 = canvasToPngBase64(panelEl);
  const currentApp = currentAppNameForFreeze();
  const engine = deadState ? {
    alive: false,
    error: deadState.error,
    diedOnTick: deadState.diedOnTick,
    cause: deadState.cause,
    lastInputEvent: deadState.lastInputEvent,
    diedAt: deadState.diedAt
  } : { alive: true };
  const bundle = {
    schemaVersion: 2,
    capturedAt: new Date().toISOString(),
    device,
    currentApp,
    pushes: pushHistory.slice(-200),
    input: recorder.recent(200),
    console: consoleLog.recent(100),
    journal: emptyJournal(),
    panelPngBase64,
    engine
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
async function saveTraceToServer() {
  if (!device) {
    consoleLog.push("nothing to save yet");
    return;
  }
  const trace = recorder.toTrace(device);
  try {
    const res = await fetch("/api/trace", { method: "POST", headers: { "content-type": "application/json", "x-puck-emulator": "1" }, body: JSON.stringify(trace) });
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    consoleLog.push(`trace saved -> ${data.path}`);
  } catch (err) {
    consoleLog.push(`save trace failed: ${errMsg(err)}`);
  }
}
function showRegressionPill(text, kind) {
  const el = $("#regressionPill");
  el.textContent = text;
  el.className = kind === "neutral" ? "pill hint" : `pill status ${kind}`;
}
async function saveBaselineToServer() {
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
      body: JSON.stringify(baseline)
    });
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    consoleLog.push(`baseline saved -> ${data.path} (${baseline.capturePoints.length} capture point(s))`);
    showRegressionPill(`baseline: ${baseline.capturePoints.length}pt`, "neutral");
  } catch (err) {
    consoleLog.push(`save baseline failed: ${errMsg(err)}`);
  }
}
async function checkBaseline() {
  if (!wasmBytes) {
    consoleLog.push("cannot check: no wasm module loaded");
    return;
  }
  let baseline;
  try {
    const res = await fetch("/api/baseline");
    if (res.status === 404) {
      consoleLog.push('no baseline saved yet -- click "baseline" first');
      return;
    }
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`);
    baseline = await res.json();
  } catch (err) {
    consoleLog.push(`load baseline failed: ${errMsg(err)}`);
    return;
  }
  consoleLog.push("checking against baseline (replaying its trace against a fresh instance of the current module)...");
  let check;
  try {
    check = await checkAgainstBaseline(wasmBytes, baseline);
  } catch (err) {
    consoleLog.push(`regression check failed to run: ${errMsg(err)}`);
    return;
  }
  const failCount = check.points.filter((p) => !p.match).length;
  consoleLog.push(check.pass ? `regression check: PASS (${check.points.length} capture point(s), against the emulator only)` : `regression check: FAIL, ${failCount}/${check.points.length} capture point(s) diverged`);
  showRegressionPill(check.pass ? "regression: pass" : `regression: fail ${failCount}/${check.points.length}`, check.pass ? "ok" : "fail");
  try {
    const payload = toRegressionResultPayload(baseline, check);
    const res = await fetch("/api/regression-result", {
      method: "POST",
      headers: { "content-type": "application/json", "x-puck-emulator": "1" },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      const data = await res.json();
      consoleLog.push(`regression result -> ${data.path}`);
    }
  } catch {}
  if (!check.pass)
    openRegressionModal(check);
}
function connectLiveReload() {
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
      if (e.data === "reload" && !replayer)
        reloadModule("wasm file changed on disk");
    });
  } catch {}
}
function buildTouchControls() {
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
  $("#rrInput").addEventListener("input", (e) => {
    touchCfg.reportRateHz = Number(e.target.value);
    $("#rrVal").textContent = `${touchCfg.reportRateHz}Hz`;
  });
  $("#dropoutsOn").addEventListener("change", (e) => {
    touchCfg.dropoutsEnabled = e.target.checked;
  });
  $("#dpInput").addEventListener("input", (e) => {
    touchCfg.dropoutsPerSec = Number(e.target.value);
    $("#dpVal").textContent = `${touchCfg.dropoutsPerSec}/s`;
  });
  $("#straysOn").addEventListener("change", (e) => {
    touchCfg.straysEnabled = e.target.checked;
  });
  $("#stInput").addEventListener("input", (e) => {
    touchCfg.straysPerSec = Number(e.target.value);
    $("#stVal").textContent = `${touchCfg.straysPerSec}/s`;
  });
}
function wireStaticUI() {
  applyEmbedMode();
  buildEmbedControls();
  window.addEventListener("resize", () => fitDeviceToStage());
  if (EMBED) {
    document.addEventListener("pointerdown", () => window.focus());
  }
  wireContactSize();
  if (!EMBED) {
    makeDraggable(bezelEl, deviceWrapEl, onPuckDrag);
    bezelEl.title = "drag to move; shake it back and forth to trigger the shake sensor";
  }
  wirePanelInput();
  connectLiveReload();
  wireTraceFile();
  const unlockAudio = () => soundPlayer.ensureContext((text) => consoleLog.push(text));
  document.addEventListener("pointerdown", unlockAudio);
  document.addEventListener("keydown", unlockAudio);
  $("#btnMute").addEventListener("click", (e) => {
    const muted = soundPlayer.toggleMute();
    e.currentTarget.classList.toggle("active", muted);
    e.currentTarget.title = muted ? "sound muted, click to unmute" : "mute";
  });
  $("#overlayOn").addEventListener("change", (e) => {
    overlayEnabled = e.target.checked;
    if (!overlayEnabled)
      overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);
  });
  $("#pushesOn").addEventListener("change", (e) => {
    pushOverlay.enabled = e.target.checked;
    if (!pushOverlay.enabled)
      overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);
  });
  $("#rotQuick").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => setQuickRotation(Number(b.dataset.deg)));
  });
  $("#tilt").addEventListener("input", (e) => {
    tiltDeg = Number(e.target.value);
    applyRotation(bezelEl, quickDeg + tiltDeg, puckMotion.offsetX, puckMotion.offsetY);
  });
  applyRotation(bezelEl, quickDeg + tiltDeg);
  btnPause.addEventListener("click", () => {
    paused = !paused;
    btnPause.textContent = paused ? "resume" : "pause";
  });
  $("#btnStep").addEventListener("click", () => {
    if (!deadState)
      stepOnce();
  });
  btnStopReplay.addEventListener("click", stopReplay);
  $("#btnPng").addEventListener("click", () => {
    panelEl.toBlob((blob) => {
      if (!blob)
        return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `panel-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  });
  $("#btnFreeze").addEventListener("click", () => {
    runFreeze();
  });
  $("#btnSaveTrace").addEventListener("click", () => {
    saveTraceToServer();
  });
  $("#btnSaveBaseline").addEventListener("click", () => {
    saveBaselineToServer();
  });
  $("#btnCheckBaseline").addEventListener("click", () => {
    checkBaseline();
  });
  $("#touchDefectsOn").addEventListener("change", (e) => {
    touchDefectsEnabled = e.target.checked;
  });
  buildTouchControls();
  $("#btnResetTouch").addEventListener("click", () => {
    Object.assign(touchCfg, TOUCHSIM_DEFAULTS);
    touchDefectsEnabled = TOUCH_DEFECTS_DEFAULT;
    $("#touchDefectsOn").checked = touchDefectsEnabled;
    buildTouchControls();
  });
  $("#btnQuit").addEventListener("click", () => {
    (async () => {
      await fetch("/api/quit", { method: "POST", headers: { "x-puck-emulator": "1" } });
      document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font:14px monospace;color:#888">emulator stopped. you can close this window.</div>';
    })();
  });
}
async function boot() {
  accentColor = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || accentColor;
  wireStaticUI();
  await reloadModule("initial load");
  requestAnimationFrame(frame);
}
window.__debug = {
  reloadModule,
  getEmu: () => emu,
  getDevice: () => device,
  getRecorder: () => recorder,
  rebuildGestures: () => device && buildGestures(device),
  rebuildChrome: () => device && buildChrome(device),
  getSoundPlayer: () => soundPlayer,
  getPhoneMotion: () => phoneMotion,
  getDeadState: () => deadState,
  getTickCount: () => tickCount
};
boot();
