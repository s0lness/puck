// site/attest/attest-ui.ts: the "prove it runs" section on a flash page.
// Bundled by site/build.ts into site/dist/flash/attest.js, the same way
// flash-ui.ts and esp32-ui.ts are bundled: one entrypoint, Bun.build, no
// CDN.
//
// WHAT THIS SECTION IS FOR. Until now, "runs on real silicon" was a line of
// prose in a bundle.json, typed by whoever last had a board on their desk,
// with a date they typed by hand (apps/chrono/bundle.json's own "silicon"
// block). This replaces that with the thing itself: the page just wrote
// firmware to a board, so the page can run that app's own recorded trace on
// that board and check the result the same way `bun run verify-bundle`
// checks that port. Then the person can post the verdict, and the card
// counts it.
//
// TWO KINDS OF CHECK, ONE WORD ONLY WHEN IT IS EARNED. A pixel-exact port
// is diffed frame by frame against its own recorded frames; an invariants
// port is put through its own bundle's invariants.ts, the same function,
// bundled into this page. Both are runs a board performed, both are
// counted, and the section says which one it ran rather than flattening
// them into one word (docs/decisions/0011).
//
// AND AN UNANSWERED CHECK IS NOT A PASSED ONE. An invariant that applies to
// this board but needs something a board does not report (fluidbox's
// panel-push bound needs the emulator's push instrumentation) comes back
// "unevaluable". The section shows it, says plainly that the run is
// incomplete, and offers no post button: a verdict computed as though that
// check had held would be the same kind of unbacked claim this whole step
// exists to replace.
//
// It is deliberately a SEPARATE gesture from flashing, and stays visible
// whether or not the flash happened in this tab: a board flashed five
// minutes ago is as attestable as one flashed five seconds ago, and tying
// the button to a successful flash in the same page load would just mean
// nobody with an already-flashed board could confirm anything.
//
// WHAT IS POSTED, and it is worth being able to read the whole list at a
// glance: the app name, the pack name, the sha256 of the artifact this page
// fetched (computed here, from the bytes, not taken from the build), the
// kind of check, the verdict, the per-point or per-invariant results, the
// board family, and today's date. There is no identifier of any kind, no
// cookie is set or read, and nothing is measured about the browser.

import { WebSerialLink } from "../../harness/links/webSerialLink";
import { onSections } from "../flasher/flash-ui-common";
import { paintAttestCounters } from "../attest-client";
import type { AttestPlan, AttestPost, AttestResult } from "./plan";
import { runAttestation, sha256Hex } from "./run";

const ATTEST_ENDPOINT = "/api/attest";

function el<T extends HTMLElement>(section: HTMLElement, selector: string): T | null {
  return section.querySelector<T>(selector);
}

function show(node: HTMLElement | null, text?: string): void {
  if (!node) return;
  if (text !== undefined) node.textContent = text;
  node.hidden = false;
}

function hide(node: HTMLElement | null): void {
  if (node) node.hidden = true;
}

function row(mark: string, markClass: string, label: string, detail: string): HTMLLIElement {
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

/**
 * One row per check, in the order the run produced them: MATCH/DIVERGE per
 * capture point for a pixel-exact run, PASS/FAIL/N/A/UNANSWERED per
 * invariant for an invariants one. Either way the row carries the check's
 * OWN number - "164864 pixels identical", "4789px differ, min required
 * 1500px" - rather than a bare mark, because the number is what makes it a
 * result instead of an assertion.
 */
function renderChecks(list: HTMLElement, result: AttestResult): void {
  list.textContent = "";
  for (const point of result.points) {
    list.appendChild(
      row(
        point.match ? "MATCH" : "DIVERGE",
        point.match ? "attest-point-match" : "attest-point-diverge",
        `${point.trace} at ${point.atMs}ms`,
        // A matching frame's own number is worth printing: "164864 pixels
        // identical" is a different claim from "no error was reported".
        point.match ? `${point.totalPixels} pixels identical` : `${point.diffPixels}/${point.totalPixels} pixels differ`
      )
    );
  }
  for (const inv of result.invariants) {
    const mark =
      inv.status === "pass" ? "PASS" : inv.status === "fail" ? "FAIL" : inv.status === "skip" ? "N/A" : "UNANSWERED";
    const cls =
      inv.status === "pass"
        ? "attest-point-match"
        : inv.status === "fail"
          ? "attest-point-diverge"
          : inv.status === "skip"
            ? "attest-point-skip"
            : "attest-point-unevaluable";
    list.appendChild(row(mark, cls, inv.name, inv.message));
  }
  list.hidden = false;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function loadPlan(url: string): Promise<AttestPlan> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`could not load this port's attestation plan (${url}): HTTP ${resp.status}`);
  return (await resp.json()) as AttestPlan;
}

async function fetchArtifactSha(planUrl: string, artifact: string): Promise<string> {
  const url = new URL(artifact, new URL(planUrl, window.location.href)).href;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`could not fetch the firmware artifact ${artifact} to identify it: HTTP ${resp.status}`);
  return sha256Hex(new Uint8Array(await resp.arrayBuffer()));
}

// The plan's frame URLs are relative to the plan file, not to the page, so
// that site/build.ts can move the attest directory without rewriting every
// plan. Resolved once, here.
function resolveFramesBase(planUrl: string, framesBase: string): string {
  return new URL(framesBase, new URL(planUrl, window.location.href)).href;
}

