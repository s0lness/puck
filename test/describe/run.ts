#!/usr/bin/env bun
// Proves `bun run describe` (tools/describe.ts) drafts a descriptor that
// AGREES WITH THE HAND-WRITTEN ONE where a replay can see the answer, and
// says plainly where it cannot.
//
// It runs the real CLI as a subprocess, against the real traces and the real
// descriptors in this repository, never against fixtures of its own, for the
// same reason test/verdict/run.ts gives: the claim worth protecting is not
// "the derivation derives what it derives", it is "a session of chrono is
// enough to find out that this app needs a key and a click, and nothing
// else". That is a claim about THESE files.
//
// It needs no zig, no browser and no hardware: it describes the modules
// `site/dist/modules/*.wasm`, which are committed (site/dist/ is served
// as-is by Cloudflare Pages, so it is in git), so this is one of the fast
// tests. tools/describe.ts's own `.c` path, which builds through the pack,
// is the same code past `resolveModule` and is exercised by hand rather than
// here, because a zig build in a test would make this the slow one.
//
// WHY THE PANEL ASSERTIONS ARE NOT ALL EQUALITY, since that is the one place
// a reader could think this test is being lenient with itself. A drafted
// `panel.minW`/`minH` is the extent the app ACTUALLY PAINTED. The
// convention's `minW`/`minH` is the size at which the app is still ITSELF.
// Those are different quantities and they do not nest: chrono paints a
// 120x420 column of digits, and its descriptor asks for 200x200, which is
// neither larger nor smaller. Asserting equality there would be asserting
// that a measurement can answer a question of identity, which is exactly
// what tools/describe.ts's own header says it cannot. So the panel demand is
// held to the thing it is FOR: `bun run verdict` must reach the same panel
// status, and the same overall verdict, from the draft as from the committed
// descriptor, on all three packs. `color`, `orientation`, the button roles
// and the touch points ARE asserted by equality, because those a replay can
// answer outright.
//
// Ten checks, each failing loudly on its own line:
//   1. describing chrono writes a descriptor.draft.md and a
//      descriptor.draft.json, and overwrites no descriptor.md
//   2. the drafted panel.color and panel.orientation equal chrono's own
//   3. the drafted button ROLES equal chrono's own, key and click, in a
//      session that never reads either role out of a device.json
//   4. the drafted touch.points equals chrono's own zero, on a device that
//      declares a digitizer
//   5. every Interactions line is bound, concrete and carries an unfilled
//      (intent: ...), per docs/convention/app-bundle.md
//   6. the drafted memory came from the module's own arena, not from a
//      device budget, and lands within a factor of three of the hand-written
//      figure
//   7. `bun run verdict` on the DRAFT gives the same verdict, and the same
//      per-dimension status, as on the committed descriptor, for all three
//      packs
//   8. NEGATIVE CONTROL: one INVENTED verdict event, on the button that is
//      really a click, drafts `key` where the real trace drafts `click`, and
//      check 3 fails on it. An assertion that cannot be made to fail is not
//      a check (docs/convention/publishing.md's red-before-green step), and
//      this is also what proves the role comes out of the trace rather than
//      out of the pack's device.json, which says `click` in both runs.
//   9. NEGATIVE CONTROL: a trace with every verdict event STRIPPED drafts no
//      button at all, and check 3 fails on it too. Worth its own line
//      because the cascade is a real property of this method: with no
//      verdict, chrono's clock never starts, so its reset has nothing to
//      reset, so neither button reaches the panel and neither earns a
//      demand. A session can only describe what it made happen.
//  10. fluidbox: the draft's KNOWN divergence from the hand-written
//      descriptor is exactly the one this method predicts, on exactly one
//      pack and one dimension. A session that only ever shakes cannot find
//      out that the app wants a continuous tilt vector, so the draft says
//      `event` where the human said `vector` with an `event` fallback, and
//      the esp32 pack (which has no vector sensor) is `go` from the draft
//      and `degraded` from the human. The human is right and the draft is
//      honest; what this check protects is that the gap stays exactly that
//      size, so a future change that widens it is noticed.
//
// Exit codes follow the repo's three-way split: 0 = every check passed,
// 1 = a check failed, 2 = it never ran.
//
// Run: bun run test:describe

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readDemands, type Demands, type Status } from "../../tools/verdict";

const ROOT = resolve(import.meta.dir, "..", "..");
const PACKS = ["rp2350-touch-amoled-18", "esp32-s3-touch-amoled-18", "web"];

