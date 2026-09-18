# ADR-000 — Delivery semantics for alert persistence, and what happens on failure

## Status

Accepted (WP0).

Numbered 000 because it predates the Phase 1 design ADRs: it records a decision forced by
fixing defect D1 in the existing pipeline, not by the correlation work.

## Context

`alert-processor` consumed `zone.alerts` with a handler shaped like this:

```ts
eachMessage: async ({ message }) => {
  try {
    ...
    await this.messageHandler(alert);
  } catch (err) {
    console.error('Error processing alert message:', err);   // and nothing else
  }
}
```

kafkajs commits the offset for a message when `eachMessage` **returns normally**. It does not
commit when the handler **throws** — the consumer retries the batch from the uncommitted offset,
and after its own retries are exhausted it crashes the consumer rather than skipping ahead.

Catching the exception therefore converted every failure into a success as far as the offset
was concerned. A Postgres insert that failed — constraint violation, connection drop, disk full
— logged one line and the alert was gone permanently. The code comment on the rethrow inside
`persistToPostgres` claimed it was "failing loudly for compliance/audit"; the layer above ate it.

So the decision was forced: once the exception is allowed to propagate, what should actually
happen to a message that cannot be processed?

## Decision

At-least-once delivery, with a bounded in-process retry and then a dead letter queue.

1. **Transient failure → bounded retry in-process**, exponential backoff
   (default 4 attempts, 100ms × 3ⁿ capped at 5s). Most persistence failures are transient and a
   short retry resolves them without involving the broker.
2. **Retries exhausted → publish to `zone.degradations.dlq`**, carrying the original message
   bytes untouched plus source topic/partition/offset and the failure reason in headers. Then,
   and only then, the offset may commit.
3. **Unparseable message → straight to the DLQ, no retries.** A poison pill cannot be fixed by
   retrying, and retrying it forever blocks the partition for every message behind it.
4. **DLQ itself unavailable → throw.** The DLQ is the only thing that makes committing after a
   failure safe, so if we cannot write to it we must fall back to not committing. The broker
   redelivers.

Consumers of this pipeline must therefore be idempotent-tolerant: at-least-once means a message
can be processed twice (retry after a partial success, or redelivery after a rebalance).
`persistAlert` writes Postgres before Redis specifically because of this — Postgres is the write
that can fail the message, so a retry can no longer LPUSH a duplicate into the recent-alerts
lists for a write that never became durable.

## Alternatives considered

**Keep catching and logging.** Zero code, and the consumer never stalls. Rejected: it is the
defect. It silently trades durability for availability without saying so anywhere, and it makes
every durability claim about the pipeline false.

**Throw and let kafkajs retry forever, no DLQ.** Strictly safest — nothing is ever committed
unprocessed. Rejected because a permanently-bad message (malformed JSON, a row that violates a
constraint that will never stop being violated) blocks its partition indefinitely, and head-of-
line blocking on one poison pill takes out every zone hashed to that partition. The DLQ converts
an availability outage into a small, visible, replayable backlog.

**Pause the partition and retry out-of-band.** kafkajs supports `pause()`/`resume()`, so the
consumer could park the failing partition and keep serving the others. This is the more
sophisticated answer and it preserves ordering per partition. Rejected for now as materially
more state to manage (when to resume, how many pauses before giving up, what happens across a
rebalance) than the failure rate here justifies. Worth revisiting if DLQ volume ever becomes
non-trivial.

**Exactly-once via Kafka transactions.** kafkajs supports transactional produce with offset
commits inside the transaction. Rejected: the sink is Postgres and Redis, not Kafka, so the
transaction would not span the actual side effects. Exactly-once would require an idempotency
key and a dedup check in Postgres — the real answer if this mattered, and a far larger change
than D1 warranted. At-least-once with a natural idempotency key is the documented next step.

## Consequences

- Duplicate alerts are possible. Nothing downstream currently deduplicates. The honest position
  is that this is at-least-once, and the fix is a unique key on
  `(zone_id, timestamp, current_state)` with `ON CONFLICT DO NOTHING` — not yet done.
- The DLQ is a queue that someone must actually look at. `alerts_dead_lettered_total` exists so
  it is visible; there is no replay tool yet, though the headers carry everything one needs.
- In-process retry blocks the partition for up to ~15s on a persistent failure. Acceptable at
  this volume; it is the same head-of-line cost as above, just bounded.
- The DLQ topic is single-partition, so failed messages stay in arrival order and are easy to
  inspect by hand. If volume ever justified more partitions, ordering across them would be lost.

## Interview notes

