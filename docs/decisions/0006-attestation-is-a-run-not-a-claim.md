# 0006: an attestation is a run somebody's board performed, not a date somebody typed

## The claim we could not keep

`bundle.json` has carried a `silicon` block since the first bench session:

```json
"silicon": {
  "attestedAt": "2026-08-14",
  "how": "differential harness run against the physical rp2350 board over USB serial, commit f1958c3: the idle stopwatch trace matched pixel-for-pixel at tolerance zero, 164,864 identical pixels."
}
```

Every word of that is true, and none of it is checkable. It is a sentence
about a run that happened once, on one board, on one desk, typed by hand
afterwards. `bun run verify-bundle` cannot reproduce it, so
[`app-bundle.md`](../convention/app-bundle.md)'s own rule ("listing is a
reproduction, not a submission") has exactly one hole in it, and this is
that hole. The date goes stale in silence: nothing about a rebuilt artifact,
a changed driver, or a board revision makes that string say anything
different.

It is also singular. A port either has one person's word for it or nothing.
"It works on my board" is the weakest possible form of the claim this
repository exists to make strong.

## The decision

**A flash page that can put firmware on a board can also make that board
answer for itself, and the answer is what gets counted.**

The gallery already flashes real hardware from the browser. So after a
flash, the same page:

1. loads that port's own recorded trace and recorded frames, the exact ones
   `bun run verify-bundle` uses,
2. replays the trace on the board over devlink through Web Serial
   (`harness/links/webSerialLink.ts`),
3. diffs every captured frame against the recorded one with the same
   `compareFrames` at the same tolerance zero,
4. shows MATCH or DIVERGE per capture point and a verdict,
5. and offers to post the result.

A card then says how many confirmed runs a port has and when the most recent
one was, from data, with no date typed by anybody.

## Three things this deliberately does not do

**It does not identify anybody.** The stored record is the app, the pack, the
sha256 of the firmware artifact the browser actually fetched, the verdict,
the per-point pixel counts, the board family and the server's own date. No
user agent, no cookie, no session, no fingerprint, and no field any of those
could later be joined on. [`site/README.md`](../../site/README.md) says the
same from the storage's side, key shape by key shape.

The one thing that touches a client at all is the rate limit, and its shape
is the promise rather than a note beside it: the connecting IP is hashed and
truncated, the key expires in sixty seconds, it lives under its own prefix,
and the read side never looks at it. A public endpoint with no limit at all
would be worse for everybody, including for the number's meaning.

**So it counts confirmations, not boards.** Nothing here can tell two runs
on one board from two runs on two, so the counter says "14 confirmations"
and never "14 boards". Saying "boards" would be a claim the data cannot
support, and the whole point of this change is to stop making claims the
data cannot support.

**It does not offer a weaker check to have something to say.** Only a port
verified pixel-exact gets a button, because only a pixel-exact port has
recorded frames to diff against. An invariants port has a checker instead,
and running a different, weaker check under the same word would make two
different things share one number on a card. Those ports get no button, and
that reads as what it is.

## Why a divergence is a result, not an error

A board that draws something else is evidence about that port on that
silicon, and it is posted with the same button and stored under the same key
prefix. An attestation system that only recorded agreement would be an
applause meter. `verdict` is a stored field with two values, the summary
counts both, and the endpoint refuses a `match` whose own per-point results
contradict it.

## What it costs

The verdict is only as good as the page's own decode path, which is why the
recorded frames are read back through `harness/png.ts`'s own parser with the
browser's `DecompressionStream` rather than through a canvas: canvas readback
goes through colour management, and a reference frame arriving a value or two
off would turn a tolerance-zero comparison into a divergence in the DIFF
rather than in the FIRMWARE. That is the failure mode
[`0004`](../../packs/rp2350-touch-amoled-18/docs/decisions/) in the pack
warns about, pointed at a new surface.

It also means one wire protocol now runs in two places, which is why
`harness/links/devlinkProtocol.ts` exists: the PowerShell bridge and the
browser transport share one implementation rather than agreeing exactly once,
on the day the second was written ([`0002`](0002-two-compilers-not-one.md)
makes the same argument about firmware).

And the counter is approximate, on purpose. The store is a KV namespace
rather than a relational one (the account is at its D1 limit), so the summary
is a read-modify-write with no compare-and-set: two posts for the same app
and pack inside one consistency window can lose an increment. What that
buys back is that every attestation is still its own key, so the summary is
derived data that can be rebuilt from the records at any time. A counter that
is occasionally one low is a fair price; a counter that could not be checked
against the runs behind it would not be.

## Status of the old field

`bundle.json`'s `silicon` block stays for now: it is the record of what was
actually done on the bench, and deleting it would lose that. What changes is
that it is no longer the only thing a reader has. Once a port has confirmed
runs behind it, the counter is the live number and the `silicon` block is
history.
