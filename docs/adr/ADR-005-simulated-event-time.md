# ADR-005 — Simulated event time: one virtual clock, bounded per-zone lag, adjustable speed

## Status

Accepted (WP6a, session S2a).

Numbered 005 because it is out of band with the Phase 1 design ADRs (001–004), which are still
unwritten: this decision was forced early by defect D8, which blocked WP2.

## Context

The simulator produced event timestamps like this:

```ts
let eventTimestamp = this.zoneClocks.get(zone.zoneId) || producedAt;
const processingDelay = 1 + (parseInt(zone.zoneId.replace('Z-', '')) % 20);
eventTimestamp = Math.min(eventTimestamp + processingDelay, producedAt);
```

Each zone kept its own clock, seeded at wall-clock time on its first event and thereafter
advanced by a constant **per event** rather than by elapsed time. Two things followed, and the
second is the one that mattered:

1. Event time ran at *(events per second for that zone) × (that zone's delay)* — between 0.5%
   and 10% of real time. The state machine needs 60 s of event time to confirm `STRESSED`, so a
   short run produced no transitions at all. WP0's live verification ran 120 seconds and saw
   zero.
2. **The rate differed per zone**, because the delay came from the zone number. Zones drifted
   apart from each other without bound — 5.7 seconds of spread after one simulated minute, hours
   after a day (`benchmarks/results/d8-simulator-event-clock.txt`).

Phase 1 exists to answer one question: *did these adjacent zones degrade within the same
window?* Against a simulator where every zone lives in its own time frame, the answer is always
no, no matter what the physical scenario says. The correlation engine would have reported no
incidents, correctly, and the eval harness would have scored it at zero recall — and the bug
would have looked like a bug in the correlation engine.

So the decision could not be "patch the arithmetic". It had to be an event-time model.

## Decision

**One `VirtualClock`, shared by every zone, with simulated time a pure function of the tick
count:** `now() = SIM_START_EPOCH_MS + ticks × SIM_STEP_MS`. No wall-clock read, no
accumulation, no per-zone state. Two zones therefore cannot drift, by construction rather than
by discipline.

**Per-zone sensor lag stays, as a bounded offset:** `eventTime = clock.now() − lagMs(zoneId)`,
with `lagMs` in [0, 20] derived by hashing the zone id. Out-of-order arrival across zones is
realistic and the consumer should face it; what it must not do is compound. The hash (rather
than `zoneNumber % 20`) breaks the correlation the old code had between lag and zone identity,
which would otherwise have biased any measurement that groups zones geographically.

**`producedAt` comes from the same clock.** Every field on the record is then reproducible. If
real ingest lag is worth measuring later, that is a separate field stamped by the *consumer* on
receipt — a different quantity that only the consumer can honestly observe.

**`SPEED_MULTIPLIER` decouples simulated time from real time.** Pacing lives in
`SimulationLoop`, which owns the only wall-clock read left in the simulator and uses it purely
to decide when to fire. Because timestamps come from the tick count, a 60x run emits *exactly*
the same events with exactly the same timestamps as a 1x run — it just takes a sixtieth of the
wall clock. That is what makes evals practical: a 60 s confirmation window elapses in one real
second.

Event ids became v5 (name-based) UUIDs over `zoneId:eventTimestamp`. A v4 id is random, so two
runs of the same scenario differed byte for byte — which defeats the point of a deterministic
simulator, and would have made replay diffs useless.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| **Keep wall-clock event time** (`eventTimestamp = Date.now()`) | Simple and correct on the divergence question, but it forbids speed control, and every run becomes unreproducible: the same scenario yields different timestamps, so no benchmark or eval is re-derivable. Violates CLAUDE.md rule 3. |
| **Fix the accumulator's rate** — advance each zone's clock by elapsed wall time since its last event | Removes the 0.5–10% problem but keeps a per-zone clock, so zones still drift with jitter and uneven throughput. The divergence would have been smaller and therefore harder to notice, which is worse: the correlation results would have been subtly wrong instead of obviously wrong. |
| **One clock, no per-zone lag at all** | Cleanest, and tempting. Rejected because it removes the out-of-order arrival the consumer must handle, and because D3 (watermarking, deferred to Phase 3) needs something real to watch. A simulator that hands the consumer a perfectly ordered stream is not testing the consumer. |
| **Random per-event jitter instead of a fixed per-zone lag** | More realistic in shape, but `Math.random()` is banned in this path and a seeded PRNG would need per-zone state threaded through a static generator. A deterministic hash of the zone id gives a fixed lag per zone, which is enough to produce out-of-order arrival; per-event jitter is a WP6a refinement if a scenario ever needs it. |
| **Drive speed by scaling `SIM_STEP_MS` instead of adding a multiplier** | Would work, but it changes the *content* of the run: fewer, coarser samples. The whole value of the multiplier is that speed and content are independent, so a fast eval run and a slow demo run are the same run. |

## Consequences

- **Every measured number is reproducible.** Same config ⇒ byte-identical event stream, at any
  speed. This is the precondition for `evals/` meaning anything.
- **Evals become minutes, not hours.** A 60 s confirmation window costs 1 s of wall clock at
  60x; a 10-minute scenario costs 10 s. Measured in
  `benchmarks/results/d8-simulator-event-clock-after.txt`.
- **Simulated time starts in the past and repeats between runs.** Two runs write overlapping
  event timestamps, so Redis/Postgres state from a previous run is not distinguishable by time
  alone. Drop state between measured runs — already required for other reasons.
- **The real event rate is now derived**, not configured:
  `NUM_ZONES × (1000 / SIM_STEP_MS) × SPEED_MULTIPLIER` per real second. `EVENTS_PER_SECOND` is
  gone; it conflated sampling density with simulation speed.
- **Speed is bounded by the pipeline, not the clock.** At high multipliers the producer is
  asked for proportionally more events per real second (600/s at 60x with 10 zones, 12,000/s at
  600x with 20). The clock batches steps per firing to stay within what a timer can honour, but
  the real ceiling is Kafka throughput — an eval that wants 600x needs that checked first.
- **A watermark now has something coherent to watch** (D3): lateness is bounded at 20 ms by
  construction, so a watermark of `maxEventTime − 20ms` is exactly right rather than a guess.

## Verification

`services/sensor-simulator/src/__tests__/eventClock.test.ts` pins the four properties: event
time advances at exactly `SPEED_MULTIPLIER` × real rate; all zones stay within the lag bound
over a 24-hour simulated run; the same configuration produces byte-identical output; and
changing only the speed changes nothing about the events.

Live, against the full stack at 60x: all ten zones reached `STRESSED` within a **17 ms** spread
of event time — inside the 20 ms lag bound — about 2.5 seconds after the simulator started.
The same pipeline in WP0 produced zero transitions in 120 seconds.
