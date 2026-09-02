// Every invariants checker this gallery can run in a page, keyed by the
// path its own bundle.json names it at.
//
// WHY A STATIC TABLE AND NOT A DYNAMIC IMPORT. harness/invariantRun.ts
// loads a checker by PATH, at run time, which is what lets a new
// invariant-verified app need zero changes to the instrument. A page cannot
// do that: there is no filesystem, and a bundler has to see the import to
// put the code in the bundle. So the browser half is a table, and the cost
// of that is one line per app - paid here, in the gallery, not in the
// instrument, which still knows nothing about which apps exist.
//
// THE KEY IS THE BUNDLE'S OWN STRING, verbatim from
// bundle.json's verification.checker. Not a short name invented here: a
// plan built from a bundle carries what the bundle says, and a mismatch
// between the two is then a missing key rather than a plan quietly
// pointing at somebody else's checker. site/build.ts looks the key up at
// build time and refuses to emit a plan it cannot find, so a page never
// ships a button for a check it does not carry.
//
// These modules are pure functions of {frames, meta} and import their
// types from harness/invariantTypes.ts, which imports nothing but types.
// That is what makes them bundleable at all; see that file's header.

import { check as fluidbox } from "../../apps/fluidbox/invariants";
import { check as tinydraw } from "../../apps/tinydraw/invariants";
import { check as gameos } from "../../apps/gameos/invariants";
import type { InvariantChecker } from "../../harness/invariantTypes";

export const INVARIANT_CHECKERS: Record<string, InvariantChecker> = {
  "apps/fluidbox/invariants.ts": fluidbox,
  "apps/tinydraw/invariants.ts": tinydraw,
  "apps/gameos/invariants.ts": gameos,
};

export function checkerFor(path: string): InvariantChecker | null {
  return INVARIANT_CHECKERS[path] ?? null;
}
