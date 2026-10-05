# The AI judge as evidence, not just a filter

**Date:** 2026-10-05
**Status:** design, awaiting approval
**Supersedes the judge's role as defined in**
[camera snapshots](2026-10-03-camera-snapshots-on-trigger-design.md) and
[breach certainty](2026-10-04-per-sensor-breach-certainty-design.md) — both
of which treat the judge as something that only ever adjusts an alarm the
rules already raised.

## Problem

Two problems, found on hardware on 2026-10-05. The first is a bug in the
current design; the second is a limitation of the idea behind it.

### 1. The judge is structurally unreachable for multi-trigger rules

`onSnapshotUploaded` judges a snapshot only when a fresh `alarm_cause`
matches it — "was this trigger the one that alarmed?". For a
`count_in_window` rule that is almost never the trigger whose images exist:

| | Captures? | Alarms? | Judged? |
|---|---|---|---|
| Trigger 1 | **yes** | no (count not met) | **no** — no `alarm_cause` yet |
| Trigger 2 | **no** — inside `captureCooldownSec` | **yes** | no images to judge |

With `captureCooldownSec: 25` and `window_sec: 30`, any qualifying pair has
its second trigger inside the cooldown. So trigger 1's images are discarded
unjudged, trigger 2 has none, and **the judge never runs at all**.

Measured 2026-10-05, three capture sets on `0x009BFA`, all logged:

```
onSnapshotUploaded: no fresh matching alarm_cause for rfId=0x009BFA
  ts=1791209411000 — skipping judge
```

and the trigger that *did* alarm (17:13:01) produced no snapshot at all. This
also means the "VERIFIED on hardware 2026-10-04" judge results came from
single-trigger paths only; the multi-trigger path has never worked.

### 2. `count_in_window` is a proxy for evidence the judge supplies directly

The reason `count_in_window` exists is noise reduction: one PIR trigger is
weak evidence, so demand two. But **two unjudged triggers are weaker
evidence than one trigger plus "a person is visible in frame"** — a cat
pacing a yard satisfies 2-in-30s, and no amount of counting distinguishes it
from a person.

So the current architecture has it backwards. It treats the rule as the gold
standard and the judge as a filter that may only soften the rule's verdict.
In fact the judge supplies the *stronger* signal, and the count is the
fallback for when vision is unavailable.

## Design

**Two independent evidence paths to one conclusion.** Neither is a filter on
the other.

| Path | Evidence | Available when |
|---|---|---|
| **Vision** | "a person is in frame" | online, NVR up, judge responds |
| **Count-in-window** | "repeated motion" | **always** — pure local device logic |

This *preserves* "alarm logic never depends on the cloud" (CLAUDE.md). The
device keeps its complete rule set and alarms on its own when the cloud is
absent, slow, or has no opinion. The judge only ever adds a faster, better
path. Degradation is graceful by construction rather than bolted on.

### Judge every armed trigger, not only alarming ones

The armed gate changes from *"did this trigger alarm?"* to *"was the system
armed?"*. Every armed trigger's images are judged as they arrive, and the
verdict is recorded whether or not an alarm has fired.

This is what breaks the deadlock in problem 1: trigger 1 is judged on
arrival, so by the time trigger 2 completes the count there is already a
verdict on file for the episode.

### Verdict reuse inside the cooldown

A trigger arriving while `captureCooldownSec` is still running has no images
of its own. It **inherits the most recent verdict for its own family**,
subject to an expiry (below). Without this, trigger 2 would be unjudged and
fall through to an ordinary alarm, making trigger 1's verdict pointless.

The cooldown stops being a blind spot and becomes a cache.

### `breach_satisfies` — an opt-in on the CONDITION

A new optional field on `Condition`, beside `min_gap_sec`:

```ts
// count_in_window only: a `breach` verdict satisfies this condition on its
// own, without the trigger count being met. ABSENT = false, so no migration
// and every existing rule is unchanged.
breach_satisfies?: boolean;
```

**On the condition, not the sensor.** This matters: a sensor commonly belongs
to several rules at once — `תנועה דלת כניסה` sits in a 1-member
`count_in_window` *and* a 2-member `multi_sensor`. A per-sensor flag would
apply to both indiscriminately. Per-condition lets the yard rule accept
vision evidence while the multi-sensor rule keeps demanding two sensors.

