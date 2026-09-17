# 02 — Phase 1 Build Plan: Spatiotemporal Incident Correlation

> **This is the executable document.** Work packages are ordered by dependency. Each has a goal,
> a spec, acceptance criteria, and an *understanding checkpoint* the owner must pass before the
> package counts as done.
>
> Track progress in `STATUS.md`. Do not mark a WP done until its acceptance criteria are
> demonstrably met by committed code and committed output.

---

## How to use this document

Each work package has four parts:

- **Goal** — one sentence, what this unlocks.
- **Spec** — what to build. Precise enough to implement, loose enough to exercise judgement.
- **Acceptance** — objectively checkable. No "looks good".
- **Understanding checkpoint** — questions the owner must answer *without looking at the code*.
  This is the part that cannot be delegated to an agent. An unanswerable checkpoint means the
  work package is not done, regardless of whether the code works.

**On agent-assisted development.** Agents will write most of this code, and that is fine and
expected. But the interview tests the owner, not the code. The discipline that makes this work:
after an agent implements a package, the owner reads the diff, then closes it and answers the
checkpoint questions aloud. If that fails, re-read and re-derive until it passes. Budget roughly
one third of total project time for this. It is not overhead — for the stated goal (getting
shortlisted and then passing the interview) it *is* the deliverable.

---

## Dependency order

```
WP0 (cleanup)  ──┬──> WP1 (spatial) ──> WP2 (correlation core) ──> WP3 (service+integration)
                 │                                                        │
                 └──> WP6a (simulator ground truth) ──────────────────────┤
                                                                          ▼
                                            WP4 (propagation) ──> WP5 (API+UI) ──> WP6b (eval+bench) ──> WP7 (docs)
```

WP6a can be built in parallel with WP1/WP2 — it has no dependency on the correlation engine and
is needed before anything can be measured.

---

## WP0 — Foundation and defect cleanup

**Goal.** Remove the known defects that would corrupt every measurement taken later, and add the
zone registry that the spatial layer needs.

**Spec.**

1. **Explicit topic creation.** Add an admin bootstrap (kafkajs `admin().createTopics`) that
   creates `raw.zone.events`, `zone.degradations`, `zone.incidents` with a configured partition
   count (default 12) instead of relying on auto-creation. Set
   `allowAutoTopicCreation: false` on all clients afterwards so misconfiguration fails loudly.
2. **Fix D1 (silent data loss).** In `alert-processor`, a failed Postgres write must not result in
   a committed offset. Simplest correct approach: let the error propagate out of `eachMessage` so
   kafkajs retries; add a bounded retry with backoff, and after exhaustion route the message to a
   `zone.degradations.dlq` dead-letter topic rather than dropping it. Add a test that asserts the
   message is not lost when Postgres rejects the write.
3. **Fix D2 (`KEYS` in hot path).** Maintain a Redis SET `zones:registry` of known zone IDs,
   written by `stream-processor`. Replace `keys('zone:Z-*')` with `SMEMBERS` + a pipelined
   `HGETALL` batch. Keep a `SCAN`-based fallback path for recovery.
4. **Fix D5 (unbounded maps).** Evict zone state that has not been updated within a configurable
   idle TTL.
5. **Zone registry.** Persist `zoneId -> {lat, lon, h3Cell, h3CoarseCell}` in Redis
   (`zones:registry` SET + `zone:<id>` HASH, extending the existing hash). The correlation engine
   reads this to build the neighbour graph.
6. **Honest test config.** Either widen `collectCoverageFrom` to real source files, or remove the
   coverage threshold entirely. Delete or rewrite `alertFlow.int.test.ts` so it exercises the real
   `AlertProcessor` class rather than a stub redefined inside the test file (D4).

**Acceptance.**
- `docker-compose up` then a bootstrap command yields topics with 12 partitions (verify with
  `kafka-topics --describe`).
- A test exists in which Postgres insertion fails and the message is provably still available
  (retried or in the DLQ), and it passes.
- No `KEYS` call remains in any request path (`grep -rn "\.keys(" services/*/src` is clean, or
  only in an explicitly-labelled recovery path).
