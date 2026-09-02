# gotchas: the web platform's earned traps

The sibling packs' `gotchas.md` files are hardware traps found by
measurement and debugging. This is the same document for a different
device. Everything below was hit while building this pack or is carried
over from a failure this repository already paid for, with the date and the
evidence; nothing here is a general web-development tip.

## iOS motion permission only exists inside the tap

`DeviceMotionEvent.requestPermission()` is honoured by iOS Safari **only
while still synchronously inside the tap gesture that triggered it**. Call
it from a `then()`, a `setTimeout`, or after any `await`, and it rejects or
silently never resolves, with nothing in the console to say why.

`host/host.ts` therefore invokes every requester *before* its click handler
yields, and only then awaits the results. This is also why the tilt control
is a button a person presses rather than something the page turns on by
itself: there is no gesture to be inside of at load time, so a page that
tried would simply never get the sensor.

## The iOS accelerometer sign convention is MIXED, and only y is inverted

Validated on a physical iPhone on **2026-08-19**, not read off a spec:

- **x** (roll, left/right): iOS reports gravity's direction directly. No
  flip. Confirmed correct before the y fix below, since tilting left/right
  already poured the right way.
- **y** (pitch, up/down): iOS is **inverted** relative to x and z, i.e. it
  behaves like the spec/support-force convention, and must be negated.
  Tilting the phone's top away poured the wrong way until this was fixed.
- **z** (the face-up axis): gravity-direct, like x.

The W3C spec (which Android/Chrome follow) negates **all three**, because
its accelerometer reports the SUPPORT FORCE holding the device up against
gravity, which is sign-flipped from gravity's own direction on every axis.

Both paths have to land on the same ABI vector (`docs/abi.md`'s
`emu_sensor_vector`: x right, y down the panel, z into the screen), checked
against two anchors: flat face-up gives `(0, 0, -1)`, upright facing the
user gives `(0, 1, 0)`.

The reason this is a gotcha and not a footnote: getting it wrong does not
throw. It renders as fluid pouring toward the top of the screen, which
reads as a physics bug and sends you into the solver. The one reliable
feature probe for "this is iOS" is the presence of `requestPermission` on
these constructors; there is no user-agent test worth writing.

`host/host.ts` carries a copy of this mapping, and `src/motion.ts` carries
the original. They are duplicated on purpose (this pack must not import
`src/`), and the duplication is only safe because a wrong copy is visible
in the first second of use.

## touch-action: none, end to end, or Safari takes the gesture

Declaring `touch-action: none` on the canvas alone is not enough. Safari
decides a gesture is a scroll, a pull-to-refresh or a page swipe at the
**outermost** element that still allows it, so `html` and `body` need it
too, alongside `overscroll-behavior: none`. Without all of it, a drag
across the panel stops halfway through and the app sees the finger vanish -
which looks exactly like a dropped touch event.

The pointer handlers also call `setPointerCapture` and `preventDefault()`,
and `user-scalable=no` is in the viewport meta, so a fast double tap does
not zoom the "device" instead of reaching the app.

## Asset URLs need a content hash, or Safari serves yesterday's code

This one was paid for by this repository, on Sylve's own iPhone, before
this pack existed: a new deploy shipped, and Safari rendered the NEW HTML
next to the PREVIOUS deploy's JavaScript and CSS, because every asset URL
was stable across deploys and nothing told the cache to refetch. The result
was a page stitched together from two different builds, showing a hint line
next to a layout bug that had already been fixed.

So every URL host mode emits carries the first 10 hex of its own content's
sha256 **in the filename** (`emu.<hash>.wasm`, `host.<hash>.js`), and the
service worker's cache name is derived from those hashes. A content hash,
never a build timestamp: identical bytes must produce identical output, or
the pack's idempotency claim and `site/build.ts`'s own double-build check
both break.

## The service worker must never cache cross-origin

A cross-origin response is opaque: its status is unknowable, so a 404
caches as indistinguishable from a 200 and is then served forever. `sw.ts`
returns early for anything whose origin is not its own, and only stores
responses that are `res.ok && res.type === "basic"`. This app has no
cross-origin requests at all, which makes the rule free to enforce.

The same worker deletes every older `puck-web-*` cache on activate, so a
new build cannot leave a previous one's module lying around to be served
next to the new host bundle - the same failure as the section above, one
layer down.

## The wasm module must be same-origin

`WebAssembly.instantiate` over a cross-origin URL is blocked by any
reasonable CSP a static host ships, and would also defeat the service
worker rule above. The module is fetched by a **relative** filename from
the page's own directory, and the host build writes it into that directory.
A pack copied elsewhere keeps working for the same reason.

## innerHeight is not the visible height on iOS

`window.innerHeight` includes the area under Safari's own toolbars, so a
panel sized from it is partly hidden behind them and the bottom row of
buttons sits under the chrome. `host/host.ts` reads
`window.visualViewport` and falls back to `innerHeight` only where that API
does not exist, and re-lays-out on `visualViewport`'s own resize event,
which is the one that fires when the toolbars slide away.

Related, and why `viewport-fit=cover` plus `env(safe-area-inset-*)` padding
are both in the page: an installed copy on a notched phone otherwise paints
its bottom control row exactly where the system's home-indicator swipe
lives.

## zig cc does not only exit 5 for no reason, it also hangs

Both sibling packs document the exit-5 flake: `zig cc` fails with no
diagnostic text under this many `-Wl,--export=` flags, worse under
concurrent build load, and the identical command succeeds on the next
attempt. Measured (`tools/zigSpawn.ts`'s header comment): mostly this
repository's own build scripts previously spawning it with inherited
stdio while a parent process's stdout was itself a drained pipe, not a
zig linker crash - the artifact on disk is often complete and correct
even when the exit code says otherwise. Every build script now goes
through that shared helper, which pipes the child's stdio and checks the
artifact rather than the exit code, retrying only a genuinely silent
failure.

Observed twice on **2026-08-19** while building this pack's own site output:
the same bug can also HANG. A `zig` process sat at 0.02 seconds of CPU for
thirteen minutes on arguments that then compiled in seconds on a manual
retry. A retry loop that only catches a non-zero exit waits forever for
that one, and a build that never returns is worse than a build that fails,
because it looks like a build that is working.

`wasm/build.ts` therefore gives every attempt a 120-second timeout, many
times the roughly five seconds a real compile of these five files takes,
and treats the kill as just another failed attempt.

## Audio needs a user gesture too (not used here, stated so nobody re-derives it)

This pack declares no speaker and ships no sound, unlike the RP2350 pack
(whose timer app has an alarm). If sound is ever added: a browser will not
start an `AudioContext` outside a user gesture, and one created at load
time comes up `suspended` and stays that way, producing silence with no
error. The unlock has to be resumed from the same kind of tap the motion
permission above needs, and the honest place for it is the same control
row.

## The first painted frame has to be the whole panel

`emu_init()` pushes the full panel (the framebuffer clear, then the app's
`enter()`), but `emu_tick()` resets the push list at the start of every
tick, so those two pushes are gone by the time the host reads the first
frame's rectangles. An app that draws its background once in `enter()` and
never repaints it - chrono's colons, fluidbox's black field - would then
never appear.

`host/host.ts` paints the full panel once after the first tick and switches
to dirty rectangles from the second onward. This is a property of the ABI,
not of this host, so any other host for this pack needs the same rule.
