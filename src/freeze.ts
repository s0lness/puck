// "Freeze": captures a bundle an agent can read (a screenshot exactly as
// displayed, plus a JSON of everything around it) and, optionally, lets the
// person draw on that screenshot and attach notes before it's written. See
// docs/agent-loop.md for the full spec and why each field of the bundle
// exists.
//
// Two-phase on purpose: the plain freeze (screenshot + state, no
// annotation) is POSTed immediately when the button is clicked, so nothing
// is lost if the annotation modal is just closed. Saving annotations PATCHes
// the same freeze in place rather than creating a second one.

import type { DeviceDescriptor } from "./wasm";
import type { TraceEvent } from "./recorder";
import type { LogLine } from "./consolelog";
import { type Journal, type MarkType, type Stroke, MARK_COLORS, MARK_LABELS, emptyJournal } from "./journal";

// Whether the tick loop that produced this freeze is still alive. A freeze
// reads the last-painted canvas and the recorder's existing history,
// neither of which needs the loop to be running - so without this field, a
// freeze taken after the engine died (see main.ts's enterDeadState) would
// look completely ordinary: valid pushes, a valid input trace, nothing
// anywhere saying the session that produced them is over. This field is
// what stops that bundle from lying to whoever reads it (see
// docs/agent-loop.md). Always present, never optional: absence must not be
// how a reader is expected to infer health.
export type EngineStatus =
  | { alive: true }
  | {
      alive: false;
      error: string;
      // The ordinal of the tick that was being processed, or most recently
      // completed, when the exception escaped (see main.ts's tickCount):
      // "died on tick 2" reads a lot more precisely than "died at some
      // point."
      diedOnTick: number;
      // What actually threw: "tick" for a trap inside emu_tick() itself
      // (the requestAnimationFrame path), or e.g. "button[0] down",
      // "sensor[0] (shake)", "app switch to 2" for a trap inside a direct
      // ABI call made from a DOM event handler outside the tick loop (see
      // main.ts's guardedAbiCall). A trap is a trap either way - the
      // module's memory is equally suspect regardless of which export it
      // happened in - but a reader of this bundle deserves the precise
      // answer to "what was the firmware doing" rather than always being
      // told "tick N" when it may not have been ticking at all.
      cause: string;
      // The last event the recorder actually delivered before the crash
      // (see src/recorder.ts's TraceEvent) - could be the tick itself, or
      // whatever touch/button/sensor input preceded it. null if nothing
      // had been recorded yet.
      lastInputEvent: TraceEvent | null;
      diedAt: string; // ISO timestamp
    };

export interface FreezeBundle {
  // Bumped from 1: schemaVersion 1 bundles had no `engine` field at all,
  // which is exactly the silent-lie this field exists to prevent (see
  // EngineStatus above) - a reader parsing a v1 bundle must not assume
  // "no engine field" means "was alive."
  schemaVersion: 2;
  capturedAt: string;
  device: DeviceDescriptor;
  currentApp: string | null;
  pushes: { tMs: number; x: number; y: number; w: number; h: number }[];
  input: TraceEvent[];
  console: LogLine[];
  journal: Journal;
  panelPngBase64: string;
  engine: EngineStatus;
}

export interface FreezeResult {
  ok: boolean;
  id?: string;
  path?: string;
  error?: string;
}

export async function postFreeze(bundle: FreezeBundle, id?: string): Promise<FreezeResult> {
  try {
    const res = await fetch("/api/freeze", {
      method: "POST",
      headers: { "content-type": "application/json", "x-puck-emulator": "1" },
      body: JSON.stringify(id ? { ...bundle, id } : bundle),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };
    const data = (await res.json()) as { id: string; path: string };
    return { ok: true, id: data.id, path: data.path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function canvasToPngBase64(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

// A small modal: the frozen panel, scaled up for legibility, with a
// freehand ink layer and a notes list on top of it. Resolves with the
// journal when "save annotations" is clicked, or null when just closed.
export function openAnnotationModal(panelDataUrl: string, panelW: number, panelH: number): Promise<Journal | null> {
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
    title.innerHTML = "<b>annotate the freeze</b> <span class=\"hint\">draw = mark, click type below, add a note, then save</span>";
    box.appendChild(title);

    const canvasWrap = document.createElement("div");
    canvasWrap.className = "freeze-canvas-wrap";
    canvasWrap.style.width = `${w}px`;
    canvasWrap.style.height = `${h}px`;
    box.appendChild(canvasWrap);

    const img = new Image();
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
    const ictx = inkCanvas.getContext("2d")!;

    const journal: Journal = emptyJournal();
    let nextId = 1;
    let currentType: MarkType = "f";
    let drawing = false;
    let current: Stroke | null = null;

    function redraw(): void {
      ictx.clearRect(0, 0, w, h);
      for (const s of journal.strokes) {
        if (s.points.length < 2) continue;
        ictx.strokeStyle = MARK_COLORS[s.type];
        ictx.lineWidth = 3;
        ictx.lineCap = "round";
        ictx.lineJoin = "round";
        ictx.beginPath();
        ictx.moveTo(s.points[0]!.x * scale, s.points[0]!.y * scale);
        for (const p of s.points.slice(1)) ictx.lineTo(p.x * scale, p.y * scale);
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
      if (!drawing || !current) return;
      const rect = inkCanvas.getBoundingClientRect();
      current.points.push({ x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale });
      redraw();
    });
    function stopDrawing(): void { drawing = false; current = null; }
    inkCanvas.addEventListener("pointerup", stopDrawing);
    inkCanvas.addEventListener("pointercancel", stopDrawing);

    const typeRow = document.createElement("div");
    typeRow.className = "segtog freeze-typetog";
    (["f", "q", "n"] as MarkType[]).forEach((t) => {
      const b = document.createElement("button");
      b.textContent = `${MARK_LABELS[t]}`;
      b.style.color = MARK_COLORS[t];
      if (t === currentType) b.classList.add("active");
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

    function renderNotes(): void {
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
      if (!text) return;
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

    function close(result: Journal | null): void {
      overlayEl.remove();
      resolve(result);
    }
    saveBtn.addEventListener("click", () => close(journal));
    closeBtn.addEventListener("click", () => close(null));

    document.body.appendChild(overlayEl);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
