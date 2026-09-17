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
