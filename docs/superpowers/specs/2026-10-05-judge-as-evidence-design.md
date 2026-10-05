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
// A `breach` verdict satisfies this condition on its own: for
// count_in_window, without the trigger count being met; for multi_sensor,
// without the other participants triggering. ABSENT = false, so no migration
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

**Applies to `count_in_window` AND `multi_sensor`.** On a `multi_sensor`
condition, one participant's breach verdict **satisfies the whole rule** — it
does not merely mark that participant satisfied.

That follows the same logic as the count: a `multi_sensor` AND exists because
any single PIR is noisy, and vision removes exactly that noise. A person
visibly in frame on one camera is stronger evidence than three PIRs agreeing
that *something* moved. Satisfying only the one participant would leave the
rule waiting for a second sensor that may never trigger, so vision would add
almost nothing.

An earlier draft scoped this to `count_in_window` only, on the grounds that
"a breach satisfies it" was ambiguous for an AND. The ambiguity is real but
it resolves the same way the count does, and leaving `multi_sensor` out has a
concrete cost in this project: **`תנועה כניסה מערבה` (`0x00927A`) sits in TWO
`multi_sensor` rules and no `count_in_window`, with cameras 1+3 ticked.**
Scoped to counts only, that sensor could never use vision evidence at all.

`quorum` interaction: a breach satisfies the rule outright, regardless of
`quorum`. A breach is not "one more satisfied participant" to be counted
against the quorum — it is independent evidence that the rule's question is
already answered. (Reducing the effective quorum by 1 was considered and
rejected: it adds a third interacting concept — quorum × breach × per-sensor
counts — for no gain over "fires".)

### Resolving WHICH condition a verdict satisfies

A sensor commonly belongs to several conditions, and `alarm_cause.ct` is a
condition **TYPE** index, not a rule id — the same limitation that forced
rule-derived certainty to be reverted on 2026-10-04. So the firing rule
cannot be identified from the cause.

It does not need to be. **The cloud scans every condition covering that
sensor in the device-active profile, and a breach fires if ANY of them has
`breach_satisfies`.** OR semantics, matching how rules already combine
(`AlarmState` fires on any satisfied condition).

This is deterministic — no dependence on Firestore document order, which is
precisely what made the old `rules.find(...)` approach non-deterministic — and
needs **no firmware change**. Carrying a rule id in `TriggerCause` was
considered and rejected: it is a firmware change plus another struct revision,
and the cause is written *before* the judge runs anyway.

Measured overlaps in this project's `default` profile, all three of which this
rule must handle correctly:

| Sensor | Conditions it belongs to |
|---|---|
| `חלון מרפסת` (`0x516A09`) | `count_in_window(n=2,w=30,g=15)` + `multi_sensor "תנועה במרפסת x2"` |
| `תנועה דלת כניסה` (`0x0061DA`) | `count_in_window(n=2,w=30,g=15)` + `multi_sensor "תנועה באיזור הדלת x2"` |
| `תנועה כניסה מערבה` (`0x00927A`) | `multi_sensor "תנועה במרפסת x2"` + `multi_sensor "תנועה באיזור הדלת x2"` |

Note the consequence for the first two: putting `breach_satisfies` on the
`count_in_window` but not the `multi_sensor` still fires on a breach, because
of the OR. Per-condition opt-in therefore controls *whether vision may fire at
all for this sensor*, not which rule gets the credit. If you need a sensor's
vision evidence to fire one rule but not another, that is not expressible —
and deliberately so, since "fires" is the only outcome either way.

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

### Verdict expiry — DERIVED from the cooldown, not a separate knob

The reuse window is **`captureCooldownSec` itself**, plus the time a verdict
takes to arrive. It is not an independent setting, because it is not a free
choice:

> A trigger arriving inside the cooldown **cannot** have images of its own, so
> the previous verdict is the only evidence that exists. Reuse is forced, not
> chosen.

Stated as an invariant: *the reuse window is exactly the period during which
fresh evidence is unobtainable.* Tie it to anything else and the two numbers
drift until either verdicts expire while no new ones can be taken (a gap
where the judge is silent for no reason), or stale verdicts outlive the point
where fresh ones were available.

A trigger arriving *after* the cooldown does get its own images, but the
verdict takes a few seconds to land. During that gap the previous verdict
remains usable — so precisely: **reuse the most recent verdict for the family
until a newer one exists, bounded by cooldown + judge latency.** Still
derived; still one knob.

Measured on hardware 2026-10-05 (capture → `onSnapshotUploaded` handling
both channels, including NVR grab, upload and function cold start):

| Trigger | Handled | Latency |
|---|---|---|
| 17:10:11 | 17:10:15 / :16 | ~4–5s |
| 17:10:41 | 17:10:44 / :47 | ~4–6s |
| 17:12:42 | 17:12:47 / :49 | ~5–7s |

So ~7s covers capture-to-verdict, and the project's `captureCooldownSec: 25`
is roughly 4x the measured need. The cooldown was originally sized for a
latency that has since improved.

All timestamps compared against the **snapshot's own `ts`**, never wall-clock
now — matching `isCauseFresh`, which is judged against the trigger's
timestamp rather than function-invocation time, for the same race-safety
reason.

**An earlier draft of this spec proposed asymmetric expiry** (safe stale
faster than breach, on the grounds that an empty yard 25s ago is weak
evidence it is empty now while a person seen 25s ago probably has not left).
That reasoning holds only for *long* cooldowns. Once the cooldown is ~10s the
distinction is worth almost nothing, and it costs two tunable numbers plus a
rule about their relationship. Dropped in favour of the derived window. Worth
revisiting only if a long cooldown is ever needed again.