/** The one sentence under the run: what happened, in the vocabulary of the check that ran. */
function verdictSentence(result: AttestResult): string {
  if (result.kind === "pixel-exact") {
    const matched = result.points.filter((p) => p.match).length;
    return result.verdict === "match"
      ? `✓ Runs on this board: ${matched}/${result.points.length} frames matched the recorded ones, pixel for pixel.`
      : `This board drew something else: ${result.points.length - matched}/${result.points.length} frames diverged. That is a result worth posting too.`;
  }
  const held = result.invariants.filter((i) => i.status === "pass").length;
  const failed = result.invariants.filter((i) => i.status === "fail");
  if (result.incomplete) {
    const unanswered = result.invariants.filter((i) => i.status === "unevaluable");
    return (
      `This run is incomplete: ${unanswered.map((i) => i.name).join(", ")} cannot be answered by a board, only by the emulator. ` +
      `Nothing is posted, because a verdict that counted an unanswered check as a passed one would be a claim this run cannot support.`
    );
  }
  return result.verdict === "match"
    ? `✓ Runs on this board: all ${held} of this port's own invariants held on the frames it drew.`
    : `This board behaves differently: ${failed.length} of this port's own invariants failed (${failed
        .map((i) => i.name)
        .join(", ")}). That is a result worth posting too.`;
}

function wireAttestSection(section: HTMLElement): void {
  const planUrl = section.dataset.attestPlan;
  if (!planUrl) return;

  const runBtn = el<HTMLButtonElement>(section, ".attest-btn");
  const statusEl = el(section, ".attest-status");
  const progressEl = el(section, ".attest-progress");
  const pointsEl = el(section, ".attest-points");
  const verdictEl = el(section, ".attest-verdict");
  const errorEl = el(section, ".attest-error");
  const postWrap = el(section, ".attest-post");
  const postBtn = el<HTMLButtonElement>(section, ".attest-post-btn");
  const postedEl = el(section, ".attest-posted");
  if (!runBtn || !statusEl || !progressEl || !pointsEl || !verdictEl || !errorEl || !postWrap || !postBtn || !postedEl) return;

  let pending: AttestPost | null = null;

  async function attestOnce(): Promise<void> {
    hide(errorEl);
    hide(verdictEl);
    hide(postWrap!);
    hide(postedEl);
    pointsEl!.hidden = true;
    pending = null;
    runBtn!.disabled = true;
    show(progressEl);
    statusEl!.textContent = "Loading this port's own trace…";

    try {
      if (!navigator.serial) {
        throw new Error("Web Serial isn't available in this browser, so a board can't be driven from this page. Use Chrome or Edge on desktop.");
      }
      const loaded = await loadPlan(planUrl!);
      const plan: AttestPlan =
        loaded.kind === "pixel-exact" ? { ...loaded, framesBase: resolveFramesBase(planUrl!, loaded.framesBase) } : loaded;

      // The port picker is opened from inside this click, which is the user
      // gesture Web Serial requires. Everything before it is a same-origin
      // fetch of files this page already ships.
      const link = new WebSerialLink({
        dataTerminalReady: plan.dataTerminalReady,
        appIndex: plan.appIndex,
      });

      const result = await runAttestation({
        plan,
        link,
        report: (p) => {
          statusEl!.textContent = p.message;
        },
      });

      renderChecks(pointsEl!, result);
      verdictEl!.className = result.incomplete
        ? "attest-verdict attest-verdict-incomplete"
        : result.verdict === "match"
          ? "attest-verdict attest-verdict-match"
          : "attest-verdict attest-verdict-diverge";
      show(verdictEl, verdictSentence(result));
      hide(progressEl);

      // An incomplete run is shown in full and stops here: there is nothing
      // to hash and nothing to post. See this file's header.
      if (result.incomplete) return;

      const portSha = await fetchArtifactSha(planUrl!, plan.artifact);
      pending = {
        app: plan.app,
        pack: plan.pack,
        portSha,
        kind: result.kind,
        verdict: result.verdict,
        boardFamily: plan.boardFamily,
        date: todayISO(),
        ...(result.kind === "pixel-exact" ? { points: result.points } : { invariants: result.invariants }),
      };
      show(postWrap!);
    } catch (err) {
      hide(progressEl);
      // Every error that reaches here is already a full sentence (see
      // webSerialLink.ts's connect and devlinkProtocol.ts's error classes);
      // this renders it and adds nothing.
      show(errorEl, err instanceof Error ? err.message : String(err));
    } finally {
      runBtn!.disabled = false;
    }
  }

  async function postOnce(): Promise<void> {
    if (!pending) return;
    postBtn!.disabled = true;
    hide(errorEl);
    try {
      const resp = await fetch(ATTEST_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pending),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`the attestation was not accepted (HTTP ${resp.status}): ${text.slice(0, 200)}`);
      }
      show(postedEl, "Posted. This board's run now counts on the card.");
      hide(postWrap!);
      // Repaint straight away rather than on the next load, so the person
      // sees their own run land in the number they just changed.
      await paintAttestCounters(document, ATTEST_ENDPOINT);
    } catch (err) {
      show(errorEl, err instanceof Error ? err.message : String(err));
    } finally {
      postBtn!.disabled = false;
    }
  }

  runBtn.addEventListener("click", () => void attestOnce());
  postBtn.addEventListener("click", () => void postOnce());
}

onSections(".attest-section[data-attest-plan]", wireAttestSection);
// The flash page carries its own counter for this app+pack, filled from the
// same endpoint the cards use. Runs whether or not there is an attest
// section on the page.
void paintAttestCounters(document, ATTEST_ENDPOINT);
