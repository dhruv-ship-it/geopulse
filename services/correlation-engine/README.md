# GeoPulse Correlation Engine

Consumes `zone.degradations`, collapses geographically adjacent co-degrading zones into
**incidents**, and publishes their lifecycle to `zone.incidents`.

> A single sensor going critical is noise. The signal is the geometry.

This is the service the rest of the project exists for. Everything upstream produces observations
about individual zones; this is the only stage that produces something a human would call an
event.

```
zone.degradations ──▶ correlation-engine ──▶ zone.incidents
 (key: coarse H3 cell)   │  NeighbourGraph  (WP1)      (key: coarse H3 cell)
                         │  CorrelationWindow (WP2a)
                         │  TimeAwareConnectivity (WP2a)
                         │  IncidentLifecycle (WP2b)
                         ▼
                  Redis: incident:<id>, incidents:active, incidents:geo
```

## What it does, in one pass

1. **Load the zone registry** from Redis (`zones:registry` + `zone:<id>` hashes) and build the H3
   neighbour graph. Zones discovered later arrive three ways — see [Zone discovery](#zone-discovery).
2. **Consume a batch** of degradations. Each message admits its zone to the correlation window
   (or releases it, if it is a recovery at `currentState: NORMAL`) and mirrors that into the
   connectivity structure.
3. **Reconcile on an event-time grid.** Every `RECONCILE_TICK_MS` of *event time*, sweep expired
   members, recompute the component partition, and fold it into the live incident set. Out come
   `OPENED` / `GREW` / `SHRANK` / `MERGED` / `CLOSED` events.
4. **Publish, then write Redis, then resolve offsets** — in that order, and only that order.

## Why reconcile on an event-time grid

**Because the output should describe the fault, and should not depend on where Kafka drew a batch
boundary.**

In the reference scenario — 400 zones, seed 42 — a `regional-anomaly` degrades 62 zones over tens
of seconds of event time. Reconciled after every message, that fault produces:

```
OPENED  (3 members)
GREW    (4 members)
GREW    (5 members)
...                    ← 59 more, each obsoleted by the next
GREW    (62 members)
```

Sixty-two events published to Kafka, written to Redis and persisted to Postgres, each describing a
state that stopped being true moments later. Reconciled on a grid, the same fault produces a
handful of consolidated events — in the limit, one:

```
OPENED  (62 members)
```

This is **not** a throughput optimisation that happens to change the output. The consolidated
output is *better*: a lifecycle stream is meant to be read by a person, and one update per tick is
the honest description of what happened. Throughput is a side effect.

### It used to reconcile once per batch, and the first live run showed why that was wrong

The original design (ADR-004, as written) put one reconcile at the end of each `eachBatch` call,
on the argument that a burst arrives as a batch. The first end-to-end run measured what actually
arrives:

```
consumer: { batches: 68, messages: 70 }
```

**About one message per batch.** Degradations are rare enough, and the pipeline fast enough, that
kafkajs hands them over as they arrive. Per-batch reconciling therefore collapsed into per-message
reconciling *precisely when the system was healthy*, and consolidated unboundedly only when it was
lagging — delivering none of the benefit it was chosen for while carrying all of its cost.

That cost was a caveat on determinism. `openedAt` is in the incident id preimage
(`SHA-256(scheme | openedAt | seed members)`, ADR-003) and `openedAt` is the reconcile watermark,
so an incident's *name* depended on a broker fetch artefact. Output was byte-identical only for a
fixed batching, which is not a property of the data.

On the grid, a boundary `B` is reconciled when the first message with `eventTime > B` arrives, so
that reconcile sees exactly the messages at or before `B`. `openedAt` always lands on a tick
multiple, and the whole output becomes a function of the message stream alone —
`reconcileGrid.test.ts` runs the same twelve messages under four different batchings and asserts
byte-identical output, ids included.

`eachBatch` stays: it is still the right consumer API, because the batch is the unit of offset
resolution and of dispatch. It is simply no longer the unit of reconciliation.

**What it costs**, stated plainly: a component that forms and dissolves entirely inside one tick
is never seen. That was true before too — it was just a broker artefact instead of a stated
interval. `RECONCILE_TICK_MS` is the resolution at which this system is willing to describe
change, and at 5 s against a 120 s window it is two orders of magnitude finer than the thing being
measured.

**End of stream.** A boundary is completed by a *later* message, so the final interval of a bounded
stream would never be announced. `CorrelationEngine.flush()` closes it out — on the grid, so an
end-of-stream flush cannot put an off-grid value into an id. A graceful shutdown calls it; so must
the eval harness.

The full argument, and the alternatives that lost, are in
[`docs/adr/ADR-004`](../../docs/adr/ADR-004-coarse-cell-partitioning.md) and its amendment.

## Why a separate service

`stream-processor` is deliberately partitioned per zone: one consumer owns a zone's windows, and
nothing is shared. Correlation needs the opposite — a cross-zone, cross-partition view — and
putting it inside `stream-processor` would destroy that stage's clean scaling property to serve a
stage with completely different requirements. Keeping them apart also means the harder, statefuller
half can be scaled, restarted and reasoned about on its own.

## Partitioning

`zone.degradations` is keyed by **coarse H3 cell** (res 3, ~60 km edge), not by `zoneId`. Hashing
by zone id scatters geographic neighbours uniformly at random, which is precisely the wrong thing
when the question is "are these two zones next to each other". A coarse cell much larger than a
plausible incident radius keeps nearly every incident inside one partition.

`zone.incidents` is keyed by the incident's coarse cell, **fixed at its first event**. If the key
moved as an incident grew, that incident's own events would scatter across partitions and lose
their relative ordering — and a `MERGED` that arrives before its `OPENED` describes an incident
the consumer has never heard of.

Phase 1 runs **one** consumer. The keying makes more than one possible; the boundary problem that
comes with more than one is measured and deferred, not hidden. See ADR-004.

## Zone discovery

The neighbour graph is never authoritative, only current — a degradation can arrive for a zone
whose registration has not been read yet, because the two travel on different topics. Three
mechanisms, in increasing cost and decreasing frequency:

| Mechanism | Cost | For |
|---|---|---|
| The degradation message itself (`zoneId`, `latitude`, `longitude`, `h3Cell`) | no I/O | any zone that degrades — the only zones that can be in a component |
| `SMEMBERS zones:registry` on a timer, fetching hashes only for new ids | one round trip per `ZONE_REFRESH_INTERVAL_MS` | registered-but-silent zones, so the graph is complete *before* they first degrade |
| Full load at startup | one pipelined round trip | everything |

An unknown zone gets an empty neighbour list rather than an error, which is the truthful answer at
that moment. The cost is a missed merge, never an invented one, and it heals on the zone's next
degradation.

## Redis keys

| Key | Type | Contents |
|---|---|---|
| `incident:<id>` | HASH | status, members, footprint, severity, merge pointers, timestamps |
| `incidents:active` | SET | live incident ids — so nothing has to `KEYS incident:*` (defect D2) |
| `incidents:geo` | GEO | incident centroids, for "which incidents are near here" |

A closed incident leaves the set and the geo index, and its hash gets
`CLOSED_INCIDENT_TTL_SECONDS`. This is a cache of the present; the durable record is Postgres
(WP3 item 6, not yet built) and the `zone.incidents` topic.

`updatedAt` is **event time**; `lastWrittenAt` is wall clock. They answer different questions and
conflating them is how event-time claims stop being true (ADR-007).

## Delivery semantics

Offsets are resolved by hand, **after** the batch has been published to Kafka and written to
Redis. A handler that throws resolves nothing and the batch is redelivered — defect D1 was
exactly the opposite (an exception caught inside `eachMessage`, so kafkajs committed an offset for
work that had failed).

That makes delivery at-least-once, which is chosen rather than tolerated: the alternative order
would drop the product's own output on a crash. Every downstream write is an idempotent overwrite
keyed by a deterministic incident id, so a redelivered batch converges.

One consequence is specific to a *stateful* consumer and is why `IncidentDispatcher` exists: a
redelivered batch re-folds to the same in-memory state and therefore emits **nothing**, so events
from a failed flush would be lost silently. They are held until a flush succeeds instead. A process
*crash* still loses them along with the correlation window; the window refills within
`CORRELATION_WINDOW_MS` of stream time.

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `KAFKA_BROKER` | `localhost:9092` | |
| `DEGRADATIONS_TOPIC` | `zone.degradations` | |
| `INCIDENTS_TOPIC` | `zone.incidents` | |
| `CORRELATION_CONSUMER_GROUP` | `correlation-engine` | |
| `CORRELATION_FROM_BEGINNING` | `true` | Read the topic from its start. True is what the eval harness needs; a long-lived deployment wants false, since replaying months of degradations re-derives every incident that ever happened. |
| `CORRELATION_MAX_BATCH_SIZE` | `1000` | Messages folded per reconcile. Larger slices consolidate more and take longer between heartbeats. |
| `CORRELATION_WINDOW_MS` | `120000` | How long a degraded zone stays an active member. |
| `COMPACTION_INTERVAL_MS` | `5000` | Event-time cadence for the expiry sweep. Must be below the window. |
| `RECONCILE_TICK_MS` | `COMPACTION_INTERVAL_MS` | Event-time grid the lifecycle reconciles on. Every incident's `openedAt` is a multiple of it, so changing it changes every incident id. Must be below the window. |
| `INCIDENT_MIN_ZONES` | `3` | Members a component needs to be an incident. **This is the threshold that makes the project's claim true or false** — at 1, nothing has been collapsed. |
| `INCIDENT_CLOSE_GRACE_MS` | `60000` | How long an incident may sit below the minimum before closing. |
| `ZONE_REFRESH_INTERVAL_MS` | `60000` | Registry poll interval. 0 disables. |
| `CLOSED_INCIDENT_TTL_SECONDS` | `3600` | TTL on a closed incident's hash. 0 keeps it forever. |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | `localhost` / `6390` / `geopulse-dev` | |
| `METRICS_PORT` | `9093` | |
| `LOG_LEVEL` | `info` | |

## Metrics

`GET :9093/metrics`. The WP3 set:

`incidents_opened_total{origin}`, `incidents_merged_total`, `incidents_closed_total{reason}`,
`incident_member_count`, `correlation_latency_ms`, `active_incidents`, `active_members`,
`compaction_duration_ms`.

Two of those deserve a note:

- **`incident_member_count`** is the project's headline claim as a histogram. If the bulk of
  incidents sit at 1–2 members, nothing has been collapsed and the thesis is false.
- **`correlation_latency_ms`** is measured in **event time on both ends** — from a zone's first
  degradation to the incident event that adds it. It is deliberately *not*
  `Date.now() - eventTime`: that subtraction mixes two clocks, and the simulator publishes at a
  fixed historical epoch, so it would report about 245 days. Wall-clock cost is
  `compaction_duration_ms` and the broker's consumer lag.

Beyond the spec list, each metric names the claim it exists to falsify — `degradation_batch_size`
is the evidence for the `eachBatch` decision above, and `connectivity_rebuilds` /
`connectivity_rebuilt_members` / `connectivity_max_rank` keep ADR-002's "components are small"
assumption measurable rather than asserted.

`GET :9093/health` reports what the engine *believes* — watermark, members, incidents, batches —
rather than just `200 ok`. An engine connected to everything and consuming nothing passes every
liveness check while doing no work at all, which is exactly what defect D10 looked like.

## Run locally

```bash
cd infra && docker-compose up -d
cd tools/kafka-bootstrap && npm install && npm run bootstrap   # topics, once per fresh broker
cd packages/spatial && npm install                             # builds dist/ via prepare

cd services/correlation-engine
npm install
npm run dev
```

`packages/spatial` must be built first; "cannot find module '@geopulse/spatial'" means that step
was skipped.

Nothing produces to `zone.degradations` yet — that is WP3 item 8, the `stream-processor` change.
Until it lands, the engine starts, loads the registry and idles.

## Tests

```bash
npm test                                    # everything, core included
npx jest src/__tests__                      # the service layer only
npx jest differentialFuzz --verbose         # WP2a acceptance: 11,000 sequences vs the oracle
npx jest incidentProperties --verbose       # WP2b acceptance: 2,500 sequences, every invariant
```

`src/core/` is the correlation algorithm and has no I/O in it at all, which is what makes those
last two possible — they run thousands of randomised sequences per second because there is
nothing to wait for. `src/` around it is this service. `CorrelationEngine` is the join between
them and is itself I/O-free, so a test pushes a hand-written batch through the exact code the
service runs.
