# ADR-007 — A Kafka record timestamp is not application event time

**Status.** Accepted (S2c — D10).
**Context.** Defect D10, `docs/01-ARCHITECTURE.md` §3.4. Evidence:
`benchmarks/results/d10-root-cause.txt`.
**Relates to.** ADR-005 (simulated event time) — this is the boundary that ADR-005's fixed
simulated epoch runs into as soon as it meets a broker.

> **Note on what this ADR was expected to be.** The session that produced it was briefed to write
> ADR-007 on a watermark decision — per-partition minimum instead of global maximum — on the
> assumption that `ZoneStateStore` eviction was destroying the pipeline's state. That hypothesis
> was tested and killed before anything was built on it; the events were never reaching the
> processor to be evicted. The watermark question is real and still open, and is recorded at the
> bottom rather than decided here. This ADR documents the decision that was actually made.

---

## Context

A 400-zone `regional-anomaly` run produced 5,760,000 events and the pipeline emitted zero
degradations. The events themselves were known-good: replaying them through the stream
processor's own `TimeWindowManager` and `StateMachine` drove all 62 labelled zones to STRESSED
(`benchmarks/results/wp6a-degradation-check.txt`). Something between "produced" and "processed"
was losing them.

The topic was empty. Not partially consumed — empty. Earliest offset equalled latest offset on
all twelve partitions, and the broker explained itself in its own log:

```
Deleting segment LogSegment(baseOffset=0, size=2118168,
  lastModifiedTime=1789651349305, largestRecordTimestamp=Some(1768486940992))
  due to log retention time 604800000ms breach based on the largest record timestamp
```

Those two numbers are the whole defect:

| Field | Value | Meaning |
|---|---|---|
| `largestRecordTimestamp` | 1768486940992 | 2026-01-15T14:22:20Z — the **simulated** event time |
| `lastModifiedTime` | 1789651349305 | 2026-09-17T13:22:29Z — when the segment was really written |

The simulator set each record's Kafka timestamp to its event time. Simulated time starts at a
fixed epoch in the past so runs stay comparable (ADR-005). The topics ran the default
`CreateTime` with 7-day retention. So every message arrived **245 days past its deletion
deadline**, and the broker deleted each segment seconds after it rolled — 64 deletions, including
several at 16:49:55 while a consumer was mid-read.

## Decision

**A Kafka record timestamp is a storage-layer fact about when data arrived, not an
application-layer fact about when something happened. Application event time lives in the
payload.**

Two changes, one the fix and one the guarantee:

1. **The producer sets no record timestamp.** kafkajs omits the field and the broker stamps it.
   Event time continues to travel in the payload as `eventTimestamp` — which is the only place
   the stream processor has ever read it from, so nothing loses information.
2. **The topics pin `message.timestamp.type=LogAppendTime`** (`tools/kafka-bootstrap`). The
   broker stamps arrival time regardless of what any producer claims. Deciding when a broker
   deletes its own data is not a producer's call to make, and a future producer should not be
   able to reintroduce this by being helpful.

Applied to all five topics, not just the one that broke: the argument is not specific to
`raw.zone.events`, and a topic added later should not have to rediscover it.

### A third change the fix required

`admin.createTopics` does not apply `configEntries` to a topic that already exists. So adding a
config to the spec would have done nothing on every broker that already had the topic — which is
every broker that has ever run this project. **D10 would have survived its own fix, silently.**
The bootstrap now reconciles configs against what the broker actually has, touching only keys the
spec names and logging every change.

## Why this is easy to get wrong

Worth stating plainly, because the broken version looks *more* correct than the fixed one.

"This is an event-time pipeline, so stamp the record with event time" is a reasonable sentence.
It sounds like rigour. And the failure it causes is invisible from inside the producer: the send
succeeds, the broker acknowledges, offsets advance, throughput looks perfect. The data is gone a
minute later, somewhere else, for a reason that appears in no application log.

It is also invisible from the consumer's usual health signal. Consumer lag read **zero on every
partition**, which reads as "fully caught up" and actually meant "there is nothing left to be
behind" — once the log start offset is advanced past a committed offset, lag goes to zero because
the data was deleted, not because it was read. A monitoring dashboard would have shown a green
pipeline throughout.

The general rule the project takes from this: **every timestamp needs an owner and a purpose.**
Event time answers "when did the world change" and belongs to the application. Record time
answers "how old is this data on disk" and belongs to the broker. They are numerically similar
in production, which is exactly why the conflation survives — it only detonates when they
diverge, and a deterministic simulator with a fixed historical epoch makes them diverge by eight
months.

## Alternatives rejected

**Raise `retention.ms` on the topic to something enormous.** Treats the symptom. It would break
again the moment the simulated epoch moved further back, it makes disk usage unbounded, and it
leaves a producer in charge of the broker's deletion policy — the actual error — while hiding
the evidence that it is.

**Move the simulated start epoch to "now".** Directly contradicts ADR-005 and CLAUDE.md rule 3:
the epoch is fixed so two runs are byte-identical and comparable. Trading determinism for a
retention workaround would be a bad trade in any project and a fatal one in this one, where every
measurement rests on replayability.

**`LogAppendTime` alone, leaving the producer as it was.** Sufficient, and it was tempting to
stop there since it is one line of config. Rejected because the producer would still contain code
asserting something false, and the next person to read it — or to copy it into a new producer —
would carry the bug forward to a topic where the config had not been set. Fix the claim, then pin
it.

**Keep event time in the record timestamp and use `log.message.timestamp.difference.max.ms`.**
Kafka can reject records whose timestamp differs too far from broker time. That converts silent
data loss into a loud produce failure, which is better — but the run still would not work, and
the simulator would be unable to produce at all. It solves the wrong half: the goal is a pipeline
that runs, not one that fails more legibly for the same bad reason.

## Costs accepted

- **Kafka-level time-based seeking now returns ingestion time, not event time.**
  `offsetsForTimes` and `--from-timestamp` tooling will answer "what was published around then",
  not "what happened around then". Nothing in the project uses either, and event-time seeking
  over a replayable deterministic simulator is a question better answered by re-running the seed.
  If it is ever needed, the answer is an event-time index, not the record timestamp.
- **Producer-side batching no longer carries event time in the header**, so a consumer that
  wanted it must parse the payload. Every consumer here already does.
- **Existing brokers need a bootstrap re-run** to pick up the topic config. It is idempotent and
  reports what it changed.

## Still open — the watermark question

`ZoneStateStore` advances a single watermark as the **maximum** event time seen across all zones,
and evicts a zone when that watermark passes its last event by more than the idle TTL (15 min).
Zones live on twelve partitions that kafkajs drains independently, so a zone on a lagging
partition sits permanently behind a watermark set by the leading one. If the cross-partition skew
in event time exceeds the TTL, such a zone is evicted while its events are still arriving, and
re-evicted on the next sweep — never holding a window long enough to confirm a transition.

The textbook answer is to track a watermark per partition and take the global watermark as the
**minimum** across them, because a watermark must never advance past the slowest input.

This was **not** implemented, for one reason: it has not been shown to happen. It was the leading
hypothesis for D10 and it was wrong, and the discipline that caught that is the same discipline
that says not to fix an unobserved defect. The instrumentation to answer it is now in place
(per-partition high-water marks, per-zone eviction counts, max zone lag behind the watermark),
and the measurement from the first post-fix run is recorded in `01-ARCHITECTURE.md` §3.4.
Decide it from that number.
