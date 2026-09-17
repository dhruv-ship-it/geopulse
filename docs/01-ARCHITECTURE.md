# 01 — Architecture: As-Built, Known Defects, and Target

---

## 1. As-built (state at commit `a9bc033`, Feb 2026)

~3,200 lines of TypeScript across four services, built over 9 commits.

```
sensor-simulator ──> Kafka: raw.zone.events ──> stream-processor ──> Redis (zone state + GEO)
   (synthetic)           (key = zoneId)         (windows + FSM)          │
                                                                        ▼
                                                        Kafka: zone.alerts
                                                                        │
                                                                        ▼
                                                              alert-processor
                                                                 │        │
                                                         Redis lists   PostgreSQL
                                                                 │        │
                                                                 ▼        ▼
                                                            Express read API
```

### 1.1 Service responsibilities

| Service | LOC | What it does |
|---|---|---|
| `sensor-simulator` | 590 | Generates N zones on a fibonacci-spiral world distribution; emits deterministic per-zone load values at a configurable rate. Scenarios: `normal`, `spike`, `drop`. |
| `stream-processor` | 1395 | Per-zone 1m/5m sliding windows (bucketed per second), 3-state FSM with hysteresis + confirmation delays. Writes zone state to Redis; publishes transitions to `zone.alerts`. |
| `alert-processor` | 555 | Consumes `zone.alerts`; dual-writes to capped Redis lists and a PostgreSQL table. |
| `api` | 701 | Express read-only API over Redis (live) and PostgreSQL (history). |

### 1.2 The part that is genuinely good — keep and build on

`stream-processor/src/stateMachine.ts` implements a 3-state machine with **hysteresis** and
**confirmation delays**:

| Transition | Condition | Confirmation |
|---|---|---|
| NORMAL → STRESSED | avg5m ≥ 0.75 | must hold 60s |
| STRESSED → CRITICAL | avg1m ≥ 0.90 | must hold 20s |
| STRESSED → NORMAL | avg5m ≤ 0.65 | immediate |
| CRITICAL → STRESSED | avg5m ≤ 0.80 | immediate |

The asymmetric thresholds (0.75 up / 0.65 down) are textbook hysteresis — they prevent a metric
oscillating around a single threshold from producing an alert storm. The confirmation delays
prevent transient spikes from promoting state.

**This is the seed of the whole project's narrative.** It solves alert-flapping in the *time*
dimension. Phase 1 solves the exact same class of problem in the *space* dimension. Frame it that
way — it makes the new work a natural, well-motivated extension rather than a bolt-on.

`timeWindowManager.ts` is also sound in shape: per-second buckets with running sum/count gives
O(1) amortised insert and O(1) average, with eviction amortised over inserts.

---

## 2. What is architecturally weak

### 2.1 The geospatial dimension is decorative

`zoneGenerator.ts` places zones via a fibonacci-spiral distribution, so lat/lon exists and is
well-distributed. But **nothing in the detection path uses it.** Every zone is evaluated in total
isolation. The only spatial code in the repo is a single `geoRadius` lookup in an API route
(`api/src/routes/zones.ts`), which is a query convenience, not analysis.

This is the single biggest wasted asset in the project, and Phase 1 exists to fix it.

### 2.2 No parallelism

Topics are auto-created (`allowAutoTopicCreation: true`) with broker defaults, which means
**one partition**. Messages are correctly keyed by `zoneId` — the right instinct — but with a
single partition there is no consumer parallelism available at all. The scaling story is claimed
but not demonstrated.

### 2.3 Per-message await chain

`stream-processor` uses `eachMessage` and `await`s a Kafka produce plus Redis writes inline. Each
message therefore costs at least one network round trip before the next is processed. Throughput
is bounded by latency rather than by CPU.

---

## 3. Known defects — MUST FIX BEFORE ANY MEASUREMENT IS TRUSTED

These are real bugs found by reading the code. Fixing them is work package **WP0**.