The question this answers is "what happens when the database is down?", and the useful shape of
the answer is: the offset is the commit point, so anything that makes the handler return
normally is a commit; a DLQ is how you stop a poison pill blocking a partition without lying
about durability; and the DLQ being unavailable has to fall back to not committing, or you have
just moved the data loss one layer out.

---

# Amendment (WP3, S7) — the same bug in `stream-processor`, and why it gets the opposite answer

## Status

Accepted. Amends, does not supersede: everything above still holds for `alert-processor`.

## Context

D1 was fixed in `alert-processor` and left in place in `stream-processor`, whose `eachMessage`
had the identical shape — try/catch, log, return — and therefore the identical consequence: a
failed Redis write or a failed publish committed the offset and destroyed the event.

Fixing it raised a question the original ADR did not have to answer, because it only ever looked
at one topic. `stream-processor` consumes `raw.zone.events`, and a raw sensor event is not the
same kind of thing as an alert. Applying the retry-then-DLQ rule to it unexamined would have been
consistency for its own sake.

## Decision

**One implementation, two policies.** `processWithRecovery` moves into
`@geopulse/kafka-recovery` and gains a required `onFailure` argument with no default:

| Consumer | Topic | Policy | Because |
|---|---|---|---|
| `alert-processor` | `zone.degradations` | `'dead-letter'` | a degradation is a **derived fact**; nothing re-emits it |
| `stream-processor` | `raw.zone.events` | `'drop'` | a sensor event is **one sample** of a signal re-sampled every second |

The argument is required rather than defaulted so that every call site states its own answer.
A default would mean the cheaper policy could be inherited by accident somewhere it costs a
durable fact — which is the failure mode this whole ADR exists to prevent, one level up.

### Why dropping a sensor event is not a re-run of D1

`avg1m` is a mean over roughly sixty samples and `avg5m` over three hundred. Losing one moves
`avg1m` by at most 1/60 of its range, for at most sixty seconds, after which the sample has left
the window and the loss has no representation anywhere in the system. The *state* a zone is in is
derived from the averages, never from any individual event, so the transition this pipeline
exists to detect still fires — at worst one sample late, which is two orders of magnitude inside
the 60-second confirmation delay the state machine already imposes.

The DLQ side does not survive contact with the volume either. At 400 zones sampling once a second
a sustained downstream failure writes 400 dead letters per second onto a single-partition,
14-day-retention topic sized for the occasional poison message. And nobody would replay them:
feeding an hour-old sensor reading back into a five-minute event-time window does not repair the
window, it corrupts it.

What makes this a considered trade rather than D1 again is that a drop is **counted and logged**:
`sensor_events_dropped_total{reason}` is on the metrics endpoint, so a non-zero rate is a number
somebody can alert on rather than something inferred from the absence of alerts. That inference
is exactly how D10 stayed hidden for a week.

### The producing side gets the expensive policy

The same service publishes `ZoneDegradation` to `zone.degradations`, and that message is a fact,
not a sample: the state machine has already advanced past the transition and will not fire it
again while the condition holds. `KafkaDegradationProducer.publish` therefore does bounded retry
(`retryWithBackoff`, split out of `processWithRecovery` for callers that have no offset to
withhold) and then dead-letters — the same rule as the consuming side, applied to a producer.

Two sub-decisions inside that are worth stating:

**The state advance is not rolled back on a publish failure.** The tempting alternative is to
leave `currentState` alone so the next event re-derives the transition. It does not work:
`StateMachine` clears its confirmation timer when a transition fires, so declining to commit
re-arms a 60-second confirmation and the fault is reported a minute late. That trades a loud DLQ
entry for a quiet latency regression, and a silent one-minute detection delay is exactly the kind
of thing that survives into a benchmark and makes a measured number wrong.

**If the DLQ is unreachable too, the publish throws**, which travels out of `eachMessage` and
stops the offset — the original ADR's last rule, unchanged. The consequence here is specific: the
raw sensor event is redelivered and its sample is counted twice in its window. One duplicate
among sixty, on a path that only runs when Kafka is entirely unavailable, is the right price for
not losing the fact.

## Consequences

- `stream-processor` can now lose raw sensor events. It could always lose them; the difference is
  that it now says so, with a number.
- The two policies must not drift into one. The required argument is the mechanism; there is no
  default to fall into.
- A redelivery double-counts a sample in its window. Bounded, failure-path-only, and it does not
  affect replay determinism, because a clean replay has no redeliveries.
- `zone.degradations.dlq` now receives dead letters from both sides of the topic — the producer
  that could not publish and the consumer that could not persist. The `x-source-partition: -1`
  and `x-source-offset: unpublished` headers are what tell them apart; a replay tool must not
  assume a dead letter came from a partition.
