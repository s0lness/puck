// The read side of /api/attest, and the words a card says when nobody has
// confirmed anything yet.
//
// Shared by the two surfaces that show the same number: the gallery's app
// cards (site/build.ts's card template) and the "prove it runs" section on
// each flash page (site/attest/attest-ui.ts). One fetch shape, one empty
// state, one way of saying how long ago - three copies of that would drift
// the first time the wording changed on one page and not the others.
//
// GRACEFUL WHEN THE ENDPOINT IS ABSENT, and that is not a nicety. site/dist/
// is a static build that this repository serves from a plain file server in
// its own headless checks, opens straight off disk during development, and
// which anyone can clone and serve themselves. In all of those there is no
// Pages Function and no D1 behind /api/attest, so fetchAttestations()
// resolves to null and every caller renders the empty state rather than an
// error. A counter that turned into "failed to load" on a local preview
// would be worse than no counter.
//
// NOTHING PERSONAL CROSSES THIS BOUNDARY, in either direction. The GET sends
// no credentials and no identifier, the POST carries no identifier either
// (see site/attest/plan.ts's AttestPost), and no cookie is set or read by
// any of it.

/** One app+pack pair's standing, as GET /api/attest reports it. */
export interface AttestationCount {
  app: string;
  pack: string;
  /**
   * How many confirmed runs, NOT how many distinct boards. Nothing here
   * identifies a board, on purpose, so two runs from one person's own board
   * count twice and there is no honest way to tell them apart. The UI says
   * "confirmations" for that reason: "14 boards" would be a claim this data
   * cannot support.
   */
  confirmations: number;
  /** ISO date (YYYY-MM-DD) of the most recent matching run, or null when there is none. */
  lastConfirmedAt: string | null;
  /** Runs that came back diverged. Shown nowhere yet; carried so a card can stop lying by omission later. */
  diverged: number;
}

export interface AttestationIndex {
  /** Keyed "<app>:<pack>". */
  counts: Record<string, AttestationCount>;
}

export function attestationKey(app: string, pack: string): string {
  return `${app}:${pack}`;
}

/**
 * Reads the whole index in one request. Returns null, never throws, when the
 * endpoint is not there (a static preview), is unreachable, or answers with
 * something that is not the shape below.
 */
export async function fetchAttestations(endpoint = "/api/attest"): Promise<AttestationIndex | null> {
  let resp: Response;
  try {
    resp = await fetch(endpoint, { headers: { accept: "application/json" } });
  } catch {
    return null; // no endpoint here: a static build, or offline
  }
  if (!resp.ok) return null;
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || !("counts" in body)) return null;
  const counts = (body as { counts: unknown }).counts;
  if (!counts || typeof counts !== "object") return null;
  const out: Record<string, AttestationCount> = {};
  for (const [key, value] of Object.entries(counts as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Partial<AttestationCount>;
    if (typeof v.confirmations !== "number") continue;
    out[key] = {
      app: typeof v.app === "string" ? v.app : key.split(":")[0]!,
      pack: typeof v.pack === "string" ? v.pack : key.split(":").slice(1).join(":"),
      confirmations: v.confirmations,
      lastConfirmedAt: typeof v.lastConfirmedAt === "string" ? v.lastConfirmedAt : null,
      diverged: typeof v.diverged === "number" ? v.diverged : 0,
    };
  }
  return { counts: out };
}

/** The one sentence a counter shows before anybody has run the trace on a board. */
export const ATTEST_EMPTY_STATE = "no board has confirmed this yet";

// Days, not hours: an attestation is a thing somebody did at a desk, and
// "3 hours ago" would imply a precision the stored date (a day) does not
// have.
function daysBetween(fromISO: string, now: Date): number | null {
  const then = Date.parse(`${fromISO}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((today - then) / 86400000));
}

export function describeAge(lastConfirmedAt: string | null, now = new Date()): string {
  if (!lastConfirmedAt) return "";
  const days = daysBetween(lastConfirmedAt, now);
  if (days === null) return "";
  if (days === 0) return "last confirmed today";
  if (days === 1) return "last confirmed yesterday";
  return `last confirmed ${days} days ago`;
}

/**
 * The counter's full text for one app+pack. `null` (no endpoint) and zero
 * confirmations deliberately read the same: from a visitor's side there is
 * no difference between "nobody has confirmed this" and "we cannot tell you
 * whether anybody has", and inventing a third state would only be honest
 * about our own plumbing.
 */
export function describeAttestation(count: AttestationCount | undefined | null): string {
  if (!count || count.confirmations === 0) return ATTEST_EMPTY_STATE;
  const runs = count.confirmations === 1 ? "1 confirmation" : `${count.confirmations} confirmations`;
  const age = describeAge(count.lastConfirmedAt);
  return age ? `${runs} · ${age}` : runs;
}

/**
 * Fills every element carrying data-attest-app/data-attest-pack with its own
 * counter text. One fetch for the whole page, and the empty state is already
 * in the HTML before this runs, so a page with no endpoint behind it never
 * flashes a placeholder.
 */
export async function paintAttestCounters(root: ParentNode = document, endpoint = "/api/attest"): Promise<void> {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-attest-app][data-attest-pack]"));
  if (nodes.length === 0) return;
  const index = await fetchAttestations(endpoint);
  for (const node of nodes) {
    const app = node.dataset.attestApp!;
    const pack = node.dataset.attestPack!;
    const count = index?.counts[attestationKey(app, pack)];
    node.textContent = describeAttestation(count);
    node.classList.toggle("attest-counter-empty", !count || count.confirmations === 0);
  }
}
