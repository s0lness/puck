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

// site/attest/counters.ts
paintAttestCounters();