### How the judge's alarm reaches the device: `commands/breach`

**DECIDED.** A new `/{projectId}/commands/breach = { rfId, ts, at }`, which
the device consumes exactly as it consumes `commands/fp` — same nonce-change
polling, same `{rfId, ts}` identity match.

Chosen over having the cloud write `state/siren_active` (as `onSensorEvent`
does, gated on `serverActions.triggerSiren`) because it keeps the siren
decision **on the device**, where every other siren decision already lives.
The cloud supplies evidence; the device decides what to do with it. That also
means `serverActions.triggerSiren` can stay `false` — the judge path does not
require turning on server-side rule evaluation, which is a separate behaviour
change with its own blast radius.

Symmetry with `commands/fp` is the point: `fp` is "stand down for this
{rfId, ts}", `breach` is "sound off for this {rfId, ts}". One mechanism, two
directions, and the device's existing advisory plumbing is the model to copy.

⚠️ `commands/breach` must be **strictly ADDITIVE**, the mirror of the
"strictly subtractive" rule on `fp` (`main.cpp`'s advisory handler may only
call `siren.turnOff()`). `breach` may raise the alarm and sound the siren for
a matching trigger; it must never arm/disarm and must never write to
`AlarmState`'s trigger history. See "What a `safe` verdict does" above for why
trigger history stays local and unrewritable.

## Open questions

1. **Does a wrong `breach` need bounding beyond `definiteBreach`?** The judge
   only ever sees frames *because a sensor fired*, so a breach verdict is
   always "one trigger + vision confirmation", never vision alone. Combined
   with per-sensor certainty (a wrong breach on a non-definite sensor lands
   at P0, not P2) this may be sufficient. Note the accuracy evidence is
   **6/6 on six real frames** — encouraging, not conclusive.

   Sharper now that `multi_sensor` is in scope: a breach collapses a 3-sensor
   AND to one trigger, so a single wrong verdict has more leverage than it did
   under `count_in_window` alone.

2. ~~Does lowering `captureCooldownSec` alone fix problem 1?~~ **Partly, and
   it is worth doing regardless.** Measured latency is ~7s (table above)
   against a cooldown of 25, so ~10 is defensible and already editable in
   Configure → Camera with no deploy. At 10s the alarming trigger of an
   18s-apart pair captures its own images and the judge runs today.

   It does NOT fix problem 1 in general: any `window_sec` shorter than the
   cooldown still strands the alarming trigger, and nothing stops a rule
   being written that way. Nor does it address problem 2 at all. So lowering
   it is a good immediate step and not a substitute for judging every armed
   trigger.

   Unknown: how the NVR behaves under more frequent OPSNAP grabs. Two
   channels every ~10s is well short of streaming, but it is untested.

3. **`judgeWaitSec` interaction.** The notification hold already built
   (2026-10-05) defers a non-definite sensor's notification pending a
   verdict. Under this design the verdict may now also *raise* the alarm, so
   the hold and the breach path need to agree on ordering. Specifically: a
   breach that RAISES an alarm should notify immediately rather than defer —
   there is nothing left to wait for, the verdict already arrived.

4. **Does the siren hold still make sense for a `breach_satisfies` rule?**
   `sirenHoldSec` delays a non-definite sensor's siren pending a verdict. If
   the verdict is what raised the alarm in the first place, holding it again
   would delay a confirmed breach. Likely answer: a `commands/breach`-raised
   alarm skips the hold entirely.

## Verification

Unit:

- `breach_satisfies` absent ⇒ behaviour identical to today, on both condition
  types (no migration).
- `count_in_window` + flag + breach ⇒ satisfied on one trigger, count waived.
- `multi_sensor` + flag + breach on ONE participant ⇒ whole rule fires,
  regardless of `quorum` and of the other participants' counts.
- flag + **safe** ⇒ falls back to ordinary counting / ordinary AND; the
  episode is suppressed but no trigger is removed from history.
- **Overlap resolution**, using this project's real shapes: a sensor in a
  flagged `count_in_window` AND an unflagged `multi_sensor` ⇒ breach fires
  (OR semantics). A sensor in two unflagged conditions ⇒ breach does not
  fire. Order of the conditions must not matter — assert both orderings, since
  Firestore document order is what made the old `rules.find(...)`
  non-deterministic.
- Verdict reuse bounded by `captureCooldownSec`, compared against the
  snapshot's `ts` rather than wall-clock now.

Hardware:

- `0x009BFA`, `breach_satisfies` on its `count_in_window`: two triggers 18s
  apart with an empty yard ⇒ no alarm; a person in frame on trigger 1 ⇒ alarm
  immediately, without waiting for trigger 2.
- `0x00927A` (`תנועה כניסה מערבה`, two `multi_sensor` rules, cameras 1+3):
  a person in frame on its trigger alone ⇒ alarm, without the other
  participants triggering. This is the case the earlier `count_in_window`-only
  scope could not serve at all.
- **Fail-safe: NVR cable pulled** ⇒ no verdict ever arrives ⇒ rules fall back
  to plain `count_in_window` / plain AND and alarm exactly as they do today.
  **This is the test that proves the cloud-independence claim and must not be
  skipped.**
- `commands/breach` is additive only: confirm a breach for a NON-matching
  `{rfId, ts}` is a logged no-op, and that it never changes arm state.
