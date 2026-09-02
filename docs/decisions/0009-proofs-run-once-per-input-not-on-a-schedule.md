# 0009: A proof runs once per input, not on a schedule

Date: 2026-09-02
Status: accepted

## The principle

`docs/roadmap.md` states it as the first of its principles: "once, per
input. A proof of pinned inputs does not decay. Nothing runs on a
schedule except one monthly canary for the runner itself." This record
exists to carry that sentence into `docs/decisions/`, since it already
shapes how every verification tool in this repository is meant to be
invoked, and a decision this load-bearing should not live only in a plan
that is explicitly allowed to go stale.

## Why this is the right unit of work

Every proof this repository makes is a function of pinned inputs: a
firmware source, a trace, a set of recorded frames, a commit sha. Given
the same inputs, `bun run verify-bundle` produces the same verdict every
time, by construction (`docs/convention/app-bundle.md`'s "listing is a
reproduction, not a submission"). A verdict computed from unchanged inputs
does not become less true by the clock advancing; re-running it on a
timer proves nothing a push, a PR, or a pin bump did not already prove,
and it costs a real build each time it runs for no new information.

So reproduction is event-driven: it runs when an input actually changes
(a push, a PR, a registry entry's commit sha moving) and never merely
because time passed. The one deliberate exception is a single monthly
canary for the runner itself - not for any pinned input, but for the
environment running the check (a toolchain version drifting, a dependency
disappearing). That is a different question from "did this app's proof
change," and it gets exactly one scheduled job, not a general license for
schedules.

## What this corrects

`docs/convention/publishing.md` currently describes CI as re-verifying
"on every PR, push, and nightly." The nightly leg is the gap this
principle names: a `schedule:` block re-running a check whose inputs have
not moved buys nothing a push-triggered run did not already buy, and it
is what has been silently absorbing a real external bundle's red status
for a week at a time with no one noticing sooner, because a schedule
looks like coverage without being new information. Removing it is
tracked as roadmap work, not done by this record; this record states why
that removal is correct rather than incidental cleanup.

## Consequences

- A new verification tool in this repository is wired to the input that
  can invalidate its verdict (a file changing, a commit sha bumping), not
  to a timer, unless it is checking the runner's own environment rather
  than a pinned input.
- A red result that "used to be green" is investigated as a real
  regression the moment its triggering input changed, not discovered days
  later by a schedule that happened to notice.
- `bun run pack:lint` (`tools/pack-lint.ts`) follows this shape: it is a
  fast, input-driven check meant to run on every change to a pack or its
  convention, not a periodic sweep.
