# 0014: the front door is a store: one card per app, the app for the device looking at it

## What was wrong with the matrix as a front page

[0012](0012-the-gallery-is-built-from-a-ledger.md) made the landing page the
matrix: five apps down, nine devices across, forty-five cells, each with a
picture, a row of chips, and a sentence folded behind every chip. Every
claim on it is computed and every one of them is true.

The verdict on it, from the person who asked for it: **"absolutely
unreadable."**

That is not a complaint about the matrix. It is a complaint about what a
first screen is for. A stranger arriving at `puck.sylve.org` is asking one
question, "what is this and can I see it", and the page answered a different
one, "which of forty-five combinations has been verified and by what". The
matrix is the PROOF. A proof is not a front door.

## The decision

**`/` is a store. `/matrix/` is the proof.**

The front page is the shape a phone's app store already taught everybody to
read: a grid of cards, one per app, each carrying a picture, the app's name,
its one line, and one button that says `Run`. No chips, no marks, no
reasons, no paragraph of explanation. The header is the name, one tagline,
and one link, `all devices`, to `/matrix/`.

The matrix moved there whole, unchanged - the same cells, the same three-way
`data-cell` rule, the same folded reasons, the same reference tiles and the
same note about silhouettes - one directory down, with a link back.
`site/build.ts`'s `MATRIX_DEPTH` is that one directory, named once, because
every relative href on that page is now one level up and a missed one is a
404 nobody sees until a cell is clicked.

**`Run` opens the version that is canonical for the device that is asking**,
decided by viewport at load and on resize, never by a user-agent string:

| the device asking | what `Run` opens | why |
|---|---|---|
| a desktop, a fine pointer | `/run/<app>-web.html`, the app inside the emulator, device drawn around it | the browser showing the page is not the device the visitor is imagining; the chrome is what makes it one |
| a phone (`pointer: coarse`, or under 700px) | `/web/<app>/`, packs/web's own host build | a phone IS one of the target devices ([0006](0006-the-browser-is-a-device-pack.md)): real accelerometer, on-screen buttons, installable, offline once installed |

`(pointer: coarse)` first and width second: the media query is the browser
saying what the person is actually touching the page with, and the width is
the fallback for a browser that answers nothing and for a narrow desktop
window, where the phone build is the better answer anyway.

An app with **no** web port - `gameos`, and the external
`aliceisjustplaying/tinydraw` bundle - runs its closest module in the
emulator on both, and its card carries one quiet line saying which device it
is running as, so nobody has to assume.

## What this needed that did not exist

**Web-pack run pages.** `site/build.ts` used to skip the web pack in
`buildRunDir()`, on the argument that there is no emulator to embed when the
device is the browser already showing the page. True for a phone, and that
is still where a phone goes. On a desktop the argument runs the other way:
the visitor wants the device, so the web module gets a run page like every
other combo. Both surfaces exist now and the page picks.

**A module for an app published in somebody else's repository.** The
external bundle's card has to run something, and nothing here compiles it:
it comes out of that repository's own build command, at its own pin
([0005](0005-external-ports-are-reproduced.md)). That command wants a WASI
clang++, cmake and ninja, none of which this repository can vendor, so
making `site:build` depend on it would break the build on every machine that
happens not to have them, for a reason that has nothing to do with the site.

So the artifact is tracked, exactly the way `site/flash-artifacts/` already
is: `bun run site:external-modules` clones at the pin, runs their command,
and writes `site/external-modules/<app>-<pack>.wasm` plus an `index.json`
recording repo, commit, command, artifact path and the module's own sha256.
`site/build.ts` copies it out and reads the panel, buttons and sensors from
the **module's own `emu_device()`**, because this repository carries no
`device.json` for a pack somebody else maintains and the module is the only
thing here that knows which board it was built for.

## The proof

`scripts/verify-landing.ts` (`bun run site:verify-landing`) drives the built
front page through a real Chrome twice:

- **at 1400px**: one card per app in the ledger, in a grid of at least three
  columns; every card's recorded loop, poster and gif fallback resolve; every
  `Run` points into `/run/` and opens; every card's `runs on N devices` line
  matches the count the ledger itself gives for that app; no card carries a
  chip, mark or badge; the last card's loop mounts only once scrolled into
  view and then really plays.
- **at 390px with a coarse pointer emulated through CDP** (not merely a
  narrow window, or the check would prove the fallback and leave the actual
  pointer rule untested): every app with a web port hands `Run` its own
  `/web/<app>/`, every app without keeps the emulator, the page does not
  scroll sideways, the first card fits the viewport with its picture
  dominant, and the button is at least 44px tall.

`scripts/verify-matrix.ts` is unchanged in what it asserts and re-pointed at
`/matrix/`, resolving each cell's href against that page rather than the site
root - reading them as root-relative would silently pass a link that is one
directory off.

## What was deliberately left out

**An `Install` button beside `Run` on phones.** On a phone `Run` already
opens the installable host build; a second button to the same URL is a
second thing to read for no second outcome. The install affordance is the
browser's own, on the page it opens.

**Autoplay on every card.** The loops carry no `autoplay` and no `src`, only
a poster and a `data-src`, and the page mounts them on intersection. Five
cards that all start at once is five downloads a phone did not ask for
before the visitor has scrolled to any of them.