**Status after WP0: D1, D2, D4, D5, D7 closed. D3, D6 open as planned. D8 was found during WP0's
live verification and closed in S2a (WP6a) — §3.2 records what it was, how it was fixed, and the
before/after measurement. WP2 is no longer blocked.**

| # | Defect | Location | Why it matters |
|---|---|---|---|
| D1 ✅ | **Silent data loss.** The `eachMessage` handler catches and logs the exception thrown by a failed Postgres insert, so the offset commits anyway and the alert is permanently lost. The code comment claims it "fails loudly for compliance/audit"; it does not. | `alert-processor/src/kafkaConsumer.ts` ~L92 | Corrupts any durability claim. Also a perfect "tell me about a bug you found" story once fixed. |
| D2 ✅ | **`KEYS` in an API hot path.** `redisClient.keys('zone:Z-*')` blocks the Redis event loop, O(N) over the whole keyspace. | `api/src/routes/zones.ts` L22 | Well-known anti-pattern; an interviewer who reads the code will spot it. Replace with a registry SET + pipelined `HGETALL`, or `SCAN`. |
| D3 ⬜ | **No real watermarking.** `TimeWindowManager.evictExpiredBuckets` treats the *incoming event's* timestamp as "now". A single future-dated event evicts the entire window; an out-of-order event lands in a bucket that was already evicted, double-counting. | `stream-processor/src/timeWindowManager.ts` | "Event-time semantics" is claimed in commit messages but not actually implemented. Either implement a watermark with allowed-lateness, or stop claiming event-time. |
| D4 ✅ | **Test coverage claim is hollow.** `jest.config.js` scopes `collectCoverageFrom` to exactly two files. Worse, `alert-processor/src/__tests__/alertFlow.int.test.ts` declares a *stub* `AlertProcessor` class inside the test file and tests that instead of the real implementation — the alert-processor lcov report reads `LH:0` (zero lines hit) for every source file. | `*/jest.config.js`, `alert-processor/src/__tests__/` | The current resume bullet claims 90%+ coverage. It is technically scoped to "core stream-processing logic" so it is not a lie, but it collapses under one follow-up question. |
| D5 ✅ | **Unbounded zone state map.** `stream-processor` keeps `zoneStates` and `zoneCoordinates` maps that only ever grow. No eviction for zones that stop reporting. | `stream-processor/src/streamProcessor.ts` L20-21 | Memory leak at scale; relevant once we run 10k-zone benchmarks. |
| D6 ⬜ | **Zookeeper-mode Kafka.** `confluentinc/cp-zookeeper` + ZK-coordinated broker. Zookeeper was removed entirely in Kafka 4.0; KRaft is the current standard. | `infra/docker-compose.yml` | Not urgent, but know the answer. Cheap to migrate and a good talking point. |
| D8 ✅ | **Simulator event clock did not track real time, and every zone's clock ran at a different rate.** Event time advanced by a per-event constant, not by elapsed time, so it ran at 0.5–10% of wall clock and zones diverged 20× from each other. | `sensor-simulator/src/loadGenerator.ts` | Blocked WP2: adjacent zones could never appear to degrade "at the same time", which is the entire premise of spatial correlation. Closed in S2a by a shared virtual clock — see §3.2 and `docs/adr/ADR-005-simulated-event-time.md`. |
| D7 ✅ | **Simulator load depends on the host timezone.** `LoadGenerator.addRealisticVariation` read the time-of-day pattern with `Date#getHours()`, which is host-local. The same event timestamp produced a different load in a different timezone, or either side of a DST change. | `sensor-simulator/src/loadGenerator.ts` | Found while writing the WP0 determinism tests. Directly breaks the "simulator is deterministic" property that replay and every measured number rest on. Now `getUTCHours()`. |

### 3.2 D8 — the simulator's event clock did not track real time (CLOSED in S2a)

Found by running the full pipeline against the live stack during WP0 verification: a 120-second
run at the default settings, with `avg5m ≈ 0.9` on every zone against a `0.75` threshold,
produced **zero state transitions**.