let failures = 0;
function fail(message: string): void {
  failures++;
  console.error(`FAIL: ${message}`);
}
function pass(message: string): void {
  console.log(`  ok: ${message}`);
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  const result = Bun.spawnSync(["bun", "run", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ? result.stdout.toString() : "",
    stderr: result.stderr ? result.stderr.toString() : "",
  };
}

// Drafts into a temporary directory, never next to the trace: the committed
// drafts under apps/*/traces/ are this tool's worked output, and a test that
// rewrote them would be testing itself against whatever it just wrote.
function describe(module_: string, pack: string, traces: string[], outDir: string, extra: string[] = []): Run {
  return run(["tools/describe.ts", module_, "--pack", pack, ...traces.flatMap((t) => ["--trace", t]), "--out", outDir, ...extra]);
}

interface VerdictCheck {
  dimension: string;
  status: Status;
  reason: string;
}
interface VerdictResult {
  verdict: "go" | "degraded" | "refuse";
  checks: VerdictCheck[];
}

function verdictOf(app: string, pack: string, descriptor?: string): VerdictResult | null {
  const result = run(["tools/verdict.ts", app, pack, "--json", ...(descriptor ? ["--descriptor", descriptor] : [])]);
  if (result.exitCode > 1) {
    fail(`verdict ${app} x ${pack}${descriptor ? " (draft)" : ""} exited ${result.exitCode}: ${result.stderr.trim()}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout) as VerdictResult;
  } catch {
    fail(`verdict ${app} x ${pack}${descriptor ? " (draft)" : ""} printed no JSON: ${result.stdout.slice(0, 200)}`);
    return null;
  }
}

// The assertion under test in checks 3, 8 and 9: the roles a session found,
// against the roles the app's own descriptor states. Returned rather than
// asserted inline so a negative control can run the SAME function over a
// corrupted draft and require it to come back false.
function rolesAgree(draft: Demands, committed: Demands): { agree: boolean; drafted: string[]; expected: string[] } {
  const drafted = (draft.buttons ?? []).map((b) => b.role).sort();
  const expected = (committed.buttons ?? []).map((b) => b.role).sort();
  return { agree: drafted.length === expected.length && drafted.every((r, i) => r === expected[i]), drafted, expected };
}

const work = mkdtempSync(join(tmpdir(), "puck-describe-"));
try {
  // ---- chrono ------------------------------------------------------------

  const chronoOut = join(work, "chrono");
  const chronoRun = describe(
    "site/dist/modules/chrono-rp2350.wasm",
    "rp2350-touch-amoled-18",
    ["apps/chrono/traces/chrono-startstop.trace.json", "apps/chrono/traces/chrono-idle.trace.json"],
    chronoOut
  );
  if (chronoRun.exitCode !== 0) {
    console.error(`describe exited ${chronoRun.exitCode}\n${chronoRun.stderr}`);
    process.exit(2);
  }

  const chronoDraftPath = join(chronoOut, "descriptor.draft.md");
  const chronoJsonPath = join(chronoOut, "descriptor.draft.json");
  if (!existsSync(chronoDraftPath) || !existsSync(chronoJsonPath)) {
    fail(`describe wrote no draft into ${chronoOut}`);
    process.exit(1);
  }
  if (existsSync(join(chronoOut, "descriptor.md"))) {
    fail("describe wrote a descriptor.md, and it must never write one");
  } else {
    pass("chrono: a descriptor.draft.md and a descriptor.draft.json, and no descriptor.md");
  }

  const chronoDraft = readDemands(chronoDraftPath);
  const chronoCommitted = readDemands(join(ROOT, "apps", "chrono", "descriptor.md"));
  const chronoDraftText = readFileSync(chronoDraftPath, "utf8");

  // 2. colour and orientation, by equality.
  if (chronoDraft.panel?.color !== chronoCommitted.panel?.color) {
    fail(`chrono: drafted panel.color ${chronoDraft.panel?.color}, the descriptor says ${chronoCommitted.panel?.color}`);
  } else if ((chronoDraft.panel?.orientation ?? "either") !== (chronoCommitted.panel?.orientation ?? "either")) {
    fail(`chrono: drafted panel.orientation ${chronoDraft.panel?.orientation}, the descriptor says ${chronoCommitted.panel?.orientation}`);
  } else {
    pass(`chrono: panel.color (${chronoDraft.panel?.color}) and panel.orientation match the descriptor, from pixels alone`);
  }

  // 3. button roles, by equality.
  const roles = rolesAgree(chronoDraft, chronoCommitted);
  if (!roles.agree) {
    fail(`chrono: drafted button roles [${roles.drafted.join(", ")}], the descriptor says [${roles.expected.join(", ")}]`);
  } else {
    pass(`chrono: button roles [${roles.drafted.join(", ")}] match the descriptor, derived from whether the session got a verdict event and not from any device.json`);
  }

  // 4. touch points, by equality.
  if ((chronoDraft.touch?.points ?? 0) !== (chronoCommitted.touch?.points ?? 0)) {
    fail(`chrono: drafted touch.points ${chronoDraft.touch?.points}, the descriptor says ${chronoCommitted.touch?.points}`);
  } else {
    pass(`chrono: touch.points ${chronoDraft.touch?.points ?? 0} matches the descriptor, on a device that declares a digitizer`);
  }

  // 5. every Interactions line is a bound, concrete line with an intent TODO.
  const interactions = chronoDraftText
    .slice(chronoDraftText.indexOf("## Interactions"), chronoDraftText.indexOf("## Demands"))
    .split("\n")
    .filter((line) => line.startsWith("- ") && line.includes("(intent:"));
  if (interactions.length < 2) {
    fail(`chrono: ${interactions.length} Interactions line(s) carry an "(intent: ...)"; a session with two distinct presses must produce at least two`);
  } else if (!interactions.every((line) => line.includes("intent: TODO"))) {
    fail("chrono: an Interactions line carries a filled-in intent, which this tool must never invent");
  } else if (!interactions.every((line) => /\d/.test(line))) {
    fail("chrono: an Interactions line states no number, so it is not bound and concrete");
  } else {
    pass(`chrono: ${interactions.length} Interactions lines, each with a number in it and an unfilled (intent: TODO ...)`);
  }

  // 6. memory came from the module, and is in the same neighbourhood as the
  // hand-written figure. Not equality: 96 is a person's round number and 36
  // is what the arena actually held, and the point of the check is that the
  // draft read a real allocator rather than copying a budget.
  const chronoJson = JSON.parse(readFileSync(chronoJsonPath, "utf8")) as { memorySource: string; traces: { arena: { usedBytes: number } | null }[] };
  const drafted = chronoDraft.memory?.baseBytes ?? -1;
  const stated = chronoCommitted.memory?.baseBytes ?? -1;
  if (!chronoJson.memorySource.includes("emu_arena_used")) {
    fail(`chrono: memory came from "${chronoJson.memorySource}", not from the module's own arena`);
  } else if (drafted <= 0 || drafted > stated * 3) {
    fail(`chrono: drafted memory.baseBytes ${drafted} against the descriptor's ${stated}, which is not the same neighbourhood`);
  } else {
    pass(`chrono: memory.baseBytes ${drafted} read from the module's own emu_arena_used(), against the descriptor's ${stated}`);
  }

  // 7. verdict parity, per dimension, on all three packs.
  let parityBroken = false;
  for (const pack of PACKS) {
    const fromDraft = verdictOf("chrono", pack, chronoDraftPath);
    const fromCommitted = verdictOf("chrono", pack);
    if (!fromDraft || !fromCommitted) {
      parityBroken = true;
      continue;
    }
    if (fromDraft.verdict !== fromCommitted.verdict) {
      fail(`chrono x ${pack}: the draft says ${fromDraft.verdict}, the descriptor says ${fromCommitted.verdict}`);
      parityBroken = true;
      continue;
    }
    for (const check of fromCommitted.checks) {
      const mine = fromDraft.checks.find((c) => c.dimension === check.dimension);
      if (mine?.status !== check.status) {
        fail(`chrono x ${pack}: the draft's ${check.dimension} is ${mine?.status}, the descriptor's is ${check.status}`);
        parityBroken = true;
      }
    }
  }
  if (!parityBroken) pass(`chrono: the draft and the descriptor reach the same verdict and the same status on every dimension, on all ${PACKS.length} packs`);

  // ---- 8 and 9: red before green ----------------------------------------

  interface AnyEvent {
    t: number;
    k: string;
    i?: number;
    down?: number;
    long?: number;
  }
  const startstop = JSON.parse(readFileSync(join(ROOT, "apps", "chrono", "traces", "chrono-startstop.trace.json"), "utf8")) as {
    events: AnyEvent[];
  };

  function corrupt(name: string, events: AnyEvent[]): { agree: boolean; drafted: string[] } | null {
    const tracePath = join(work, `${name}.trace.json`);
    writeFileSync(tracePath, JSON.stringify({ ...startstop, events }), "utf8");
    const out = join(work, `corrupt-${name}`);
    const result = describe("site/dist/modules/chrono-rp2350.wasm", "rp2350-touch-amoled-18", [tracePath], out);
    if (result.exitCode !== 0) {
      fail(`describe on the ${name} trace exited ${result.exitCode}: it must still produce a draft, just a wrong one\n${result.stderr.trim()}`);
      return null;
    }
    return rolesAgree(readDemands(join(out, "descriptor.draft.md")), chronoCommitted);
  }

  // A verdict event the board never sent, on the button that is a `click`.
  // The presses are unchanged and the app behaves identically; the only
  // thing different is that the trace now claims the device answered BOOT
  // with a short/long verdict. If the role derivation were reading
  // device.json (or defaulting), this would still come out [click, key].
  const injected = startstop.events.flatMap<AnyEvent>((e) =>
    e.k === "button" && e.i === 0 && e.down === 0 ? [e, { t: e.t, k: "verdict", i: 0, long: 0 }] : [e]
  );
  const withInjected = corrupt("injected-verdict", injected);
  if (withInjected) {
    if (withInjected.agree || withInjected.drafted.join(",") !== "key,key") {
      fail(`negative control: inventing a verdict event for the click button drafted [${withInjected.drafted.join(", ")}], and the answer that follows from the trace is [key, key]`);
    } else {
      pass("negative control: one invented verdict event turns the click into a key, the role check fails, and the derivation is therefore reading the trace");
    }
  }

  // Every verdict event gone: the same presses happened and the device never
  // said whether any of them was short or long. The `key` role goes with
  // them, AND so does the click, which is worth knowing: chrono's own reset
  // only shows on the panel when there is something to reset, so a session
  // whose PWR never started the clock cannot see BOOT do anything either.
  // The draft says no button at all, which is the honest answer to that
  // trace and the wrong answer about this app.
  const noVerdicts = corrupt("no-verdicts", startstop.events.filter((e) => e.k !== "verdict"));
  if (noVerdicts) {
    if (noVerdicts.agree || noVerdicts.drafted.length !== 0) {
      fail(`negative control: stripping every verdict event drafted [${noVerdicts.drafted.join(", ")}], and that trace supports no button demand at all`);
    } else {
      pass("negative control: with no verdict event the clock never starts, nothing the two buttons do reaches the panel, and the draft claims no button");
    }
  }

  // ---- 10. fluidbox, and the exact size of the gap -----------------------

  const fluidOut = join(work, "fluidbox");
  const fluidRun = describe("site/dist/modules/fluidbox-rp2350.wasm", "rp2350-touch-amoled-18", ["apps/fluidbox/traces/fluid-settle-shake.trace.json"], fluidOut);
  if (fluidRun.exitCode !== 0) {
    fail(`describe on fluidbox exited ${fluidRun.exitCode}: ${fluidRun.stderr.trim()}`);
  } else {
    const fluidDraftPath = join(fluidOut, "descriptor.draft.md");
    const fluidDraft = readDemands(fluidDraftPath);
    const fluidCommitted = readDemands(join(ROOT, "apps", "fluidbox", "descriptor.md"));

    if (fluidDraft.panel?.color !== true || fluidCommitted.panel?.color !== true) {
      fail(`fluidbox: drafted panel.color ${fluidDraft.panel?.color}, the descriptor says ${fluidCommitted.panel?.color}`);
    } else {
      pass("fluidbox: panel.color true, drafted from finding pixels whose r, g and b differ");
    }

    const draftedSensors = (fluidDraft.sensors ?? []).map((s) => s.kind).sort();
    if (draftedSensors.join(",") !== "event") {
      fail(`fluidbox: drafted sensors [${draftedSensors.join(", ")}], and a session whose only sensor event is a shake can only find "event"`);
    } else {
      pass('fluidbox: drafted sensors ["event"], which is exactly what this session delivered');
    }

    const divergences: string[] = [];
    for (const pack of PACKS) {
      const fromDraft = verdictOf("fluidbox", pack, fluidDraftPath);
      const fromCommitted = verdictOf("fluidbox", pack);
      if (!fromDraft || !fromCommitted) continue;
      if (fromDraft.verdict !== fromCommitted.verdict) {
        const dims = fromCommitted.checks
          .filter((c) => fromDraft.checks.find((d) => d.dimension === c.dimension)?.status !== c.status)
          .map((c) => c.dimension);
        divergences.push(`${pack}: draft ${fromDraft.verdict}, descriptor ${fromCommitted.verdict}, on [${dims.join(", ")}]`);
      }
    }
    const expected = ["esp32-s3-touch-amoled-18: draft go, descriptor degraded, on [sensors]"];
    if (divergences.join(" | ") !== expected.join(" | ")) {
      fail(
        `fluidbox: the draft's divergence from the descriptor is [${divergences.join(" | ")}], and the one this method predicts is [${expected.join(" | ")}].\n` +
          "        A NEW divergence means the derivation changed; a MISSING one means the descriptor did. Either way somebody has to look."
      );
    } else {
      pass("fluidbox: the draft diverges from the descriptor on exactly one pack and one dimension, the sensor the session never delivered");
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("every check passed");