- `npm test` passes in every service and the reported coverage figure corresponds to real files.

**Understanding checkpoint.**
- Why does catching an exception inside `eachMessage` cause message loss? What exactly does
  kafkajs do with the offset when the handler returns normally versus throws?
- Why is `KEYS` dangerous on a production Redis, and why is `SCAN` better despite returning the
  same data? What guarantee does `SCAN` give you and what guarantee does it *not* give you?
- With 12 partitions and messages keyed by `zoneId`, how many consumers can usefully run? What
  happens if you start a 13th?

---

## WP1 — Spatial layer (H3 neighbour graph)

**Goal.** Give the system a real notion of "adjacent".

**Spec.**

1. Add `h3-js`. Map each zone's `(lat, lon)` to `latLngToCell(lat, lng, H3_RESOLUTION)` and to a
   coarse cell at `H3_COARSE_RESOLUTION`.
2. Build a `NeighbourGraph` class:
   - `build(zones: ZoneRegistryEntry[]): void`
   - `neighboursOf(zoneId: string): string[]` — zones in the same cell or in
     `gridDisk(cell, NEIGHBOUR_RING_SIZE)`.
   - Internally: `Map<h3Cell, zoneId[]>` for cell occupancy, so neighbour lookup is a handful of
     O(1) map hits rather than any distance computation.
   - `addZone(zone)` for incremental discovery — new zones appear at runtime.
3. Unit tests: known cell layouts, ring-size behaviour, zones alone in a cell, multiple zones in
   one cell, antimeridian and polar cases.
4. A micro-benchmark comparing `neighboursOf` against a naive haversine scan over all zones, at
   1k / 10k / 100k zones. Commit the numbers — they justify the design choice.

**Acceptance.**
- `neighboursOf` is O(1) w.r.t. total zone count (benchmark shows flat curve vs the naive linear one).
- Tests cover antimeridian (lon ≈ ±180) and high-latitude cases.
- `docs/adr/ADR-001-h3-vs-alternatives.md` exists.