It is also semantically honest: the judge is not a property of a sensor, it
is an alternative way to satisfy a condition's evidence bar — which is
exactly what `count`, `window_sec` and `min_gap_sec` already express.

And it avoids overloading `definiteBreach`, which picks a notification tier
and should keep meaning only that.

**Scoped to `count_in_window` only**, like `min_gap_sec` was. On a
`multi_sensor` condition "a breach satisfies it" is ambiguous — one
participant's breach, or the whole AND? Deferred until there is a concrete
need.

### What a `safe` verdict does

A safe verdict **suppresses the alarm for this episode**, whether it arrives
before the alarm or after it.

This corrects an inconsistency in the earlier design discussion, where
suppressing an *already sounding* siren (which `commands/fp` does in
production today) was treated as acceptable while *preventing* the same
siren was not. Preventing is strictly less drastic than retracting — the
same decision, made earlier, with less noise in between. There is no
principled line between them.

The real constraint is narrower, and it stands:

| What `safe` does | Allowed? |
|---|---|
| Suppress the **alarm decision** for this trigger episode | **Yes** — identical in effect to `fp`, just earlier |
| Delete the trigger from **`AlarmState`'s history** | **No** |

A trigger is never retracted from the count. The device's trigger history is
local, EEPROM-adjacent state that survives cloud outages; letting the cloud
rewrite it would corrupt every later window, and the device cannot be told to
selectively forget. `main.cpp`'s advisory handler stays **strictly
subtractive** — it may call `siren.turnOff()` and nothing else.

So: the episode is suppressed, the witnesses remain counted.

### Verdict expiry — deliberately asymmetric

A reused verdict goes stale, and **safe goes stale faster than breach**:

- An empty yard 25s ago is weak evidence it is empty *now*.
- A person seen 25s ago is strong evidence someone is *still there*.

A single number for both would be tidier and wrong in the direction that
matters. Proposed: `safe` reusable for ~10s, `breach` for ~60s, both measured
from the **snapshot's own `ts`** (not wall-clock now), matching how
`isCauseFresh` is already judged against the trigger's timestamp rather than
function-invocation time.

Exact values are tuning, not architecture; they belong in project config.

## Open questions

1. **Who raises the judge's alarm?** Two options:
   - **Cloud writes `state/siren_active`**, as `onSensorEvent` already does,
     gated on `serverActions.triggerSiren` — currently `false` in this
     project, so the server has never sounded the siren.
   - **New `commands/breach`**, which the device consumes exactly as it
     consumes `commands/fp`. Symmetrical, keeps the siren decision local,
     and arguably the better fit with the rest of the design.

   Leaning toward `commands/breach`.

2. **Does a wrong `breach` need bounding beyond `definiteBreach`?** The judge
   only ever sees frames *because a sensor fired*, so a breach verdict is
   always "one trigger + vision confirmation", never vision alone. Combined
   with per-sensor certainty (a wrong breach on a non-definite sensor lands
   at P0, not P2) this may be sufficient. Note the accuracy evidence is
   **6/6 on six real frames** — encouraging, not conclusive.

3. **Does lowering `captureCooldownSec` alone fix problem 1?** Dropping 25 → 8
   would let the alarming trigger capture its own images, making the judge
   work with **no code changes**. Worth testing first. It does not address
   problem 2, and it leaves correctness dependent on two numbers being tuned
   relative to each other — which is the thing this design removes. Unknown:
   how the NVR behaves under more frequent OPSNAP grabs.

4. **`judgeWaitSec` interaction.** The notification hold already built
   (2026-10-05) defers a non-definite sensor's notification pending a
   verdict. Under this design the verdict may now also *raise* the alarm, so
   the hold and the breach path need to agree on ordering.

## Verification

- Unit: `breach_satisfies` absent ⇒ identical to today (no migration);
  present + breach ⇒ condition satisfied on one trigger; present + safe ⇒
  falls back to ordinary counting; reuse honours each expiry; a safe verdict
  never alters trigger history.
- Hardware: two triggers 18s apart on `0x009BFA` with `breach_satisfies` on —
  empty yard ⇒ no alarm; a person in frame on trigger 1 ⇒ alarm immediately,
  without waiting for trigger 2.
- Hardware, fail-safe: NVR cable pulled ⇒ no verdict ever arrives ⇒ the rule
  falls back to plain `count_in_window` and alarms on two triggers as it does
  today. **This is the test that proves the cloud-independence claim.**