The cause is in `sensor-simulator/src/loadGenerator.ts`:

```ts
let eventTimestamp = this.zoneClocks.get(zone.zoneId) || producedAt;
const processingDelay = 1 + (parseInt(zone.zoneId.replace('Z-', '')) % 20);
eventTimestamp = Math.min(eventTimestamp + processingDelay, producedAt);
```

The clock is seeded at `producedAt` and thereafter advances by `processingDelay` **per event**,
never by elapsed time. It therefore falls permanently behind and its rate is
*(events per second for that zone) × (that zone's processingDelay)* — dependent on throughput,
and **different for every zone**, because the delay is derived from the zone number.

Measured (`benchmarks/results/d8-simulator-event-clock.txt`, 20 zones, 60s wall clock):

| | Event time advanced | Rate |
|---|---|---|
| Slowest zone (Z-20) | 299 ms | 0.50% of real time |
| Fastest zone (Z-19) | 5980 ms | 9.97% of real time |
| **Divergence after 60s** | **5681 ms** | 20× spread |

Two consequences, and the second is the serious one:

1. The `STRESSED` confirmation needs 60s of *event* time. At the slowest zone's rate that is
   **~200 minutes of wall clock**, which is why short runs alert on nothing. This alone makes
   the system look broken and makes any latency measurement meaningless.
2. **Zones drift apart in event time at different rates.** Two physically adjacent zones
   degrading at the same real instant carry event timestamps minutes — eventually hours — apart.
   Phase 1 is built entirely on the judgement *"these adjacent zones degraded within the same
   window"*. Against this simulator that judgement can never be true, so the correlation engine
   would correctly report no incidents and the eval harness would score it at zero recall.

#### The fix (S2a)

A single `VirtualClock`, shared by every zone, in which simulated time is a pure function of the
tick count: `now() = SIM_START_EPOCH_MS + ticks × SIM_STEP_MS`. No wall-clock read, no
accumulation, no per-zone state — zones cannot drift by construction. Per-zone sensor lag stays,
because out-of-order arrival across zones is realistic and the consumer should face it, but as a
**bounded offset** (`eventTime = clock.now() − lagMs(zoneId)`, lag in [0, 20] ms, hashed from the
zone id) rather than a rate. `producedAt` comes from the same clock, so the whole record is
reproducible.

`SPEED_MULTIPLIER` then buys what the old model could not offer at all: simulated time per real
second, independent of the content of the run. A 60x run emits exactly the same events with
exactly the same timestamps as a 1x run, in a sixtieth of the wall clock. The rationale, the
alternatives rejected and the costs are in `docs/adr/ADR-005-simulated-event-time.md`.

Measured after the fix (`benchmarks/results/d8-simulator-event-clock-after.txt`, same 20 zones
and same 60-second window as the before run):

| | Before | After |
|---|---|---|
| Event-time rate | 0.50%–9.97% of real time | exactly 1.000× at `SPEED_MULTIPLIER=1` |
| Divergence between zones after 60s | 5681 ms, growing without bound | 0 ms |
| Zone-to-zone spread at one instant | unbounded | ≤ 20 ms, constant for the life of the run |
| Wall-clock cost of a 60s confirmation window | ~200 minutes at the slowest zone | 60 s at 1x, 1 s at 60x |

Live against the full stack at 60x: all ten zones reached `STRESSED` within a **17 ms** spread of
event time, about 2.5 seconds after the simulator started. The same pipeline produced zero
transitions in 120 seconds before the fix.

One useful side effect: lateness is now bounded at 20 ms **by construction**, so D3's watermark
has an exact allowed-lateness to use rather than a guessed one.

### 3.1 How each closed defect was closed (WP0)

| # | Fix | Where to read it |
|---|---|---|
| D1 | Exception propagates out of `eachMessage`; bounded retry with exponential backoff, then `zone.degradations.dlq`; DLQ failure rethrows so the offset stays uncommitted. | `alert-processor/src/messageRecovery.ts`, `deadLetter.ts`; `docs/adr/ADR-000-delivery-semantics-and-dlq.md` |
| D2 | `zones:registry` SET + one pipelined `HGETALL` batch. `SCAN` kept only as an explicitly-labelled recovery path that repopulates the set. | `api/src/zoneRepository.ts` |
| D4 | Stub `AlertProcessor` deleted; real class under test, plus a gated end-to-end test through the real consumer. `collectCoverageFrom` widened to every source file, thresholds removed. | `alert-processor/src/__tests__/`, `*/jest.config.js`, `benchmarks/results/wp0-coverage.txt` |
| D5 | `ZoneStateStore` evicts zones idle for `ZONE_STATE_IDLE_TTL_MS`, driven by an event-time watermark so replays evict identically. | `stream-processor/src/zoneStateStore.ts` |
| D7 | `getUTCHours()`; determinism test suite added for the simulator. | `sensor-simulator/src/__tests__/determinism.test.ts` |

**Also fixed in WP0, not originally listed as a defect:** topics were auto-created with broker
defaults (one partition), so the `zoneId` keying bought no parallelism at all. `tools/kafka-bootstrap`
now creates them explicitly with 12 partitions and `allowAutoTopicCreation` is `false` everywhere.

---

## 4. Target architecture (Phase 1)

```
sensor-simulator ──> Kafka: raw.zone.events ──> stream-processor ──> Redis (zone state + GEO)
   + regional          (key = zoneId,              (windows + FSM)          │
     anomaly           N partitions)                                        │
     injection                                                              ▼
       │                                                    Kafka: zone.degradations
       │                                                  (key = COARSE H3 CELL, not zoneId)
       │                                                                    │
       │                                                                    ▼
       │                                                        ┌───────────────────────┐
       │                                                        │  correlation-engine   │  ◀── NEW
       │                                                        │  ─────────────────    │
       │                                                        │  H3 neighbour graph   │
       │                                                        │  time-aware union-find│
       │                                                        │  incident lifecycle   │
       │                                                        │  propagation vector   │
       │                                                        └───────────────────────┘
       │                                                                    │
       │                                                                    ▼
       │                                                        Kafka: zone.incidents
       │                                                                    │
       ▼                                                    ┌───────────────┴───────────┐
  ground-truth                                              ▼                           ▼
   side channel  ────────────────────────────▶  Redis (live incidents)      PostgreSQL (history)
   (evals/)                                                  │                           │
        │                                                    └───────────┬───────────────┘
        ▼                                                                ▼
  eval harness  ◀──────────────────────────────────────────  Express API + live map UI
```

### 4.1 What changes

| Change | Rationale |
|---|---|
| **New service `correlation-engine`** | Correlation needs a cross-zone view; `stream-processor` is deliberately per-zone partitioned. Keeping them separate preserves the clean scaling property of the per-zone stage and isolates the (harder, statefuller) correlation stage. |
| **`zone.alerts` → `zone.degradations`** | Reframes the semantics: the per-zone stage no longer emits *alerts* (a human-facing concept), it emits *observations of degradation*. Only the correlation engine produces human-facing output. This renaming is not cosmetic — it is the conceptual core of the project. |
| **Repartition on coarse H3 cell** | See §6 — this is the key distributed-systems decision. |
| **New topic `zone.incidents`** | The actual product output. |
| **New tables `incidents`, `incident_members`, `incident_events`** | Durable incident history + timeline for the API. |
| **Simulator gains `regional-anomaly` scenario** | Required for ground truth. Without it there is nothing to measure against. |

### 4.2 New event schemas

```ts
// Kafka: zone.degradations  — key: coarse H3 cell id
interface ZoneDegradation {
  zoneId:        string;
  h3Cell:        string;        // fine-resolution cell (detection res)
  h3CoarseCell:  string;        // coarse cell = partition key
  latitude:      number;
  longitude:     number;
  previousState: ZoneState;
  currentState:  ZoneState;     // STRESSED | CRITICAL (or NORMAL on recovery)
  severity:      number;        // 0..1 normalised, for incident severity rollup
  avg1m:         number;
  avg5m:         number;
  eventTime:     number;        // event-time ms
}

// Kafka: zone.incidents — key: h3CoarseCell (NOT incidentId; see ADR-004)
interface IncidentEvent {
  incidentId:    string;        // deterministic; see ADR-003
  eventType:     'OPENED' | 'GREW' | 'MERGED' | 'SHRANK' | 'CLOSED';
  status:        'OPEN' | 'CLOSED';
  memberZones:   string[];
  memberCount:   number;
  peakSeverity:  number;
  severity:      number;
  footprint: {
    h3Cells:   string[];
    centroid:  { latitude: number; longitude: number };
    radiusKm:  number;
  };
  propagation: {                // null until >= 3 members with distinct join times
    bearingDeg: number;
    speedKmh:   number;
    rSquared:   number;         // fit quality; low => not really moving
  } | null;
  mergedFrom:    string[] | null;   // populated on MERGED
  supersededBy:  string | null;     // set on the losing incident of a merge
  openedAt:      number;
  updatedAt:     number;
  closedAt:      number | null;
}
```

---

## 5. The correlation engine internals

Three cooperating pieces. Full build instructions in `02-PHASE-1-CORRELATION.md`.

**(a) Spatial index.** Each zone maps to an H3 cell. Adjacency = same cell, or cells within
`gridDisk(cell, 1)`. Built once from a zone registry, refreshed on zone discovery.

**(b) Time-aware connectivity.** A zone is an *active member* while it has degraded within the
correlation window `W`. Connected components over `{active zones} × {adjacency edges}` are the
incidents. The difficulty is that union-find supports `union` but not `remove`, and members
expire. See ADR-002 for the resolution.

**(c) Incident lifecycle.** A component becomes an incident once it reaches `MIN_ZONES` members.
Lifecycle events are emitted on every change. Merge semantics per ADR-003.

---

## 6. The interesting distributed-systems problem: partitioning

**This section is the highest-value interview material in the repo. Understand it deeply.**

The existing pipeline partitions by `zoneId`. That is correct for the per-zone stage: all events
for a zone land on one partition, one consumer owns that zone's window state, and it scales
linearly with partition count.

**Correlation breaks that property.** To decide whether Z-0147 and Z-0148 belong to the same
incident, one process must see both. Hashing by `zoneId` scatters geographic neighbours across
partitions uniformly at random — precisely the wrong thing.

Options considered:

| Option | How | Problem |
|---|---|---|
| Single partition / single consumer | Correlate everything in one process | Correct, trivial, and does not scale. Fine for Phase 1 at our data volume; must be able to say why it is a deliberate choice and what comes next. |
| Broadcast all degradations to all consumers | Every consumer sees everything | O(N) network amplification. Works only when degradations are rare. |
| **Partition by coarse H3 cell** | Key by H3 cell at a coarse resolution (e.g. res 3, ~100 km edge). All zones in a region land on the same partition. | **Chosen.** Correlation is local, so a coarse cell that is much larger than a plausible incident radius keeps nearly all incidents within one partition. |
| Two-level: local correlate + global merge | Coarse-cell partitions correlate locally, a second stage merges incidents that touch a boundary | The complete answer. Specified as future work. |

**The boundary problem.** An incident straddling two coarse cells is seen as two separate incidents
by two consumers. Phase 1 accepts this limitation and measures how often it happens (it is a
function of coarse-cell size vs incident radius). The documented fix is the two-level scheme: each
local incident that touches its cell boundary is republished to a `boundary.incidents` topic keyed
by the *parent* cell, where a second correlation stage merges across boundaries. This is exactly
analogous to how distributed spatial joins and distributed connected-components (e.g. Pregel-style
label propagation) handle partition boundaries.

Being able to say *"here is the limitation, here is the measurement of how bad it is, and here is
the known fix and why I deferred it"* is worth far more in an interview than pretending the
problem does not exist.

---

## 7. Configuration surface (Phase 1 additions)

| Variable | Default | Meaning |
|---|---|---|
| `H3_RESOLUTION` | `5` | Detection-resolution hex cells (~8 km edge). Tunes what "adjacent" means. |
| `H3_COARSE_RESOLUTION` | `3` | Partition-key resolution (~60 km edge). |
| `CORRELATION_WINDOW_MS` | `120000` | How long a degraded zone stays an active member. |
| `INCIDENT_MIN_ZONES` | `3` | Members required before a component is promoted to an incident. |
| `INCIDENT_CLOSE_GRACE_MS` | `60000` | Grace period below `MIN_ZONES` before closing. |
| `NEIGHBOUR_RING_SIZE` | `1` | `gridDisk` k. Raising it makes correlation more aggressive. |
| `COMPACTION_INTERVAL_MS` | `5000` | Expiry/compaction tick for the connectivity structure. |

### 7.1 Added in WP0

| Variable | Default | Service | Meaning |
|---|---|---|---|
| `KAFKA_TOPIC_PARTITIONS` | `12` | kafka-bootstrap | Partition count for the main topics. |
| `KAFKA_REPLICATION_FACTOR` | `1` | kafka-bootstrap | Single-broker dev cluster. |
| `ALERT_MAX_ATTEMPTS` | `4` | alert-processor | Total attempts, including the first, before dead-lettering. |
| `ALERT_INITIAL_BACKOFF_MS` | `100` | alert-processor | First retry delay. |
| `ALERT_BACKOFF_MULTIPLIER` | `3` | alert-processor | Exponential backoff factor. |
| `ALERT_MAX_BACKOFF_MS` | `5000` | alert-processor | Backoff cap. |
| `DLQ_TOPIC` | `zone.degradations.dlq` | alert-processor | Dead letter destination. |
| `ZONE_STATE_IDLE_TTL_MS` | `900000` | stream-processor | Event-time idleness before in-memory zone state is evicted. Must exceed the 5m window. |
| `ZONE_STATE_SWEEP_INTERVAL_MS` | `60000` | stream-processor | Minimum event-time between eviction sweeps. |

`H3_RESOLUTION` and `H3_COARSE_RESOLUTION` are already live in `stream-processor/src/spatial.ts`;
WP0 computes and stores the cells, WP1 consumes them.

### 7.2 Added in S2a (D8 + infra)

| Variable | Default | Service | Meaning |
|---|---|---|---|
| `SIM_START_EPOCH_MS` | `1768478400000` | sensor-simulator | Simulated epoch a run starts at (2026-01-15T12:00:00Z). Fixed, so runs are comparable. |
| `SIM_STEP_MS` | `1000` | sensor-simulator | Simulated ms per tick. One event per zone per tick, so this is the sample interval. |
| `SPEED_MULTIPLIER` | `1` | sensor-simulator | Simulated ms per real ms. 60 = a simulated minute every real second. Changes how long a run takes, never what it contains. |
| `REDIS_PASSWORD` | `geopulse-dev` | all Redis clients | Must match `--requirepass` in `infra/docker-compose.yml`. A dev credential whose purpose is loud failure, not secrecy. |

`EVENTS_PER_SECOND` was **removed**: it meant timer firings per real second, conflating sampling
density with simulation speed. The real event rate is derived —
`NUM_ZONES × (1000 / SIM_STEP_MS) × SPEED_MULTIPLIER` per real second.

**Host ports changed.** Redis `6380 → 6390`, Postgres `5432 → 5434`. Both defaults were held by
other projects on the dev machine, and 5433 (the first replacement considered for Postgres) turned
out to be taken as well. Moving a port only relocates a collision; the guard is authentication,
which is why Redis now requires a password — a service pointed at the wrong Redis fails `AUTH`
instead of silently sharing another project's keyspace.