**ADR-001 must record:** H3 chosen over (a) geohash — rectangular cells, neighbours at unequal
distances, awkward prime-meridian/pole behaviour; (b) k-d tree / R-tree KNN — O(log n) but needs
rebuilding as zones churn, and "k nearest" is the wrong semantic (we want "within a physical
distance", which is a radius query, and radius queries on a tree are more expensive); (c) raw
geohash-free haversine — O(n) per lookup. Record *why hexagons*: every one of the 6 neighbours of
a hex is *near*-equidistant from the centre — measured at WP1 as 1.045 median, 1.207 worst, since
H3 projects onto a sphere and the cells are distorted — whereas a square grid's diagonal
neighbours are √2 = 1.4142 farther exactly and everywhere,
which biases "adjacency" by direction. That property is exactly what makes H3 right for
correlation, and it is a genuinely satisfying answer to give in an interview.

**Understanding checkpoint.**
- Why hexagons rather than squares? Give the geometric reason, not "Uber uses it".
- What does H3 resolution 5 mean in kilometres, and how did you choose it? What breaks if it is
  too coarse? Too fine?
- H3 cells are not perfectly uniform in area — why not, and does it matter here?
- How would you handle two zones 500 m apart that happen to fall on opposite sides of a cell
  boundary?

---

## WP2 — Correlation core (time-aware connectivity)

**Goal.** The algorithmic heart: maintain connected components of co-degrading adjacent zones as
members continuously join and expire.

**This is the package that carries the interview. Spend disproportionate time here.**

**Spec.**

1. **`CorrelationWindow`** — tracks active members. A zone becomes active when a degradation
   arrives; it stays active for `CORRELATION_WINDOW_MS` from its most recent degradation, and is
   removed immediately on a recovery event (`currentState: NORMAL`). Use event-time, never
   `Date.now()`, so replays are deterministic.

2. **`TimeAwareConnectivity`** — the hard part. Union-find gives near-O(α(n)) merges but has no
   delete, and our members expire. Implement:
   - Hot path: on a new active member, `union` it with each active neighbour. Path compression +
     union by rank.
   - Expiry path: a compaction tick every `COMPACTION_INTERVAL_MS` removes expired members and
     **rebuilds only the components that lost a member** (a component that lost nothing is
     untouched). Rebuild is a BFS/DFS over that component's surviving members — O(V+E) in the
     component, not in the whole graph.
   - Rationale: expiry is rare relative to arrival, and components are small relative to the
     universe, so paying a local rebuild on expiry is far cheaper than a fully-dynamic structure.
   - Implement a straightforward `NaiveConnectivity` (full recompute every tick) alongside it,
     purely as a **differential-test oracle**: fuzz both with the same random event sequences and
     assert identical component partitions. This is how you prove the optimised version correct,
     and it is a strong thing to be able to describe.

3. **`IncidentLifecycle`** — component → incident, with events:
   - `OPENED` when a component first reaches `INCIDENT_MIN_ZONES`.
   - `GREW` when members are added.
   - `MERGED` when a bridging zone joins two existing incidents. Per ADR-003: the surviving ID is
     the one with the earlier `openedAt`, ties broken by lexicographic `incidentId` (deterministic,
     replay-stable). Emit `MERGED` on the survivor carrying `mergedFrom: [...]`, and a terminal
     event on each loser carrying `supersededBy`.
   - `SHRANK` when members expire but the incident survives.
   - `CLOSED` when member count stays below `INCIDENT_MIN_ZONES` for `INCIDENT_CLOSE_GRACE_MS`.
   - **Splits.** A component can also *split* when a bridging member expires. Decide and document
     the policy: recommended is that the largest surviving fragment keeps the incident ID and other
     fragments open fresh incidents — with the rationale that on-call continuity matters more than
     set-theoretic purity. Record this in ADR-003; it is a judgement call and interviewers like
     hearing a defended one.

4. **`incidentId` generation.** Must be deterministic under replay: derive from a hash of
   (sorted seed member IDs + opening event-time), not from a UUID or a counter. See ADR-003.

5. Tests: unit tests per transition; **property-based tests** (fast-check) asserting invariants —
   every active zone belongs to exactly one component; two zones are in the same component iff a
   path of active adjacent zones connects them; no incident ever has fewer than `MIN_ZONES`
   members while OPEN; replaying the same event sequence twice produces byte-identical output.

**Acceptance.**
- Differential fuzz test: 10,000 randomised event sequences, optimised vs naive, zero divergence.
- Property tests pass.
- Determinism test: same input sequence → identical incident IDs and event stream.
- `docs/adr/ADR-002-time-aware-connectivity.md` and `ADR-003-incident-identity.md` exist.

**ADR-002 must record the alternatives:** (a) full recompute per tick — O(V+E) every tick, simple
and correct, the oracle; (b) **chosen** incremental union + local rebuild on expiry; (c) fully
dynamic connectivity (Holm–de Lichtenberg–Thorup, or link-cut / Euler-tour trees) —
O(log² n) amortised, rejected as substantially more implementation complexity than our scale
justifies. Being able to name (c) and say *why you didn't need it* is exactly the kind of answer
that separates candidates.

**Understanding checkpoint.** *(These are the questions you will actually be asked.)*
- Walk through union-find with path compression and union by rank. What is the amortised
  complexity and what is α?
- Why can't you just delete from a union-find? What specifically breaks?
- A zone bridges two existing incidents. Walk through exactly what happens — including what
  downstream consumers who already received both incident IDs are supposed to do.
- The bridging zone then expires and the component splits. What do you do, and why is your choice
  better than the alternative?
- How do you know your optimised connectivity is correct? (Answer: differential testing against
  the naive oracle — be able to explain why that is stronger evidence than unit tests alone.)
- Why is `incidentId` a hash and not a UUID?

---

## WP3 — The `correlation-engine` service

**Goal.** Wire the core into a real service in the pipeline.

**Spec.**

1. New service `services/correlation-engine/`, mirroring the existing service conventions
   (TypeScript, pino logger, prom-client metrics, Dockerfile, jest).
2. Consume `zone.degradations`; use `eachBatch` rather than `eachMessage` so a batch of
   degradations from one regional event is processed as a unit — this materially reduces
   incident-event churn during a storm. Explain that choice in the README.
3. Load the zone registry from Redis at startup; subscribe to new-zone discovery.
4. Emit `IncidentEvent`s to `zone.incidents`.
5. Write live incident state to Redis (`incident:<id>` HASH, `incidents:active` SET,
   `incidents:geo` GEO index for spatial queries on incidents themselves).
6. Extend `alert-processor` (or add a small `incident-processor`) to persist incidents to Postgres.
   New migration:
   - `incidents(incident_id PK, status, opened_at, closed_at, updated_at, peak_severity, member_count, centroid_lat, centroid_lon, radius_km, bearing_deg, speed_kmh, superseded_by)`
   - `incident_members(incident_id, zone_id, joined_at, left_at, PRIMARY KEY(incident_id, zone_id))`
   - `incident_events(id, incident_id, event_type, member_count, event_time)` — the timeline.
   - Index `incidents(opened_at DESC)`, `incident_members(zone_id)`.
7. Metrics: `incidents_opened_total`, `incidents_merged_total`, `incidents_closed_total`,
   `incident_member_count` (histogram), `correlation_latency_ms` (degradation event-time →
   incident event emitted), `active_incidents` (gauge), `active_members` (gauge),
   `compaction_duration_ms`.
8. `stream-processor` change: emit `ZoneDegradation` to `zone.degradations` keyed by
   `h3CoarseCell`, including recovery transitions (→ NORMAL) so the correlation window can release
   members early.

**Acceptance.**
- End-to-end: simulator → stream-processor → correlation-engine → Redis + Postgres + API, with a
  regional anomaly producing exactly one incident.
- `docker-compose up` brings up the full stack including all services (not just infra).
- Metrics endpoint exposes all listed metrics.

**Understanding checkpoint.**
- Why is correlation a separate service rather than part of `stream-processor`?
- Why key `zone.degradations` by coarse H3 cell instead of `zoneId`? What property does that buy,
  and what does it cost?
- What happens to an incident that straddles two coarse cells? How often does that happen, and
  what's the fix you'd build next?
- Why `eachBatch` over `eachMessage` here specifically?

---

## WP4 — Propagation vector

**Goal.** Compute which direction an incident is moving — the emergent property that makes the
correlated view strictly more informative than the alerts it replaced.

**Spec.**
1. Each member records `joinedAt` (event-time) and its position.
2. Fit weighted least squares of latitude-vs-time and longitude-vs-time over members. Convert the
   (dLat/dt, dLon/dt) pair to a bearing in degrees and a speed in km/h, correcting longitude
   degrees by `cos(latitude)`.
3. Report `rSquared`. If fit quality is poor or there are fewer than 3 members with distinct join
   times, emit `propagation: null` rather than a meaningless vector. **Refusing to report a number
   you don't trust is a quality signal — make sure this shows up in the demo.**
4. Guard degenerate cases: all members joined simultaneously, collinear-in-time, single cell.
5. Validate against ground truth: the simulator injects a known bearing and speed; the eval
   harness reports absolute error (see `03-MEASUREMENT.md`).

**Acceptance.**
- Injected bearing/speed recovered within a documented error bound across the eval scenarios.
- Stationary (non-propagating) incidents correctly report low `rSquared` or `null`.

**Understanding checkpoint.**
- Why weight the regression, and by what?
- Why does longitude need a `cos(lat)` correction, and where does that break down?
- What does a low r² mean here physically, and why is emitting `null` better than emitting the
  best-fit vector anyway?

---

## WP5 — API and live map UI

**Goal.** Make it visible. For a project whose whole thesis is geometric, a static description
undersells it enormously — watching hexes light up and an incident spread across a map is the
single highest-leverage artefact for both interviews and a README GIF.

**Spec.**
1. API endpoints:
   - `GET /incidents?status=OPEN` — active incidents.
   - `GET /incidents/:id` — detail incl. members, footprint, propagation.
   - `GET /incidents/:id/timeline` — the `incident_events` sequence.
   - `GET /zones/:zoneId/incidents` — incidents a zone participated in.
   - `GET /incidents/near?lat=&lon=&radiusKm=` — via the `incidents:geo` index.
   - `GET /stats/collapse?from=&to=` — degradations vs incidents over a window: **the money
     endpoint**, it computes the headline metric live.
2. Live map UI (single static page, MapLibre GL or Leaflet):
   - H3 cells rendered as hex polygons, coloured by zone state.
   - Incidents drawn as a hull over member cells, with an arrow for the propagation vector.
   - A live counter: "degradations: N → incidents: M (X% collapsed)".
   - Server-Sent Events or WebSocket from the API, fed by the `zone.incidents` topic.
3. Record a GIF of a regional anomaly propagating for the README.

**Acceptance.**
- The map shows an incident opening, growing, and closing during a `regional-anomaly` run.
- The collapse counter matches the eval harness's computed number.

---

## WP6 — Ground truth, evaluation, and benchmarks

**Split: WP6a (simulator, do early, parallel with WP1/WP2) and WP6b (harness, after WP3).**

Full methodology is in `03-MEASUREMENT.md`. Summary of what to build:

**WP6a — simulator ground truth.**
- New scenario `regional-anomaly` parameterised by: seed zone or lat/lon, radius km, onset time,
  ramp duration, peak severity, optional propagation bearing + speed, optional decay.
- Emit a machine-readable ground-truth record per injected anomaly to
  `evals/groundtruth/<run-id>.jsonl`: anomaly id, affected zone IDs with per-zone onset time,
  bearing, speed, radius.
- Also add `multi-anomaly` (two simultaneous disjoint anomalies — tests that we do *not* merge
  unrelated things) and `noise` (scattered independent single-zone degradations — tests that we do
  not manufacture incidents out of nothing).
- Keep everything seeded and deterministic.

**WP6b — eval harness + benchmarks.**
- `evals/score.ts`: consumes ground truth + emitted incidents, outputs the metric set in
  `03-MEASUREMENT.md` (collapse ratio, membership precision/recall/F1, time-to-detect,
  propagation error, false-incident rate, fragmentation index).
- `benchmarks/throughput.ts`: sustained events/sec and p50/p95/p99 correlation latency at
  1k/10k/50k zones. Commit raw output to `benchmarks/results/`.
- Both must be one-command re-runnable and must write timestamped raw results into the repo.

**Acceptance.**
- `npm run eval` and `npm run bench` work from a clean checkout after `docker-compose up`.
- Raw results committed. **Every number that appears on the resume traces to a committed file.**

---

## WP7 — Documentation and resume update

**Spec.**
1. Rewrite the root `README.md` around the new thesis: problem → insight → architecture → results
   table → demo GIF → how to run → limitations and future work. Lead with the results table.
2. Ensure ADRs 001–004 exist and are honest about rejected alternatives.
3. Fill real measured numbers into `05-RESUME.md`. **`TBD` until measured — never a placeholder
   that looks like a real number.**
4. Add a `LIMITATIONS.md` or a README section stating plainly what is not built (crash-safety,
   cross-partition merge, learned thresholds) and what the fix is for each. This reads as
   confidence, not weakness — and it pre-empts the interviewer's best questions by answering
   them first.

---

## Suggested sequencing for a 2–3 week window

| Days | Work | Resume impact |
|---|---|---|
| 1–2 | WP0 | none directly — but everything downstream is untrustworthy without it |
| 2–3 | WP6a (ground truth) in parallel with WP1 | none yet |
| 3–4 | WP1 spatial layer | none yet |
| 5–8 | **WP2 correlation core** — the deep one, do not rush | none yet |
| 9–10 | WP3 service integration | **end-to-end works** |
| 11 | WP6b eval + benchmarks | **first real numbers → bullet 1 and 2 go live** |
| 12–13 | WP4 propagation + WP5 API/UI | **demo GIF → bullet 3** |
| 14 | WP7 docs, ADRs, README, resume | complete entry |

Resume can be updated at day 11 with two measured bullets and completed at day 14.
