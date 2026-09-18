# GeoPulse Persistence Service (`alert-processor`)

Makes the pipeline's two durable topics durable: `zone.degradations` and `zone.incidents`. It
also owns `migrations/` and applies them at startup.

The directory is still called `alert-processor`. That is a legacy name flagged for WP7 — the
service no longer consumes anything called an alert, because the per-zone stage does not emit
alerts any more (`docs/01-ARCHITECTURE.md` §4.1). Renaming the directory is a mechanical commit;
it has not been done yet because it touches the compose file, the Dockerfile path and every doc
reference, and buys nothing the topic rename has not already bought.

## Two consumers, one process

| Consumer group | Topic | Writes |
|---|---|---|
| `alert-processor` | `zone.degradations` | `zone_alerts` (Postgres), `alerts:*` (Redis) |
| `incident-persister` | `zone.incidents` | `incidents`, `incident_members`, `incident_events` |

WP3 item 6 allowed either extending this service or adding a small `incident-processor`. This is
the first, and the reason is that the two are the *same job*: take a Kafka topic, make it durable
in Postgres, under the delivery semantics ADR-000 settled. A second process would duplicate the
Postgres pool, the dead-letter producer, the metrics endpoint, the Dockerfile and the ownership
of `migrations/`, all to buy independence that two consumer groups inside one process already
provide — separate offsets, separate failure domains, and (since Postgres access is a pool) no
serialisation of one consumer behind the other.

What a separate service *would* buy is independent scaling and deployment. Neither is a live
concern: incident events are two to three orders of magnitude rarer than degradations — that
ratio is the project's headline claim — so the load they add is noise. If that stops being true,
`src/index.ts` is the seam; the two consumers share nothing but connections.

## Failure policy: dead-letter, both topics

Both consumers use `@geopulse/kafka-recovery` with `onFailure: 'dead-letter'`, because both
messages are *facts that nothing re-emits*:

- A degradation is a derived transition. The state machine upstream has already advanced past it
  and will not fire it again while the condition holds.
- An incident event is the product's output. The correlation engine's state is in memory and its
  fold is idempotent, so re-reading the degradations behind an event produces the *same state*
  and emits nothing at all — which is the trap `IncidentDispatcher` exists to avoid one service
  upstream, and it means a dropped incident event is gone for good.

`stream-processor` makes the opposite call for the raw sensor samples it consumes. The reasoning
for both is in `docs/adr/ADR-000-delivery-semantics-and-dlq.md` and its amendment.

Failed messages go to `zone.degradations.dlq` with provenance headers. A dead letter with
`x-source-partition: -1` came from `stream-processor` failing to *publish* rather than from a
consumer failing to persist.

## At-least-once, and what makes replaying it safe

`zone.incidents` is at-least-once: `IncidentDispatcher` publishes before offsets resolve. Two
separate properties make a redelivery harmless, and it is worth keeping them apart:

**Idempotence.** Incident ids are deterministic (ADR-003), so a replayed event carries the same
key. `incidents` and `incident_members` are upserts; `incident_events` is the only genuinely
append-only table and it has a uniqueness constraint on `(incident_id, event_type, event_time)`
with `ON CONFLICT DO NOTHING`. That triple is unique by construction: the lifecycle reconciles at
one watermark at a time and emits at most one event of each type per incident per reconcile.

**Ordering.** Idempotence alone is not enough — replaying `GREW` after `CLOSED` would reopen a
closed incident. What stops that is that every event for one incident lands on one partition:
`zone.incidents` is keyed by the coarse H3 cell and an incident's key is fixed at its first event
precisely so its own events cannot scatter (ADR-004). A redelivery replays a contiguous run of
one partition in offset order, so the last write for an incident is still its last event. This is
the concrete reason that partitioning decision is a *correctness* decision and not a throughput
one.

## Schema

`migrations/002_create_incidents.sql`. Three tables because an incident is three shapes of fact:
`incidents` is what it is now and is overwritten, `incident_members` is a set of join/leave
intervals, `incident_events` is the append-only timeline the API serves.

Migrations are applied by `src/migrate.ts` at startup, in filename order. They were previously
mounted into Postgres's `docker-entrypoint-initdb.d`, which runs only when the data directory is
empty — so a migration added later silently did not apply to anyone who already had a volume, and
the stack came up healthy until the first incident write failed on a missing relation. Every file
is idempotent DDL. It is not a migration tool and does not pretend to be one; the file says what
would replace it.

## Redis keys

- `alerts:zone:<ZONE_ID>` → LIST (LPUSH newest first, trimmed to `ALERT_HISTORY_LIMIT`)
- `alerts:global` → LIST (LPUSH newest first, trimmed to `ALERT_GLOBAL_LIMIT`)

Postgres is written first and Redis second, deliberately: the Postgres write is the one allowed
to fail the message, and a retry would otherwise LPUSH a duplicate for a write that never became
durable.

## Configuration (env)

| Variable | Default | Notes |
|---|---|---|
| `KAFKA_BROKER` | `localhost:9092` | `kafka:29092` inside compose |
| `DEGRADATIONS_TOPIC` | `zone.degradations` | |
| `INCIDENTS_TOPIC` | `zone.incidents` | |
| `INCIDENT_CONSUMER_GROUP` | `incident-persister` | |
| `DLQ_TOPIC` | `zone.degradations.dlq` | |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | `localhost` / `6390` / `geopulse-dev` | |
| `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `localhost` / `5434` / `geopulse` / `geopulse` / `geopulse` | |
| `POSTGRES_POOL_SIZE` | `5` | One connection per consumer plus headroom |
| `ALERT_MAX_ATTEMPTS` / `ALERT_INITIAL_BACKOFF_MS` / `ALERT_BACKOFF_MULTIPLIER` / `ALERT_MAX_BACKOFF_MS` | `4` / `100` / `3` / `5000` | Degradation retry policy |
| `INCIDENT_MAX_ATTEMPTS` / … | same defaults | Incident retry policy, same four suffixes |
| `ALERT_HISTORY_LIMIT` / `ALERT_GLOBAL_LIMIT` | `100` / `1000` | |
| `METRICS_PORT` | `9091` | `/metrics` and `/health` |

## Run

Normally it runs in the stack (`cd infra && docker compose up -d --build`). From source:

```bash
cd packages/spatial && npm install          # builds dist/ via prepare
cd packages/kafka-recovery && npm install   # likewise
cd services/alert-processor && npm install && npm run dev
```

Tests:

```bash
npm test                                    # unit suites
GEOPULSE_INTEGRATION=1 npm test             # adds the live end-to-end suite; needs the stack up
```
