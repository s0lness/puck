#!/usr/bin/env bun
// puck verdict: does this app fit this device, mechanically.
//
//   puck verdict <app> <pack-or-silhouette> [--json]
//   bun run verdict <app> <pack-or-silhouette> [--json]
//
// docs/convention/app-bundle.md's porting flow already had this step, and
// it was a step a person did by reading two files and forming an opinion:
// "Compare Demands with device.json and give a verdict before writing code:
// go, degraded, or refuse". A verdict formed that way cannot be recomputed
// when either file changes, cannot be run for forty cells of a matrix, and
// cannot be argued WITH. This does the same comparison from the same two
// files and prints its reasons, so a port's own prose verdict now has
// something to agree with or to argue against explicitly.
//
// WHAT THIS IS NOT. It is not a prediction that the port will work, and it
// never touches a compiler. It reads what the app says it needs
// (descriptor.md's `json demands` block) against what the device says it
// has (device.json, plus a silhouette's budget), and reports where those
// two disagree. Every "go" here is a statement about two JSON documents.
// The thing that decides whether an app runs is running it.
//
// Exit codes, the repo's own three-way split: 0 = go or degraded, 1 =
// refuse, 2 = never ran (an unknown app, an unknown target, a descriptor
// with no machine-readable demands). CI reads the code, a person reads the
// paragraph, and a matrix reads --json.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

const EXIT_FIT = 0;
const EXIT_REFUSE = 1;
const EXIT_INFRA = 2;

// ---- the two documents ---------------------------------------------------

interface RegistryEntry {
  name: string;
  path?: string;
  url?: string;
}
interface Registry {
  packs: RegistryEntry[];
  silhouettes?: RegistryEntry[];
  apps: RegistryEntry[];
}

interface DeviceButton {
  id: string;
  label?: string;
  role?: string;
  longPressMs?: number;
}
interface DeviceSensor {
  id: string;
  kind: string;
}
interface DeviceJson {
  name?: string;
  panel?: { w: number; h: number; format?: string };
  buttons?: DeviceButton[];
  touch?: { points?: number };
  sensors?: DeviceSensor[];
  budget?: {
    ram?: { bytes?: number; basis?: string };
    framebuffer?: string;
    tickBudgetMs?: number;
  };
  provenance?: { datasheet?: string; verified?: boolean; hypothetical?: boolean; note?: string };
}

interface DemandButton {
  role: string;
  why?: string;
}
interface DemandSensor {
  kind: string;
  id?: string;
  why?: string;
  fallback?: { kind: string; id?: string; cost?: string };
}
interface Degrade {
  what?: string;
  basis: string;
  pixelsPerUnit?: number;
  reference: number;
  min: number;
  max: number;
}
interface Demands {
  convention?: string;
  panel?: {
    minW: number;
    minH: number;
    scalesTo?: { minW: number; minH: number };
    orientation?: string;
    color?: boolean;
  };
  buttons?: DemandButton[];
  touch?: { points?: number };
  sensors?: DemandSensor[];
  memory?: { baseBytes?: number; perUnitBytes?: number; unit?: string };
  tick?: { needsMs?: number; refuseUnderMs?: number };
  degrades?: Record<string, Degrade>;
}

// ---- the result ----------------------------------------------------------

type Status = "go" | "degraded" | "refuse" | "unchecked";

interface Check {
  dimension: string;
  status: Status;
  reason: string;
}

interface DegradeResult {
  name: string;
  what: string;
  value: number;
  reference: number;
  boundBy: string;
}

interface VerdictResult {
  app: string;
  target: string;
  targetKind: "pack" | "silhouette";
  verdict: "go" | "degraded" | "refuse";
  checks: Check[];
  degrades: DegradeResult[];
  human: string;
}

