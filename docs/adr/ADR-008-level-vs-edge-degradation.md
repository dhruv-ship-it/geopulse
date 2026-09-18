# ADR-008 — Degradation is a level, not an edge: periodic re-assertion

## Status

Accepted (WP3, S7). Closes defect D14.

## Context

Two components, each correct on its own terms, joined in a way that made the system report the
opposite of the truth for 2.2 simulated hours.

**`stream-processor` is edge-triggered.** `StateMachine.shouldAlert` returns true only when a zone
*changes* state. That is exactly right for a component whose original job was persisting
transitions to a history table: a transition is an event, it happens once, and repeating it would
be noise.

**The correlation window is level-expecting.** Its membership rule, from
`01-ARCHITECTURE.md` §5(b), is: *a zone is an active member while it has degraded within the
correlation window `W`.* That rule integrates a signal. It assumes the signal keeps arriving.

Nothing connected the two assumptions, and the first end-to-end run showed what that costs.

### What the run showed

`SCENARIO=regional-anomaly`, 400 zones, seed 42, a fault injected from 2160 s to 10800 s of event
time. Raw output in `benchmarks/results/wp3-e2e-regional-before-d14.txt`.

62 zones crossed into STRESSED between 2476 s and 2558 s — 109 transitions including the 47 that
went on to CRITICAL — and then **said nothing at all for the next 8,070 seconds**, because none of
them changed state again. They were all still degraded for every second of it.

The consequences, in order:

1. The correlation engine's event-time watermark froze at 2555 s. It holds no clock by design
   (that is deliberate — see `correlationEngine.ts`), so event time advances only because messages
   carry it.
2. Its 120-second window expired every member at 2680 s.
3. The incident **closed while the fault was still happening**. The system's considered opinion,
   for 2.2 simulated hours, was that nothing was wrong.
4. When the decay finally produced transitions at 10750 s, the engine fast-forwarded 1,610 grid
   ticks and opened *new* incidents — because CRITICAL → STRESSED is still a degradation, and it
   re-admitted zones that had long since been forgotten.

One injected fault, seven incidents, and a hole in the middle. The acceptance criterion — one
regional anomaly produces exactly one incident — failed, and it failed for a reason no unit test
could have reached, because both components did exactly what they were specified to do.

## Decision

**A still-degraded zone re-publishes its degradation every `DEGRADATION_REASSERT_MS` (default
30 s) of event time.**

`stream-processor` already sees every sensor event for every zone. When a zone is in a non-NORMAL
state and its last published degradation is more than the interval behind the current event time,
it publishes again — same schema, same partition key, current `avg1m` / `avg5m` / `severity`, with
`previousState === currentState` to mark it as a re-assertion rather than a transition.

The transition path and the re-assertion path go through one method, so the two cannot describe a
zone differently. A re-assertion carrying a stale severity would be worse than no re-assertion at
all, because it would look like evidence.

### Why not make membership permanent instead

The obvious alternative is to drop the window: a zone stays a member until an explicit recovery
arrives. It trades this defect for a worse one. A `stream-processor` that dies while holding
degraded zones never produces the recovery that would release them, so those zones stay in an
incident forever, and the incident is unclosable without operator intervention. Worse, the failure
is silent and looks exactly like an ongoing fault.

Time-bounded membership means **the system's belief decays in the absence of evidence**, which is
the property you want from anything that monitors. Re-assertion is what supplies the evidence. The
window is not the bug; the missing signal was.

### Why not have the correlation engine hold its own timer

It could close incidents on a wall clock instead of waiting for event time to advance. That breaks
replay determinism (rule 3 in `CLAUDE.md`), makes a 60× replay behave differently from a 1× one,
and — the deeper objection — it would be inventing a fact about the world from the local clock.
The engine would be asserting that a fault ended because nobody mentioned it recently. The
producer is the component that *knows* whether the zone is still degraded, so it is the component
that should say so.

### Choosing the interval

It must be comfortably below `CORRELATION_WINDOW_MS`. At 30 s against a 120 s window there are
four assertions per window, so it takes three consecutive publish failures to drop a zone out of
its incident. One assertion per window would mean a single lost message causes the incident to
flicker.

The cost is bounded and small, and it scales with *degraded* zones rather than with total zones:
one message per degraded zone per interval. The 62-zone reference fault is about 2 messages/second.
All 400 zones degrading simultaneously is about 13/second — against the 400/second of raw sensor
events the same service is already consuming, which is the honest comparison.

`DEGRADATION_REASSERT_MS=0` disables it, restoring the edge-only behaviour, so D14 is reproducible.

## Consequences

- **`zone.degradations` is now a mixed stream** of transitions and re-assertions, distinguished by
  `previousState === currentState`. Consumers that count state changes must filter; `alert-processor`
  persists both, which means `zone_alerts` gains a row per zone per interval during a fault. That is
  a real storage cost and it is the price of the topic meaning what its name says.
- **It makes an existing claim true.** ADR-000's amendment justifies dropping a failed sensor event
  on the grounds that "a degradation is one sample of a signal that is re-sampled every second".
  That was true of the *sensor* signal and false of the *degradation* signal at the time it was
  written. It is now true of both.
- **Message volume during a fault is now a function of fault duration**, not just fault size. A
  long fault costs more than a short one. Bounded, predictable, and the right trade for not losing
  the incident.
- **The window's meaning is now the one in the docs.** "Degraded within the last `W`" previously
  meant "changed state within the last `W`", which is a different and much weaker statement.
- D3 (no real watermarking) is still open and unrelated. Re-assertion advances the watermark far
  more often, which incidentally makes the frozen-watermark failure mode much harder to hit, but it
  does not address out-of-order lateness.

## Interview notes

The useful shape of this one is that **neither component was wrong**. The state machine emits edges
because a transition is an event; the correlation window integrates levels because membership is a
duration. Both are defensible in isolation, and the bug lived entirely in the seam — which is why
283 passing unit tests, a differential fuzz against an oracle with zero divergences, and property
tests over 156,773 invariant checks all had nothing to say about it.

The second useful point is what the failure looked like: not a crash, not an error, not a dropped
message. A confident, well-formed, fully-persisted answer that was wrong. The system reported seven
incidents with correct geometry, correct severities and clean lifecycles, and its opinion during the
worst 2.2 hours of the fault was that nothing was happening.
