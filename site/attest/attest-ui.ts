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
// that board and diff the frames against the same recorded frames
// `bun run verify-bundle` compares against. Then the person can post the
// verdict, and the card counts it.
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
// verdict, the per-point results, the board family, and today's date. There
// is no identifier of any kind, no cookie is set or read, and nothing is
// measured about the browser.

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

/** MATCH/DIVERGE per capture point, in the order they were captured. */
function renderPoints(list: HTMLElement, result: AttestResult): void {
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
    // A matching frame's own number is worth printing: "164864 pixels
    // identical" is a different claim from "no error was reported".
    detail.textContent = point.match
      ? `${point.totalPixels} pixels identical`
      : `${point.diffPixels}/${point.totalPixels} pixels differ`;
    li.append(mark, label, detail);
    list.appendChild(li);
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
    statusEl!.textContent = "Loading this port's recorded frames…";

    try {
      if (!navigator.serial) {
        throw new Error("Web Serial isn't available in this browser, so a board can't be driven from this page. Use Chrome or Edge on desktop.");
      }
      const plan = await loadPlan(planUrl!);
      const framesBase = resolveFramesBase(planUrl!, plan.framesBase);

      // The port picker is opened from inside this click, which is the user
      // gesture Web Serial requires. Everything before it is a same-origin
      // fetch of files this page already ships.
      const link = new WebSerialLink({
        dataTerminalReady: plan.dataTerminalReady,
        appIndex: plan.appIndex,
      });

      const result = await runAttestation({
        plan: { ...plan, framesBase },
        link,
        report: (p) => {
          statusEl!.textContent = p.message;
        },
      });

      renderPoints(pointsEl!, result);
      const matched = result.points.filter((p) => p.match).length;
      verdictEl!.className = result.verdict === "match" ? "attest-verdict attest-verdict-match" : "attest-verdict attest-verdict-diverge";
      show(
        verdictEl,
        result.verdict === "match"
          ? `✓ Runs on this board: ${matched}/${result.points.length} frames matched the recorded ones, pixel for pixel.`
          : `This board drew something else: ${result.points.length - matched}/${result.points.length} frames diverged. That is a result worth posting too.`
      );
      hide(progressEl);

      const portSha = await fetchArtifactSha(planUrl!, plan.artifact);
      pending = {
        app: plan.app,
        pack: plan.pack,
        portSha,
        verdict: result.verdict,
        points: result.points,
        boardFamily: plan.boardFamily,
        date: todayISO(),
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