function die(message: string): never {
  console.error(`verdict: ${message}`);
  process.exit(EXIT_INFRA);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// The demands block lives inside the descriptor's third section, and this
// looks for it there rather than anywhere in the file: a fenced block under
// Essence or Interactions would be describing something else, and reading
// it as requirements is exactly the kind of quiet mistake this tool must
// not make.
function parseDemands(descriptorPath: string): Demands {
  const text = readFileSync(descriptorPath, "utf8");
  const demandsAt = text.search(/^##\s+Demands\s*$/m);
  if (demandsAt === -1) die(`${descriptorPath} has no "## Demands" section (docs/convention/app-bundle.md)`);
  const section = text.slice(demandsAt);
  const fenced = /```json demands\s*\n([\s\S]*?)```/.exec(section);
  if (!fenced) {
    die(
      `${descriptorPath}'s Demands section carries no \`\`\`json demands block, so this app's requirements are prose only.\n` +
        `        Add one (docs/convention/app-bundle.md, "Demands are also machine-readable"); nothing here guesses at prose.`
    );
  }
  try {
    return JSON.parse(fenced[1]!) as Demands;
  } catch (err) {
    die(`${descriptorPath}'s json demands block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- the checks ----------------------------------------------------------

const WORST: Record<Status, number> = { go: 0, unchecked: 0, degraded: 1, refuse: 2 };

// rgb565be, bgr888 and friends are colour; anything else (mono1, gray8, an
// e-paper's own name for itself) is not. Stated in the convention rather
// than guessed per format, so a new format either says rgb/bgr or is
// treated as monochrome, which is the safe direction to be wrong in.
function isColorPanel(format: string | undefined): boolean {
  const f = (format ?? "").toLowerCase();
  return f.startsWith("rgb") || f.startsWith("bgr");
}

function panelCheck(demands: Demands, device: DeviceJson): Check {
  const panel = device.panel;
  if (!panel) return { dimension: "panel", status: "refuse", reason: "the device declares no panel" };
  const want = demands.panel;
  if (!want) return { dimension: "panel", status: "unchecked", reason: "the app states no panel demand" };

  const size = `${panel.w}x${panel.h}`;
  if (want.color && !isColorPanel(panel.format)) {
    return {
      dimension: "panel",
      status: "refuse",
      reason: `this app's colour carries information and the panel is ${panel.format ?? "an unnamed format"}, which is not a colour one`,
    };
  }

  // orientation "either" compares long side to long side: a landscape app
  // on a portrait panel is the normal case (the whole reference pack works
  // that way), not a mismatch.
  const either = (want.orientation ?? "either") === "either";
  const deviceLong = either ? Math.max(panel.w, panel.h) : panel.w;
  const deviceShort = either ? Math.min(panel.w, panel.h) : panel.h;
  const fits = (minW: number, minH: number): boolean => {
    const wantLong = either ? Math.max(minW, minH) : minW;
    const wantShort = either ? Math.min(minW, minH) : minH;
    return deviceLong >= wantLong && deviceShort >= wantShort;
  };

  if (fits(want.minW, want.minH)) {
    return { dimension: "panel", status: "go", reason: `${size} covers the ${want.minW}x${want.minH} this app asks for` };
  }
  if (want.scalesTo && fits(want.scalesTo.minW, want.scalesTo.minH)) {
    return {
      dimension: "panel",
      status: "degraded",
      reason: `${size} is under the ${want.minW}x${want.minH} this app asks for, and above the ${want.scalesTo.minW}x${want.scalesTo.minH} it scales to: the layout comes out of the panel, so it fits, smaller`,
    };
  }
  return {
    dimension: "panel",
    status: "refuse",
    reason: `${size} is under the ${want.scalesTo ? `${want.scalesTo.minW}x${want.scalesTo.minH} this app can scale to` : `${want.minW}x${want.minH} this app asks for`}`,
  };
}

const APP_USABLE_ROLES = new Set(["click", "key"]);

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function buttonCheck(demands: Demands, device: DeviceJson): Check {
  const wanted = demands.buttons ?? [];
  if (wanted.length === 0) return { dimension: "buttons", status: "go", reason: "this app asks for no buttons" };

  const declared = device.buttons ?? [];
  const usable = declared.filter((b) => b.role !== undefined && APP_USABLE_ROLES.has(b.role));
  const unroled = declared.filter((b) => b.role === undefined);

  if (usable.length < wanted.length) {
    const reserved = declared.length - usable.length - unroled.length;
    // The whys come along, because a count is not a reason. "one button,
    // needs two" invites somebody to merge the two controls; the app's own
    // sentence about why they are separate is what stops that, and it is
    // already written in the descriptor.
    const parts = [
      `this device offers ${plural(usable.length, "button", "buttons")} an app may use and this app needs ${wanted.length}`,
      reserved > 0 ? `${plural(reserved, "more is", "more are")} wired to the power or reset path and cannot be read` : null,
      unroled.length > 0 ? `${plural(unroled.length, "declares", "declare")} no role, so nothing can be promised about them` : null,
      `what they are for: ${wanted.map((d) => `${d.role}, ${d.why ?? "no reason stated"}`).join("; ")}`,
    ].filter(Boolean);
    return { dimension: "buttons", status: "refuse", reason: parts.join("; ") };
  }

  // Exact roles first, then whatever is left over. A substitution is not a
  // fit: a click button reports one click on release and nothing else,
  // where a key reports press, release and a short/long verdict, so an app
  // demanding a key and handed a click is an app whose control has to be
  // rewritten.
  const taken = new Set<string>();
  const substitutions: string[] = [];
  for (const demand of wanted) {
    const exact = usable.find((b) => b.role === demand.role && !taken.has(b.id));
    if (exact) {
      taken.add(exact.id);
      continue;
    }
    const any = usable.find((b) => !taken.has(b.id));
    if (!any) return { dimension: "buttons", status: "refuse", reason: `no button left for the ${demand.role} this app needs (${demand.why ?? "no reason stated"})` };
    taken.add(any.id);
    substitutions.push(`"${any.label ?? any.id}" is a ${any.role} standing in for the ${demand.role} this app wants (${demand.why ?? "no reason stated"})`);
  }

  if (substitutions.length > 0) {
    return { dimension: "buttons", status: "degraded", reason: substitutions.join("; ") };
  }
  const named = wanted.map((d) => d.role).join(" and ");
  return {
    dimension: "buttons",
    status: "go",
    reason:
      wanted.length === 1
        ? `the ${named} this app needs is declared`
        : `the ${named} this app needs are declared, on ${wanted.length} separate controls`,
  };
}

function touchCheck(demands: Demands, device: DeviceJson): Check {
  const want = demands.touch?.points ?? 0;
  const has = device.touch?.points ?? 0;
  if (want === 0) return { dimension: "touch", status: "go", reason: "this app reads no touch" };
  if (has >= want) return { dimension: "touch", status: "go", reason: `${has} touch point(s) declared, ${want} needed` };
  return { dimension: "touch", status: "refuse", reason: `this app needs ${want} touch point(s) and the device declares ${has}` };
}

// A device's continuous gravity reading goes by two names across the packs
// in this repository ("vector" in packs/web, "gravity" on the RP2350), and
// they mean the same signal. Matched as one rather than normalised in the
// device files, because those files describe what their own firmware
// declares and neither is wrong.
function sensorMatches(want: string, have: DeviceSensor): boolean {
  if (want === "vector" || want === "gravity") return have.kind === "vector" || have.kind === "gravity";
  return have.kind === want;
}

function sensorCheck(demands: Demands, device: DeviceJson): Check {
  const wanted = demands.sensors ?? [];
  if (wanted.length === 0) return { dimension: "sensors", status: "go", reason: "this app reads no sensors" };
  const declared = device.sensors ?? [];

  const costs: string[] = [];
  for (const demand of wanted) {
    if (declared.some((s) => sensorMatches(demand.kind, s) && (!demand.id || s.id === demand.id))) continue;
    if (demand.fallback && declared.some((s) => sensorMatches(demand.fallback!.kind, s) && (!demand.fallback!.id || s.id === demand.fallback!.id))) {
      costs.push(`no ${demand.kind} sensor, falling back to the declared ${demand.fallback.kind}: ${demand.fallback.cost ?? "cost not stated"}`);
      continue;
    }
    return {
      dimension: "sensors",
      status: "refuse",
      reason: `this app needs a ${demand.kind} sensor (${demand.why ?? "no reason stated"}) and the device declares ${declared.length === 0 ? "none at all" : declared.map((s) => `${s.id}:${s.kind}`).join(", ")}`,
    };
  }
  if (costs.length > 0) return { dimension: "sensors", status: "degraded", reason: costs.join("; ") };
  return { dimension: "sensors", status: "go", reason: `every sensor this app reads is declared (${wanted.map((d) => d.kind).join(", ")})` };
}

// ---- degrades ------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeDegrades(demands: Demands, device: DeviceJson): DegradeResult[] {
  const out: DegradeResult[] = [];
  const panel = device.panel;
  const ram = device.budget?.ram?.bytes;
  const perUnit = demands.memory?.perUnitBytes;
  const base = demands.memory?.baseBytes ?? 0;

  for (const [name, degrade] of Object.entries(demands.degrades ?? {})) {
    if (degrade.basis !== "panel-area") {
      // Unknown basis: reported as such rather than silently skipped. A
      // degrade nothing can compute is a claim with no number behind it.
      out.push({ name, what: degrade.what ?? name, value: degrade.reference, reference: degrade.reference, boundBy: `unknown basis "${degrade.basis}", so the reference stands` });
      continue;
    }
    if (!panel || !degrade.pixelsPerUnit) continue;
    const byPanel = Math.floor((panel.w * panel.h) / degrade.pixelsPerUnit);
    const byRam = perUnit && ram !== undefined ? Math.floor((ram - base) / perUnit) : Number.POSITIVE_INFINITY;
    const raw = Math.min(byPanel, byRam);
    const value = clamp(raw, degrade.min, degrade.max);
    const boundBy =
      value === degrade.max && raw >= degrade.max
        ? `the app's own cap of ${degrade.max}`
        : value === degrade.min && raw <= degrade.min
          ? `the app's own floor of ${degrade.min}`
          : byRam < byPanel
            ? `the ram budget (${byRam} would fit, the panel would hold ${byPanel})`
            : `panel area (${panel.w}x${panel.h} at one per ${degrade.pixelsPerUnit} px)`;
    out.push({ name, what: degrade.what ?? name, value, reference: degrade.reference, boundBy });
  }
  return out;
}

function memoryCheck(demands: Demands, device: DeviceJson, degrades: DegradeResult[]): Check {
  const want = demands.memory;
  if (!want || (want.baseBytes === undefined && want.perUnitBytes === undefined)) {
    return { dimension: "memory", status: "unchecked", reason: "this app states no memory demand" };
  }
  const ram = device.budget?.ram?.bytes;
  if (ram === undefined) {
    return { dimension: "memory", status: "unchecked", reason: "this target declares no budget.ram.bytes, and nothing here invents one" };
  }
  const unit = want.unit ? degrades.find((d) => d.name === want.unit) : undefined;
  const units = unit?.value ?? 0;
  const needed = (want.baseBytes ?? 0) + (want.perUnitBytes ?? 0) * units;
  const spelled = want.perUnitBytes ? `${want.baseBytes ?? 0} + ${want.perUnitBytes} x ${units} ${want.unit}` : `${needed}`;
  if (needed <= ram) {
    return { dimension: "memory", status: "go", reason: `${needed} bytes of app state (${spelled}) inside the ${ram} this target budgets` };
  }
  return { dimension: "memory", status: "refuse", reason: `${needed} bytes of app state (${spelled}) against a budget of ${ram}` };
}

function tickCheck(demands: Demands, device: DeviceJson): Check {
  const needs = demands.tick?.needsMs;
  if (needs === undefined) return { dimension: "tick", status: "unchecked", reason: "this app states no tick demand" };
  const budget = device.budget?.tickBudgetMs;
  if (budget === undefined) return { dimension: "tick", status: "unchecked", reason: "this target declares no budget.tickBudgetMs" };
  if (budget >= needs) return { dimension: "tick", status: "go", reason: `${budget}ms per tick against the ${needs}ms this app needs` };
  const floor = demands.tick?.refuseUnderMs;
  if (floor !== undefined && budget < floor) {
    return { dimension: "tick", status: "refuse", reason: `${budget}ms per tick, under the ${floor}ms below which this app stops being itself` };
  }
  return { dimension: "tick", status: "degraded", reason: `${budget}ms per tick against the ${needs}ms this app wants: it runs, slower` };
}

// ---- the paragraph -------------------------------------------------------

function humanLine(result: Omit<VerdictResult, "human">, device: DeviceJson): string {
  const target = device.name ?? result.target;
  const kind = result.targetKind === "silhouette" ? "silhouette" : "pack";
  const refusals = result.checks.filter((c) => c.status === "refuse");
  const costs = result.checks.filter((c) => c.status === "degraded");
  const unchecked = result.checks.filter((c) => c.status === "unchecked");

  const sentences: string[] = [`${result.app} on ${target} (${kind}): ${result.verdict}.`];
  if (refusals.length > 0) {
    sentences.push(`Refused because ${refusals.map((c) => `${c.dimension}: ${c.reason}`).join(", and because ")}.`);
  }
  if (costs.length > 0) {
    sentences.push(`${refusals.length > 0 ? "It would also cost" : "The cost is stated"}: ${costs.map((c) => `${c.dimension}, ${c.reason}`).join("; ")}.`);
  }
  const shrunk = result.degrades.filter((d) => d.value !== d.reference);
  for (const degrade of shrunk) {
    sentences.push(`It runs at ${degrade.value} ${degrade.name} against the reference ${degrade.reference} (${degrade.what}), bound by ${degrade.boundBy}.`);
  }
  if (refusals.length === 0 && costs.length === 0 && shrunk.length === 0) {
    sentences.push("Every dimension the app states is met by what the device declares.");
  }
  if (unchecked.length > 0) {
    sentences.push(`Unchecked: ${unchecked.map((c) => `${c.dimension} (${c.reason})`).join("; ")}.`);
  }
  if (device.provenance && device.provenance.verified !== true) {
    sentences.push(
      `This target is ${device.provenance.hypothetical ? "hypothetical and " : ""}unverified against silicon, so every number above came from a datasheet, not from a board.`
    );
  }
  sentences.push("A verdict is a comparison of two documents, never a prediction that the port runs.");
  return sentences.join(" ");
}

// ---- resolution ----------------------------------------------------------

function resolveApp(registry: Registry, name: string): { name: string; descriptor: string } {
  const entry = registry.apps.find((a) => a.name === name && a.path);
  if (!entry || !entry.path) {
    const known = registry.apps.filter((a) => a.path).map((a) => a.name).join(", ");
    die(`no app "${name}" with a local path in registry.json. Known: ${known}`);
  }
  const descriptor = join(REPO_ROOT, entry.path, "descriptor.md");
  if (!existsSync(descriptor)) die(`${entry.path} has no descriptor.md`);
  return { name: entry.name, descriptor };
}

function resolveTarget(registry: Registry, name: string): { name: string; kind: "pack" | "silhouette"; device: DeviceJson } {
  const pack = registry.packs.find((p) => p.name === name && p.path);
  const silhouette = (registry.silhouettes ?? []).find((s) => s.name === name && s.path);
  const entry = pack ?? silhouette;
  if (!entry || !entry.path) {
    const known = [...registry.packs, ...(registry.silhouettes ?? [])].filter((e) => e.path).map((e) => e.name).join(", ");
    die(`no pack or silhouette "${name}" in registry.json. Known: ${known}`);
  }
  const devicePath = join(REPO_ROOT, entry.path, "device.json");
  if (!existsSync(devicePath)) die(`${entry.path} has no device.json`);
  return { name: entry.name, kind: pack ? "pack" : "silhouette", device: readJson<DeviceJson>(devicePath) };
}

// ---- run -----------------------------------------------------------------

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const positional = argv.filter((a) => !a.startsWith("--"));
if (positional.length !== 2) {
  console.error("usage: puck verdict <app> <pack-or-silhouette> [--json]");
  process.exit(EXIT_INFRA);
}

const registry = readJson<Registry>(join(REPO_ROOT, "registry.json"));
const app = resolveApp(registry, positional[0]!);
const target = resolveTarget(registry, positional[1]!);
const demands = parseDemands(app.descriptor);

const degrades = computeDegrades(demands, target.device);
const checks: Check[] = [
  panelCheck(demands, target.device),
  buttonCheck(demands, target.device),
  touchCheck(demands, target.device),
  sensorCheck(demands, target.device),
  memoryCheck(demands, target.device, degrades),
  tickCheck(demands, target.device),
];

// A degrade that lands under its own reference is itself a cost, even when
// every dimension above is a fit: fluidbox on a small panel breaks nothing
// and is still not the app the descriptor describes.
const degradedByCount = degrades.some((d) => d.value < d.reference);
const worst = Math.max(degradedByCount ? WORST.degraded : 0, ...checks.map((c) => WORST[c.status]));
const verdict: VerdictResult["verdict"] = worst === WORST.refuse ? "refuse" : worst === WORST.degraded ? "degraded" : "go";

const partial: Omit<VerdictResult, "human"> = {
  app: app.name,
  target: target.name,
  targetKind: target.kind,
  verdict,
  checks,
  degrades,
};
const result: VerdictResult = { ...partial, human: humanLine(partial, target.device) };

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`${result.app} x ${result.target}: ${result.verdict.toUpperCase()}`);
  console.log("");
  const width = Math.max(...checks.map((c) => c.dimension.length));
  for (const check of checks) {
    console.log(`  ${check.dimension.padEnd(width)}  ${check.status.padEnd(9)} ${check.reason}`);
  }
  for (const degrade of result.degrades) {
    console.log(`  ${"degrade".padEnd(width)}  ${String(degrade.value).padEnd(9)} ${degrade.what}, against the reference ${degrade.reference}, bound by ${degrade.boundBy}`);
  }
  console.log("");
  console.log(result.human);
}

process.exit(verdict === "refuse" ? EXIT_REFUSE : EXIT_FIT);
