# STATUS — Living Progress Tracker

> **Agents: read this first, and update it at the end of any session that changed work-package
> state.** Keep it terse and factual. This file is the handoff between sessions.

---

## Current position

| Field | Value |
|---|---|
| **Phase** | Phase 1 — Spatiotemporal Incident Correlation |
| **Active work package** | S7 done — **WP3 is built and running end to end**. Items 6 and 8 landed (Postgres incident persistence; `stream-processor` emits `ZoneDegradation` keyed by coarse cell, recoveries included), every service is containerised, and `docker compose up` brings up the whole stack. **The acceptance criterion is substantially met but not cleanly passed**: the injected regional anomaly produces one incident that holds all 62 zones for the whole 8,380-second fault, plus one 15-second split fragment during the decay — so the script's own check reads 2, not 1. See the caveat under WP3. WP6b is unblocked. |
| **Last updated** | 2026-09-18 |
| **Last commit at time of writing** | `74de429` |
| **Blocked on** | Nothing. Next is WP6b (the eval harness), which must call `CorrelationEngine.flush()` at the end of a replay or lose the final reconcile tick. |

**Decisions locked in (do not re-litigate without the owner):**
- Scope is idea ① (spatial correlation) only. Ideas ②–⑤ are deferred to `06-FUTURE-PHASES.md`.
- Target roles: backend / distributed systems. Prioritise correctness arguments and scaling
  reasoning over breadth of technology.
- Timeline: resume update wanted within 2–3 weeks; interim bullets (`05-RESUME.md` §2) can ship
  immediately.

---

## Work package status

| WP | Name | Status | Notes |
|---|---|---|---|
| WP0 | Foundation & defect cleanup | ☑ Done | D1, D2, D4, D5 closed, plus D7. D3 deferred as planned. All four acceptance criteria verified against live Kafka/Redis/Postgres. Understanding checkpoint still owed. |
| WP1 | Spatial layer (H3 neighbour graph) | ☑ Done | `@geopulse/spatial` — `NeighbourGraph` plus the cells module moved out of stream-processor. All three acceptance criteria met: lookup flat at 0.58→1.03 µs across 1k→100k zones against 39.6→4630.7 µs for a naive scan; antimeridian, polar and pentagon tests; ADR-001. Understanding checkpoint still owed. |
| WP2a | Correlation core — window + connectivity | ☑ Done | `CorrelationWindow`, `TimeAwareConnectivity` (union-find + local rebuild), `NaiveConnectivity` (the oracle), and the differential fuzz. Acceptance met: **11,000 sequences / 551,871 operations, 0 divergences**. ADR-002. Understanding checkpoint still owed. |
| WP2b | Correlation core — `IncidentLifecycle` | ☑ Done | OPENED / GREW / MERGED / SHRANK / CLOSED, `DRAINING` as the third status, SHA-256 incident ids, merge by age, split by inheritance. Acceptance met: **2,500 property sequences / 156,773 invariant checks, 0 violations**, and a byte-identical replay over 1,000 of them. 100% statements and branches on the module. ADR-003. Understanding checkpoint still owed. |
| WP3 | `correlation-engine` service | ⚠ Built, one acceptance criterion not cleanly met | All eight items. S6 built the service (1–5, 7); S7 added Postgres persistence (item 6 — `incidents` / `incident_members` / `incident_events`, a second consumer group inside `alert-processor`), the `stream-processor` degradation producer (item 8, recoveries included), and Dockerfiles for every service. Two of three acceptance criteria met outright: `docker compose up` brings up the full stack, and `/metrics` exposes every listed metric plus eleven more. **The third — "a regional anomaly producing exactly one incident" — reads 2, not 1** (`benchmarks/results/wp3-e2e-regional.txt`). One incident holds all 62 zones across the entire fault; the second is a 15-second fragment that appears while the fault dissolves unevenly. That is a split-policy question rather than a correlation failure, and it is **deliberately left unturned** — tuning `INCIDENT_CLOSE_GRACE_MS` until the number reads 1 would be fitting the parameter to the assertion. Three real defects found by the live runs and fixed: D12 (adjacency too tight), D13 (reconcile cadence), D14 (edge-triggered producer against a level-expecting window). ADR-004 + amendment, ADR-008. **283 tests in the engine, 97.29% stmts / 96.97% branches.** Understanding checkpoint still owed. |
| WP4 | Propagation vector | ☐ Not started | |
| WP5 | API + live map UI | ☐ Not started | |
| WP6a | Simulator ground truth | ☑ Done | All four scenarios inject, all four emit §2-schema labels, determinism asserted byte-for-byte, labels verified against the real state machine. ADR-006. Understanding checkpoint still owed. |
| WP6b | Eval harness + benchmarks | ☐ Not started | **Fully unblocked** as of S7 — the whole pipeline runs end to end and writes incidents to Postgres, so the harness can score either the live output or an offline replay. Two things it must do: call `CorrelationEngine.flush()` at the end of a replay (the grid reconciles a boundary when a *later* message crosses it, so the final tick is otherwise never announced), and record `RECONCILE_TICK_MS` alongside every number. |
| WP7 | Docs, ADRs, README, resume | ☐ Not started | |

Status legend: ☐ not started · ◐ in progress · ☑ done (acceptance criteria met) · ⚠ done but
understanding checkpoint not yet passed

---

## Understanding checkpoints passed

Track separately from implementation — code can be done while understanding is not. A WP is only
truly complete when both are ticked.

| WP | Checkpoint passed | Date |
|---|---|---|
| WP0 | ☐ — questions in `02-PHASE-1-CORRELATION.md` WP0; ADR-000 answers the first two | |
| WP1 | ☐ — questions at the end of the S3 log entry; ADR-001 answers most of them in prose, so answer closed-book first | |
| WP2a | ☐ — questions at the end of the S4 log entry; ADR-002 answers several in prose, so answer closed-book first | |
| WP2b | ☐ — questions at the end of the S5 log entry; ADR-003 answers most of them in prose, so answer closed-book first | |
| WP3 | ☐ — questions at the end of the S6 log entry, plus five more at the end of S7; ADR-004 and its amendment answer most of them in prose, so answer closed-book first | |
| WP4 | ☐ | |
| WP6a | ☐ — questions at the end of the S2b log entry | |

---

## ADRs written

| ADR | Title | Status |
|---|---|---|
| ADR-000 | Delivery semantics for alert persistence, and what happens on failure | ☑ Written (WP0) |
| ADR-001 | H3 hex cells for adjacency, over geohash, spatial trees and raw distance | ☑ Written (WP1) |
| ADR-002 | Incremental union-find with local rebuild on expiry | ☑ Written (WP2a) |
| ADR-003 | Incident identity, merge and split semantics | ☑ Written (WP2b) |
| ADR-004 | Partitioning on coarse H3 cells, and batching the correlation consumer | ☑ Written (WP3) |
| ADR-005 | Simulated event time: virtual clock, bounded lag, speed multiplier | ☑ Written (S2a) |
| ADR-006 | Ground truth by construction: one severity function, two thresholds | ☑ Written (S2b) |
| ADR-007 | A Kafka record timestamp is not application event time | ☑ Written (S2c) |
| ADR-000 (amendment) | One recovery implementation, two failure policies: why a sensor event is dropped and a degradation is dead-lettered | ☑ Written (S7) |
| ADR-004 (amendment) | Reconcile on an event-time grid, not per batch | ☑ Written (S7) |
| ADR-008 | Degradation is a level, not an edge: periodic re-assertion | ☑ Written (S7) |

---

## Measured numbers

**Empty until measured. Do not fill from estimates.** Every row must cite a committed file.

| Metric | Value | Scenario / config | Source file | Date |
|---|---|---|---|---|
| **Incidents from one injected regional anomaly** | **2** — one holding all 62 zones for the full 8,380 s fault, one 15 s split fragment at the decay | 400 zones, seed 42, 4 simulated hours, full stack, res 5 ring 2, reconcileTick 5 s, reassert 30 s | `benchmarks/results/wp3-e2e-regional.txt` | 2026-09-18 |
| Peak membership per incident, same run | 62 (main), 3 (fragment — exactly `INCIDENT_MIN_ZONES`) | as above | `benchmarks/results/wp3-e2e-regional.txt` | 2026-09-18 |
| Lifecycle events for that fault | 31 (2 OPENED, 11 GREW, 16 SHRANK, 2 CLOSED) against 62 degrading zones | as above | `benchmarks/results/wp3-e2e-regional.txt` | 2026-09-18 |
| Main incident lifespan, before vs after the D14 fix | 195 s → 8,380 s (the fault itself ran 8,640 s) | as above; before-fix run kept alongside | `wp3-e2e-regional-before-d14.txt` vs `wp3-e2e-regional.txt` | 2026-09-18 |
| Incidents from one fault, before vs after the D14 fix | 7 → 2 | as above | `wp3-e2e-regional-before-d14.txt` vs `wp3-e2e-regional.txt` | 2026-09-18 |
| Degradation messages during the fault, with re-assertion | 17,322 (17,260 degradations + 62 recoveries) against 109 state transitions | 62 degraded zones re-asserting every 30 s of event time for 8,380 s | `benchmarks/results/wp3-e2e-regional.txt` | 2026-09-18 |
| Anomaly zones that form one component, res 5 ring 1 | regional 7 components (largest 35/62), propagating 10 (largest 20/57), multi 4 and 7, noise 1 each | 400 zones, seed 42; the adjacency the engine shipped with before D12 | `benchmarks/results/wp3-anomaly-connectivity.txt` | 2026-09-18 |
| Anomaly zones that form one component, res 5 ring 2 | **1 component for every injected anomaly**, all four scenarios | as above; the setting D12 moved to | `benchmarks/results/wp3-anomaly-connectivity.txt` | 2026-09-18 |
| Over-grouping check at res 5 ring 2 | multi-anomaly: 2 components across 2 anomalies; noise: 16 across 16 | as above — ring 2 fixes fragmentation without merging things that must stay apart | `benchmarks/results/wp3-anomaly-connectivity.txt` | 2026-09-18 |
| Kafka messages per `eachBatch` call, live | ~1.03 (70 messages / 68 batches) | 400 zones, seed 42, full stack; the measurement that killed per-batch reconciling (D13) | `benchmarks/results/wp3-e2e-regional.txt` | 2026-09-18 |
| Simulator achieved speed vs `SPEED_MULTIPLIER` | ~5× achieved against 60× configured (~2,000 events/s) | 400 zones, throughput-bound; the multiplier is a ceiling, not a promise | `benchmarks/results/wp3-e2e-regional.txt` | 2026-09-18 |
| Test coverage, correlation-engine | 97.29% stmts, 96.97% branches | whole src tree, `./benchmarks/run-coverage.sh`; 283 tests | `benchmarks/results/wp3-coverage.txt` | 2026-09-18 |
| Test coverage, correlation-engine `src/core` | 100% stmts, 99.31% branches | as above; unchanged by the grid change — the core was not touched | `benchmarks/results/wp3-coverage.txt` | 2026-09-18 |
| Test coverage, `packages/kafka-recovery` | 84.61% stmts, 80% branches | whole src tree; 27 tests. The shortfall is `index.ts`, which is re-exports | `benchmarks/results/wp3-coverage.txt` | 2026-09-18 |
| Test coverage, packages/spatial | 97.89% stmts, 91.89% branches | whole src tree | `benchmarks/results/wp3-coverage.txt` | 2026-09-18 |
| Test coverage, sensor-simulator | 72.07% stmts | whole src tree | `benchmarks/results/wp3-coverage.txt` | 2026-09-18 |
| Test coverage, stream-processor | 51.58% stmts | whole src tree; was 37.07% before the D1 fix and the degradation producer got tests | `benchmarks/results/wp3-coverage.txt` | 2026-09-18 |
| Test coverage, alert-processor | 55.42% stmts | whole src tree, integration suites skipped; was 46.87% | `benchmarks/results/wp3-coverage.txt` | 2026-09-18 |
| Test coverage, api | 18.91% stmts | whole src tree. Untouched this session and the lowest in the repo — WP5 rewrites it | `benchmarks/results/wp3-coverage.txt` | 2026-09-18 |
| Simulator event-time rate | 1.000× real time | 20 zones, `SIM_STEP_MS=1000`, `SPEED_MULTIPLIER=1` | `benchmarks/results/d8-simulator-event-clock-after.txt` | 2026-09-17 |
| Zone-to-zone event-time divergence | 0 ms over 60 s (spread bounded at ≤ 20 ms) | as above; was 5681 ms before the fix | `benchmarks/results/d8-simulator-event-clock-after.txt` | 2026-09-17 |
| Wall clock per 60 s confirmation window | 60.00 s at 1×, 1.00 s at 60× | as above | `benchmarks/results/d8-simulator-event-clock-after.txt` | 2026-09-17 |
| Zone nearest-neighbour, median — global spiral | 6222 km @ 10 zones, 305 km @ 5000 | fibonacci spiral, seed 42 | `benchmarks/results/d9-zone-spacing.txt` | 2026-09-17 |
| Zone nearest-neighbour, median — regional grid | 33.6 km @ 100, 15.7 km @ 400, 4.1 km @ 5000 | 400 km region, seed 42 | `benchmarks/results/d9-zone-spacing.txt` | 2026-09-17 |
| Zone pairs within an H3 res-5 ring — global spiral | 0, at every zone count measured | 25 km reach | `benchmarks/results/d9-zone-spacing.txt` | 2026-09-17 |
| Zones labelled per anomaly, reference config | 62 regional, 57 propagating, 43 multi, 16 noise | 400 zones, seed 42, 4 simulated hours | `evals/groundtruth/*-seed42.meta.json` | 2026-09-17 |
| Labelled zones reaching STRESSED in the real state machine | 100% (62/62, 57/57, 43/43, 16/16); 0 of 40 unlabelled controls | ordered per-zone replay, same config | `benchmarks/results/wp6a-degradation-check.txt` | 2026-09-17 |
| Detection floor, labelled onset to STRESSED (median) | 256 s regional, 291 s propagating | as above; 5 min window fill + 60 s confirmation | `benchmarks/results/wp6a-degradation-check.txt` | 2026-09-17 |
| Live pipeline degradations, regional-anomaly | 62 zones STRESSED, 47 CRITICAL, all 62 recovered | 400 zones, seed 42, 4 simulated hours, full stack | `benchmarks/results/d10-after-fix.txt` | 2026-09-17 |
| Live vs offline-replay prediction | exact match on zone counts and on last-STRESSED event time | as above | `benchmarks/results/d10-after-fix.txt` | 2026-09-17 |
| Kafka segment deletions during a run | 64 before the D10 fix, 0 after | as above | `d10-root-cause.txt`, `d10-after-fix.txt` | 2026-09-17 |
| Zone-state evictions | 0 across 400 zones / 5.76M events | as above, 15 min idle TTL | `benchmarks/results/d10-after-fix.txt` | 2026-09-17 |
| `neighboursOf` latency, constant density | 0.58 µs @ 1k, 0.77 µs @ 10k, 1.03 µs @ 100k zones | res 5, ring 1, 25 zones per 100 km square, seed 42 | `benchmarks/results/wp1-neighbour-graph.txt` | 2026-09-17 |
| Naive haversine scan, same fields | 39.6 µs @ 1k, 399.2 µs @ 10k, 4630.7 µs @ 100k | as above, 25 km radius | `benchmarks/results/wp1-neighbour-graph.txt` | 2026-09-17 |
| Speedup, `neighboursOf` vs naive scan | 68× @ 1k, 521× @ 10k, 4484× @ 100k | as above | `benchmarks/results/wp1-neighbour-graph.txt` | 2026-09-17 |
| `neighboursOf` latency, constant area | 0.70 µs @ 1k → 27.9 µs @ 100k, as the neighbourhood grows 7.6 → 771 zones | one 400 km square at every zone count | `benchmarks/results/wp1-neighbour-graph.txt` | 2026-09-17 |
| Graph build time | 28 ms @ 1k, 64 ms @ 10k, 397 ms @ 100k zones | constant-density fields | `benchmarks/results/wp1-neighbour-graph.txt` | 2026-09-17 |
| Hexagon neighbour equidistance, res 5 | furthest/nearest of the six = 1.045 median, 1.207 worst (square grid: exactly 1.4142) | 5000 cells sampled uniformly by area | `benchmarks/results/wp1-neighbour-graph.txt` | 2026-09-17 |
| H3 res-5 cell area spread | 156.4–305.1 km², ratio 1.95; 12 pentagons, the first 127.8 km² | as above | `benchmarks/results/wp1-neighbour-graph.txt` | 2026-09-17 |
| What one-ring adjacency means on the ground | non-adjacent from 9.2 km; still adjacent at 31.7 km | 1200 zones in a 200 km square, equatorial | `benchmarks/results/wp1-neighbour-graph.txt` | 2026-09-17 |
| Cell adjacency vs a true 25 km circle | recall 62.7–75.6%, precision 85.7–96.4% | constant-density fields, 1k–100k | `benchmarks/results/wp1-neighbour-graph.txt` | 2026-09-17 |
| **Differential fuzz divergences, optimised vs naive** | **0** | 11,000 sequences, seed 42: 10,000 random-graph + 1,000 over the real H3 graph + 1,000 reach-measuring | `benchmarks/results/wp2-differential-fuzz.txt` | 2026-09-18 |
| Differential fuzz operations compared | 551,871 events, 551,871 partition comparisons | as above; partitions compared after *every* operation, not at the end | `benchmarks/results/wp2-differential-fuzz.txt` | 2026-09-18 |
| What the fuzz actually reached | 7,732 component splits, 110,754 expiries, 21,089 early recoveries, 5,305 full teardowns, largest component 28 | as above | `benchmarks/results/wp2-differential-fuzz.txt` | 2026-09-18 |
| Fuzz wall clock | ~11 s for the whole suite | node v20.14.0, win32 x64, one machine; the core has no I/O, which is why this is cheap enough to keep in `npm test` | `benchmarks/results/wp2-differential-fuzz.txt` | 2026-09-18 |
| **Incident invariant violations** | **0** | 2,500 sequences, seed 42: 2,000 random-graph + 500 over a 5×4 lattice, plus 600 more at `closeGraceMs: 0` and `minZones: 1` | `benchmarks/results/wp2b-incident-properties.txt` | 2026-09-18 |
| Incident invariant checks performed | 156,773 events, 156,773 checks | as above; all four invariants re-checked after *every* event, not at the end | `benchmarks/results/wp2b-incident-properties.txt` | 2026-09-18 |
| Byte-identical replays | 1,000 / 1,000 sequences | whole JSON event stream compared as text, ids included; plus 300 with neighbour lists reversed | `benchmarks/results/wp2b-incident-properties.txt` | 2026-09-18 |
| What the incident properties reached | 6,219 opened (186 from splits), 663 merges, 4,019 closes (670 superseded / 1,596 grace / 1,753 dissolved), 1,655 revivals from DRAINING, largest incident 19 | as above | `benchmarks/results/wp2b-incident-properties.txt` | 2026-09-18 |
| Defects found by the property tests | 1 — incident id reused after a close at an unchanged watermark | found at `minZones: 1`, shrunk to 30 events; fixed in `2291166` | `benchmarks/results/wp2b-incident-properties.txt` | 2026-09-18 |

Re-run coverage with `./benchmarks/run-coverage.sh`, the WP1 rows with the command in the
header of `benchmarks/neighbour-graph.ts`, the WP2 rows with
`cd services/correlation-engine && npx jest differentialFuzz --verbose`, the WP2b rows with
`cd services/correlation-engine && npx jest incidentProperties --verbose`, the connectivity rows
with `npx ts-node benchmarks/anomaly-connectivity.ts`, and the end-to-end rows with
`./benchmarks/e2e-regional-anomaly.sh` (which brings the whole stack up from a clean volume and
takes about 50 real minutes). The coverage figures are low and they are honest — the previous
"90%+" figure was scoped to two hand-picked files. **Do not put a coverage number on the resume**
(`05-RESUME.md` §5 already says to drop it); these rows exist so the claim is traceable if asked.

---

## Known defects from the audit

Tracked from `01-ARCHITECTURE.md` §3.

| ID | Defect | Status |
|---|---|---|
| D1 | Silent alert loss — exception swallowed in `eachMessage`, offset commits anyway | ☑ Closed — `5c74a01` |
| D2 | `KEYS` in the API hot path | ☑ Closed — `8c87481` |
| D3 | No real watermarking; future-dated event evicts whole window | ☐ Open (deferred to Phase 3, as the WP0 spec allows) |
| D4 | Hollow coverage claim; integration test exercises a stub class | ☑ Closed — `36d71af`, `7fa7e0a` |
| D5 | Unbounded zone state maps | ☑ Closed — `f2ace62` |
| D6 | Zookeeper-mode Kafka (KRaft is current) | ☐ Open (Phase 6) |
| D7 | Simulator load depends on host timezone (`getHours()` not `getUTCHours()`) | ☑ Closed — `7fa7e0a`. **New**, found while writing the determinism tests. |
| D9 | Zones too far apart to have neighbours — the global spiral puts the closest pair 160 km apart at 5000 zones, with zero pairs inside an H3 res-5 ring at any count | ☑ Closed — S2b. `regional-grid` layout; evidence `benchmarks/results/d9-zone-spacing.txt`, see `01-ARCHITECTURE.md` §3.3. |
| D10 | Live pipeline emits zero degradations from 5.76M events that provably should degrade | ☑ Closed — S2c. **Kafka was deleting the events.** The producer stamped records with simulated event time; retention is evaluated against that field, so with a fixed historical epoch every message arrived 245 days past its deletion deadline. Producer no longer sets it; topics pin `LogAppendTime`. Verified: 0 deletions, 62 STRESSED, 47 CRITICAL. See `01-ARCHITECTURE.md` §3.4 and ADR-007. |
| D11 | `ZoneStateStore` takes its watermark as a global max over all zones, not a minimum across partitions | ☐ Open, **unobserved**. Sound in theory, 0 evictions measured across 400 zones and 5.76M events. Deliberately not fixed — see `01-ARCHITECTURE.md` §3.5. |
| D12 | One regional fault fragments into seven incidents — H3 res-5 ring-1 adjacency is tighter than the zone spacing, so 62 co-degrading adjacent zones are not one component | ☑ Closed — S7. **Found by the first end-to-end run, which is exactly what it was for.** `NEIGHBOUR_RING_SIZE` 1 → 2. Evidence across three resolutions × three ring sizes × all four scenarios: `benchmarks/results/wp3-anomaly-connectivity.txt`. Ring 2 gives one component for every injected anomaly and still keeps the multi-anomaly's two faults and the 16 noise zones apart. |
| D13 | Incident ids depend on Kafka batch boundaries — `openedAt` is in the id preimage and was the per-batch reconcile watermark | ☑ Closed — S7. Flagged by S6, decided here with live batch sizes visible: the run measured **70 messages across 68 batches**, so per-batch reconciling had degenerated into per-message reconciling exactly when the pipeline was healthy. Reconciles now run on a fixed event-time grid (`RECONCILE_TICK_MS`). ADR-004 amendment. |
| D14 | One regional fault produces seven incidents with an 8,070-second hole in the middle — `stream-processor` is edge-triggered, the correlation window is level-expecting, so a zone that degrades and stays degraded is forgotten mid-fault | ☑ Closed — S7. **Found by the first *full-length* end-to-end run**, after D12 had already been fixed; the truncated run that passed had simply not reached the point where the window lapsed. 62 zones crossed into STRESSED over 80 s and then emitted nothing for 2.2 simulated hours because nothing *changed*; the engine's watermark froze, its 120 s window expired every member, and the incident closed underneath a live fault. Fixed with `DEGRADATION_REASSERT_MS` (30 s of event time). Evidence: `benchmarks/results/wp3-e2e-regional-before-d14.txt`. ADR-008. |
| D8 | Simulator event clock runs at 0.5–10% of real time and each zone's clock runs at a different rate (20× spread in 60s) | ☑ Closed — S2a. One shared virtual clock; per-zone lag is now a bounded offset. Before/after: `benchmarks/results/d8-simulator-event-clock.txt` vs `-after.txt`; rationale in `docs/adr/ADR-005-simulated-event-time.md`. |

---

## Session log

Append one entry per working session. Newest at the top. Keep to 2–4 lines.

### 2026-09-18 — S7: WP3 items 6 and 8, containerisation, and the first end-to-end run

- **WP3 runs end to end, and the acceptance criterion is substantially — not cleanly — met.** One
  injected regional anomaly produces **one incident holding all 62 zones for the whole
  8,380-second fault**, plus a **15-second split fragment** during the decay, so the script's own
  check reads 2 and prints FAIL. Evidence: `benchmarks/results/wp3-e2e-regional.txt`, produced by
  `./benchmarks/e2e-regional-anomaly.sh`, which brings the whole stack up from a clean volume and
  checks the number itself. The fragment is left in rather than tuned away: `INCIDENT_CLOSE_GRACE_MS`
  or the split policy could make the number read 1, and doing that to satisfy an assertion is how a
  measurement stops meaning anything. It is stated here and in the results file instead.
- **What the number actually says.** Peak membership: 62 for the main incident (every labelled
  zone), 3 for the fragment — exactly `INCIDENT_MIN_ZONES`, which is what a marginal artefact looks
  like. 62 degradations collapse to 31 lifecycle events across 2 incidents, one of which is
  real. The thesis holds; the count is one fragment short of clean.
- **The end-to-end run found three real defects, which is exactly what it was for.** All three
  were invisible to 283 passing unit tests: two were wrong *parameters* rather than wrong code, and
  the third (D14) was a mismatch between two components that were each behaving as specified. None
  of them is reachable without live data.
- **D12: adjacency was too tight, and one fault came out as seven incidents.** H3 res-5 ring-1
  adjacency means "same cell or one of its six neighbours", which at res 5 is about 25 km. The
  regional anomaly has a 95 km radius and the reference field puts zones ~15 km apart, so its 62
  zones landed in 61 distinct cells and the fault was *not one connected component* — the engine
  was reporting its input correctly and its input was already fragmented. Measured across three
  resolutions × three ring sizes × all four scenarios before changing anything
  (`benchmarks/results/wp3-anomaly-connectivity.txt`): res 5 ring 1 gives **7 components** for the
  regional anomaly, res 5 ring 2 gives **1**. Ring 2 also keeps the multi-anomaly's two faults
  separate (2 components across 2 anomalies) and all 16 noise zones separate, so it is not merely
  a looser setting that smears everything together. `NEIGHBOUR_RING_SIZE` is now 2.
- **The lesson worth keeping from D12.** The correlation engine was *correct* and the answer was
  *wrong*, and no test of the engine could have found it — the component partition was a faithful
  report of an adjacency graph that had been configured wrong two layers away. Geometry is a
  parameter, and a parameter is only defensible against measured evidence.
- **D14: the incident closed in the middle of its own fault.** Found by the first *full-length*
  run, after D12 was already fixed — the earlier truncated run had passed because it had not yet
  reached the point where the window lapsed, which is its own lesson about stopping a run early.
  `stream-processor` is **edge**-triggered: `shouldAlert` fires only on a state *change*, which is
  correct for something persisting transitions. The correlation window is **level**-expecting: "a
  zone is an active member while it has degraded within the last `CORRELATION_WINDOW_MS`". 62 zones
  crossed into STRESSED over 80 seconds and then said nothing for 2.2 simulated hours, because
  nothing changed. The engine's watermark froze at 2555 s, its 120 s window expired every member at
  2680 s, and the incident **closed while the fault was still running** — then re-opened in
  fragments at the decay. One fault, seven incidents, and an 8,070-second hole in which the system
  believed nothing was wrong.
- **Neither component was wrong, which is the whole point of D14.** The state machine emits edges
  because a transition is an event; the window integrates levels because membership is a duration.
  Both are defensible in isolation and the bug lived entirely in the seam — which is why 283 unit
  tests, a differential fuzz with zero divergences and 156,773 invariant checks all had nothing to
  say about it. And the failure was not a crash or a dropped message: it was a confident,
  well-formed, fully-persisted answer that was wrong.
- **Fixed by re-assertion, not by permanent membership.** A zone in a non-NORMAL state republishes
  its degradation every `DEGRADATION_REASSERT_MS` (30 s of event time, four per window). The
  tempting alternative — keep a member until an explicit recovery arrives — trades this defect for
  a worse one: a producer that dies holding degraded zones leaves them in an incident forever,
  silently and looking exactly like an ongoing fault. Belief that decays without evidence is the
  property you want from a monitoring system; re-assertion is what *supplies* the evidence.
  ADR-008.
- **It also made an existing claim true.** ADR-000's amendment justified dropping a failed sensor
  event on the grounds that "a degradation is one sample of a signal re-sampled every second". That
  was true of the *sensor* signal and false of the *degradation* signal at the moment it was
  written. Worth noting as a class of error: a justification that is true of the thing next to the
  one it is about.
- **D13: the batching/determinism question from S6, decided with live data.** S6 flagged that
  `openedAt` is in the incident id preimage and was the per-batch reconcile watermark, so ids
  depended on where Kafka drew a boundary. The live run measured **70 messages across 68 batches
  — about one message per batch**. Degradations are rare and the pipeline keeps up, so per-batch
  reconciling had silently degenerated into per-message reconciling precisely when the system was
  healthy, and consolidated only when it was lagging. It was delivering none of the benefit it was
  chosen for while carrying all of its determinism cost. **Not deferred: fixed.** Reconciles now
  run at multiples of `RECONCILE_TICK_MS` of event time.
- **What the grid buys, stated as a property.** A boundary `B` is reconciled when the first
  message with `eventTime > B` arrives, so that reconcile sees exactly the messages at or before
  `B`, whatever the broker did. `reconcileGrid.test.ts` runs the same twelve messages under four
  batchings — one at a time, all at once, and two irregular rhythms — and asserts **byte-identical
  output including incident ids**. The determinism claim loses its caveat.
- **`eachBatch` stays, and the distinction is the interesting part.** The batch is still the unit
  of offset resolution and of dispatch. It is no longer the unit of reconciliation. Conflating
  those two was the actual mistake, and it is not obvious until you notice that one of them is a
  transport concern and the other is a semantic one.
- **`flush()`, and the one place event time is invented.** A boundary is completed by a *later*
  message, so the final interval of a bounded stream would never be announced. `flush()` closes it
  out on the grid, and is idempotent so it cannot be used to march the watermark forward. WP6b
  must call it.
- **D1's second copy is closed, with the opposite policy.** `stream-processor`'s `eachMessage` had
  the same try/catch-and-log that `alert-processor` had. `processWithRecovery` moved into
  `@geopulse/kafka-recovery` and gained a **required** `onFailure` argument: `alert-processor`
  dead-letters, `stream-processor` drops. A sensor event is one sample of a signal re-sampled every
  second — `avg1m` is a mean over sixty of them — while a degradation is a derived fact nothing
  re-emits. 400 dead letters per second onto a single-partition topic nobody would ever replay is
  not a durability story. The argument is required rather than defaulted so the cheap policy cannot
  be inherited by accident. ADR-000 amendment.
- **The rename actually lines up now.** `zone.alerts` is gone from the topic spec, the producer,
  the consumer and the types; `zone.degradations.dlq` finally shadows a topic that exists. The
  `zone_alerts` *table* keeps its name — that is a migration plus every query in `api`, for nothing
  the topic rename has not already bought. Flagged for WP7.
- **Incident persistence went into `alert-processor`, not a sixth service.** Two consumer groups,
  two failure domains, one process — sharing the Postgres pool, the DLQ connection and the metrics
  endpoint. A second service would have duplicated all three to gain nothing a second consumer
  group does not already give. It also now owns and applies the migrations at startup: the
  `initdb` hook only runs on an empty data directory, so a migration added later silently did not
  apply to anyone who already had a volume — the stack came up healthy and the first incident
  write failed on a missing relation.
- **What makes at-least-once safe for the incident tables, in two parts.** Idempotence: full-row
  upserts on a deterministic id, plus a uniqueness constraint on
  `(incident_id, event_type, event_time)` for the one append-only table. And *ordering*, which
  idempotence alone does not give — replaying `GREW` after `CLOSED` would reopen a closed incident,
  and what prevents it is that every event for one incident is on one partition because the key is
  fixed at its first event. That is the concrete reason ADR-004's keying is a correctness decision
  and not a throughput one.
- **The simulator does not run at `SPEED_MULTIPLIER`.** At 400 zones it is throughput-bound at
  ~2,000 events/s, so a nominal 60× achieves about 5× and four simulated hours takes ~45 real
  minutes. The multiplier is a ceiling, not a promise. The benchmark script measures and prints the
  achieved rate, because a run that silently goes at a twelfth of its configured speed produces
  numbers that mean something other than what its header says.
- **Next:** WP6b — the eval harness. Everything it needs exists: ground truth on disk, incidents in
  Postgres and on `zone.incidents`, and an I/O-free replay path. Owner owes the WP0, WP6a, WP1,
  WP2a, WP2b and WP3 understanding checkpoints.

#### WP3 understanding checkpoint — five more questions from this session

Added to the twelve at the end of the S6 entry.

13. The engine was correct and the answer was wrong. Explain how, and say what class of bug that
    is — then say what would have caught it earlier than an end-to-end run.
14. Ring 2 fixed the fragmentation. Why is that not just "loosen it until the number looks right"?
    Name the measurement that distinguishes the two.
15. The live run showed ~1 message per batch. Explain why that made per-batch reconciling worse
    than useless rather than merely unnecessary.
16. What exactly does reconciling on an event-time grid guarantee that per-batch reconciling did
    not? State it as a property of the output.
17. `flush()` invents up to one tick of event time. Justify that, and say why it is safe at the end
    of a stream and would not be in the middle of one.
18. D14: name the two components, say what each was doing correctly, and explain why joining them
    produced an answer that was wrong rather than an error that was visible.
19. Why is periodic re-assertion the right fix rather than keeping a member until its recovery
    arrives? Describe the failure the second option has and why it is worse.
20. `DEGRADATION_REASSERT_MS` is 30 s against a 120 s window. Justify the ratio — what does the
    factor of four buy that a factor of one would not?

### 2026-09-18 — S6: WP3 items 1–5 and 7 (the `correlation-engine` service)

- **The core is now a service.** `services/correlation-engine/src/` around the existing
  `src/core/`: pino logger, prom-client registry, `eachBatch` Kafka consumer, incident producer,
  Redis incident state, zone registry, config, `.env.example`, README, ADR-004. 267 tests,
  97.09% statements / 96.47% branches. **Items 6 (Postgres) and 8 (the `stream-processor`
  producer change) were deliberately left for the next session**, which means WP3's end-to-end
  acceptance criterion is not met and cannot be until item 8 lands — nothing produces to
  `zone.degradations` yet.
- **Not verified against a live stack.** Docker was not running on the machine. Everything here
  is proven by tests, including against the real `NeighbourGraph`, but no message has travelled
  through a real broker. That verification is the first thing the next session should do.
- **`eachBatch`, and what it actually buys.** A regional fault is a burst — 62 zones in the
  reference scenario — and `eachMessage` would fold it one zone at a time with a reconcile after
  each: an `OPENED` plus 61 `GREW`s, every one obsoleted by the next, all published, written and
  persisted. `eachBatch` folds the burst and reconciles once: one `OPENED` with 62 members. The
  thing to be clear about in an interview is that **this is not a throughput optimisation**. The
  output is better, because a lifecycle stream is read by a person and should describe the fault
  rather than the arrival order of the messages that revealed it.
- **And what it costs, which is the more interesting half.** `openedAt` is in the incident-id
  preimage (ADR-003), and `openedAt` is the watermark of the reconcile that opened the incident.
  So a coarser reconcile cadence changes *which* watermark an incident opens at, and can change
  its seed set — a component that forms and dissolves inside one batch is never seen at all.
  Output is byte-identical for a fixed message order **and a fixed batching** (asserted), but two
  live runs can name the same incident differently, because batch boundaries are a broker fetch
  artefact. Stated in the README, the class doc and ADR-004, because "why do the ids differ
  between runs" is otherwise an alarming question with a boring answer.
- **The non-obvious bug that `IncidentDispatcher` exists to prevent.** Offsets resolve only after
  publish and Redis write succeed — that much is just D1's lesson. The trap is what happens on
  the redelivery: the engine's state is in memory and every operation in the fold is idempotent,
  so re-folding the batch produces the *same state* and therefore emits **nothing**. The events
  from the failed attempt would vanish, with no error anywhere, and the engine would go on
  believing it had announced an incident it never announced. At-least-once over a *stateful*
  consumer is not the same problem as at-least-once over a stateless one. Events are therefore
  held outside the fold until a flush succeeds.
- **The centroid is a mean of unit vectors, not of coordinates.** Two zones at +179.9° and
  -179.9° are 22 km apart; the componentwise mean puts their centre in the Gulf of Guinea, 20,000
  km from both — a plausible-looking number, drawn on a map and believed. `packages/spatial`
  already tests adjacency across the antimeridian, so an incident genuinely can straddle it.
  Three multiplies per member, and the seam disappears because the representation has no seam.
- **`correlation_latency_ms` is event time on both ends.** Not `Date.now() - eventTime`: the
  simulator publishes at a fixed historical epoch, so that subtraction reports about 245 days —
  and mixing the two clocks is the exact mistake that cost 5.76M messages in D10. It measures
  from a zone's first degradation to the incident event that adds it, which composes with the
  256 s detection floor WP6a already measured. Wall-clock cost has its own metric.
- **A malformed degradation is skipped and counted, not dead-lettered.** Different call from
  `alert-processor`'s (ADR-000), and the difference is the data: a lost alert is a lost fact, but
  a degradation is one sample of a signal re-sampled every second, and a poison message that
  stalls the partition costs every *other* zone's correlation while it sits there. Skipping is
  the cheaper failure; `degradations_rejected_total` is what keeps it from being a silent one.
- **The partition key is fixed at an incident's first event.** If it moved as the incident grew
  across a coarse-cell boundary, that incident's own events would scatter across partitions and
  lose their relative ordering — and a `MERGED` arriving before its `OPENED` refers to an
  incident the consumer has never heard of. The rule is "smallest coarse cell among the founding
  members", so it is reproducible rather than arrival-order dependent.
- **ADR-004 written**, covering both the keying and the batching, with the alternatives that lost
  — including the one worth naming: the two-level scheme where a local incident touching its cell
  boundary is republished under the parent cell for a second stage to merge, which is the
  complete answer and is deferred rather than rejected.
- **Next:** WP3 items 6 and 8 — the Postgres migration and incident persistence, and
  `stream-processor` emitting `ZoneDegradation` to `zone.degradations` keyed by `h3CoarseCell`
  including recovery transitions. Then the end-to-end run against a live stack, which closes WP3.
  Owner owes the WP0, WP6a, WP1, WP2a and WP2b understanding checkpoints.

#### WP3 understanding checkpoint — questions owed

The first four are the WP3 questions from `02-PHASE-1-CORRELATION.md`; the rest came out of this
session. ADR-004 answers most of them in prose, so answer closed-book first.

1. Why is correlation a separate service rather than part of `stream-processor`? Name the
   property of the per-zone stage that would be destroyed.
2. Why key `zone.degradations` by coarse H3 cell instead of `zoneId`? What property does that
   buy, and what does it cost?
3. What happens to an incident that straddles two coarse cells? How often does that happen, what
   is the fix you would build next, and why has it not bitten yet?
4. Why `eachBatch` over `eachMessage` *here specifically*? Give the argument that does not
   mention throughput.
5. Batching changes incident ids between runs. Explain the mechanism exactly — which field, why
   it is in the preimage, and what is still guaranteed.
6. A batch is published to Kafka, and the Redis write then fails. Walk through what happens on
   the redelivery, and say why "the retry will re-emit them" is wrong.
7. Why is a malformed degradation skipped rather than dead-lettered, when `alert-processor`
   dead-letters a malformed alert? What fact about the data makes the two different?
8. `correlation_latency_ms` could have been `Date.now() - degradation.eventTime`. Say what that
   number would have been in this system, and what it would have meant.
9. Why must an incident's partition key be fixed at its first event? Describe the concrete
   failure if it moved.
10. Why is the incident centroid computed from unit vectors? Give the two-zone example and the
    size of the error.
11. Why is `radiusKm` a maximum rather than a mean or a 95th percentile?
12. Why does the incident severity roll up as a max and not a mean? What would a mean say about
    an incident that just doubled in size?

### 2026-09-18 — S5: WP2b (correlation core — incident lifecycle)

- **WP2b done, so WP2 is done.** `IncidentLifecycle` turns the component partition into named,
  long-lived incidents: OPENED / GREW / SHRANK / MERGED / CLOSED, deterministic ids, merge and
  split policy, property tests, ADR-003. 144 tests in the service, 100% statements *and* branches
  over `incidentLifecycle.ts`.
- **A component is not an incident, and the gap is the whole work package.** A component is
  anonymous, instantaneous and set-valued. `{Z-1,Z-2,Z-3}` at 12:00 and `{Z-1,Z-2,Z-3,Z-4}` at
  12:01 are two different sets; whether they are one incident or two is not a fact about the data,
  it is a decision. Four decisions had to be made and each had a defensible alternative — be able
  to state the alternative before stating the choice.
- **The id is a hash of the facts: `SHA-256(scheme | openedAt | sorted seed members)`, 64 bits.**
  Not a UUID (two runs of the same scenario would name the same incident differently, and every
  measurement in this project is a replay compared against a replay). Not a counter (stable only
  if incidents open in the same order every time, which stops being true the moment two coarse-cell
  partitions are consumed concurrently). Not the union-find root (it is re-picked on every
  rebuild). Not a hash of the *current* members (it would change on every GREW, i.e. no identity
  at all). Hashing the *seed* set fixes the name at birth.
- **The property tests found a real defect, which is the reason to write them.** The uniqueness
  argument was: the preimage has `openedAt`, components are disjoint, event time is a monotonic
  watermark — therefore no two incidents can share a preimage. Monotonic is not strictly
  increasing. A zone that recovers and re-degrades inside one millisecond closes an incident and
  opens an identical one at an unchanged watermark, minting the same id twice; at `minZones: 1`
  that is a single pair of messages. fast-check shrank it to 30 events in five steps. Fixed by
  retaining the ids retired **at the current watermark instant** and disambiguating against them,
  pruned the moment event time moves past them. Unit tests and a careful correctness argument both
  missed it.
- **Merge is won by age, split by inheritance.** Survivor of a merge is the earlier `openedAt`,
  ties broken lexicographically — age is monotone, so the decision cannot be revised later,
  whereas "larger wins" would hop the identity between two incidents while an engineer watched.
  Losers get a terminal `CLOSED` carrying `supersededBy`, so a consumer holding the dead id
  follows a pointer instead of noticing silence. On a split, the fragment that *inherited the
  most members* keeps the id (not the largest fragment: a fragment can be large because unrelated
  zones joined it in the same batch), others open fresh with `splitFrom`. On-call continuity over
  set-theoretic purity, per ADR-003.
- **`DRAINING` is not decoration.** "Close after `INCIDENT_CLOSE_GRACE_MS` below the minimum" and
  "no OPEN incident is below the minimum" cannot both hold with two statuses. The third state is
  what a grace period *is*, and an incident that regrows during it comes back as the same id —
  1,655 such revivals in the property run, which is the flapping-fault case the grace period
  exists for.
- **Identity survives shrinkage, not disappearance.** An incident whose every member leaves closes
  at once with `DISSOLVED` rather than serving out the grace period: with no live member there is
  nothing that could reclaim the id, so waiting only delays a certain close. The consequence is
  real and deliberate — a fault that goes quiet longer than `CORRELATION_WINDOW_MS` and returns is
  two incidents, because claiming continuity across a gap where no zone was degraded would assert
  a causal link the data does not support.
- **The reachability oracle is written independently, on purpose.** The property that two zones
  share a component iff a path of active adjacent zones connects them is checked against a plain
  BFS in the test support, not against `NaiveConnectivity`. A comparison between the two
  production implementations cannot fail when both are wrong in the same way; this can.
- **Acceptance met: 2,500 sequences, 156,773 invariant checks after every event, 0 violations**,
  and 1,000 byte-identical replays of the whole JSON event stream, ids included. Reach is measured
  rather than hoped for: 6,219 incidents opened (186 of them from splits), 663 merges, 4,019
  closes across all three reasons, largest incident 19. Evidence:
  `benchmarks/results/wp2b-incident-properties.txt`.

**Understanding checkpoint questions (answer closed-book before reading ADR-003):**
1. Why is `incidentId` a hash and not a UUID? Name two things that break with a UUID and one that
   breaks with a counter.
2. A zone bridges two existing incidents. Walk through exactly what is emitted, and say what a
   consumer that already received *both* ids is supposed to do.
3. That bridging zone then expires and the component splits. Which fragment keeps the id, why that
   rule and not "the largest fragment", and why is the whole policy better than closing the
   original and opening one incident per fragment?
4. Why can an incident be `DRAINING` but never `OPEN` with two members, when `INCIDENT_MIN_ZONES`
   is three?
5. An incident's last member recovers, and ten seconds later the same three zones degrade again.
   One incident or two? Defend it.
6. The property tests found an id being reused. What was wrong with the uniqueness argument, and
   why would neither the unit tests nor the differential fuzz have caught it?
7. `reconcile` takes the whole partition rather than a delta. What does that cost, why is it the
   right trade here, and what would have to be true for it to stop being so?

### 2026-09-18 — S4: WP2a (correlation core — window + connectivity)

- **WP2a done.** `CorrelationWindow` (event-time membership), `TimeAwareConnectivity`
  (incremental union-find + local rebuild), `NaiveConnectivity` (the oracle) and the
  differential fuzz. 103 tests, 100% statements over the core. **`IncidentLifecycle` is
  deliberately not here** — that is WP2b, per the roadmap.
- **The thing union-find cannot do, and what we do instead.** Union-find is the right structure
  for arrivals and has no delete — not as an oversight, but because it is fast *precisely* by
  discarding which edge merged two elements. Our members expire, so delete is not optional. The
  resolution: union-find on the arrival path (path compression, union by rank), and on removal
  tear down **only the components that lost a member** and rediscover each with a BFS over its
  survivors. Cost is O(V+E) over affected components, not over the active set. Justified by two
  facts about the workload rather than in the abstract — a degrading zone refreshes ~120 times
  per expiry (1 s samples, 120 s window), and a component is tens of zones out of thousands —
  and both are instrumented (`rebuilds`, `rebuiltMembers`, `maxRank`) so the assumption is
  measurable rather than asserted.
- **The circular member list is the piece that makes it work.** Union-find knows whether two
  zones are together but not *who else* is in there with them, and the rebuild needs exactly the
  survivors. Each node carries a `next` pointer forming one cycle per component; `union` splices
  two cycles in two pointer writes, O(1), independent of which root union by rank picked. The
  obvious alternative, `Map<root, Set<member>>`, has to move a set on every union.
- **Rebuild sorts its survivors before the BFS.** O(k log k) on a small set, and it buys the
  property everything else leans on: a rebuilt component is a function of *who survived* and the
  current adjacency, never of the merge history of the component it replaced. Replay is therefore
  exact, and a rebuilt component is indistinguishable from one built fresh — asserted directly.
- **Acceptance met: 11,000 sequences, 551,871 operations, 0 divergences.** Both implementations
  answer one `Connectivity` interface, are driven through **one** shared `CorrelationWindow` with
  an identical call sequence, and their partitions are compared **after every operation** — a
  stale parent pointer can sit invisible for twenty operations before it decides a merge, and
  comparing only final state lets a later rebuild mask the bug it happened to fix. Evidence:
  `benchmarks/results/wp2-differential-fuzz.txt`. The seed is pinned, so a failure reproduces
  exactly instead of being filed as flakiness.
- **The fuzz was nearly worthless and nothing would have said so.** fast-check biases array
  lengths small, so the first version averaged **five events per sequence** — most of those
  10,000 sequences never built a multi-zone component at all, and it passed. Fixed with
  `size: 'max'` plus a minimum length, and then a second property was added that asserts what
  the generator actually *reaches*: 7,732 component splits, 110,754 expiries, 21,089 early
  recoveries, 5,305 full teardowns, largest component 28. Floors sit well below current output,
  so a future change that guts the generator fails there rather than passing everywhere. This is
  the general failure mode of fuzz testing and it is worth being able to describe.
- **1,000 of those sequences run over the real WP1 `NeighbourGraph`**, not only over random
  graphs, and the symmetry that `AdjacencyProvider` documents — and that the incremental hot path
  depends on, since it only ever unions a joining zone against its own neighbour list — is
  asserted over a real 36-zone field rather than assumed.
- **The caveats are tested, not commented.** A degradation whose whole window already lies behind
  the watermark is refused rather than admitted as a phantom member for one compaction interval.
  An edge the graph learns after both endpoints last degraded is missed until one re-degrades —
  one-directional (it can only miss a merge, never invent one) and it heals within a sample
  interval. `representativeOf` is diagnostics only, and a test pins that it really does move, so
  nothing downstream is tempted to key on it.
- **Determinism guarded by a test, not by discipline.** The suite greps the core for `Date.now`,
  `Math.random`, `new Date` and `process.hrtime`, so rule 3 fails the build rather than quietly
  making two benchmark runs disagree by a few percent and getting blamed on the machine.
- **ADR-002 written**, including the alternative worth naming: fully dynamic connectivity
  (Holm–de Lichtenberg–Thorup, link-cut / Euler-tour trees) at O(log² n) amortised, rejected as
  more intricate machinery than a few-dozen-vertex rebuild justifies — with an explicit trigger
  for revisiting it.
- **Next:** WP2b — `IncidentLifecycle`, merge and split policy, deterministic incident ids,
  property tests, ADR-003. Owner owes the WP0, WP6a, WP1 and now WP2a understanding checkpoints.

#### WP2a understanding checkpoint — questions owed

Answer these without looking at the code. The first five are the WP2 questions from
`02-PHASE-1-CORRELATION.md` that WP2a covers; the rest came out of this session. ADR-002 answers
several of them in prose, so answer closed-book first.

1. Walk through union-find with path compression and union by rank. What is the amortised
   complexity, and what is α?
2. Why can't you just delete from a union-find? Answer at the level of *what information the
   structure threw away*, not "there's no delete method".
3. How do you know your optimised connectivity is correct? Say why differential testing against
   an oracle is stronger evidence than unit tests alone — and what it still does not prove.
4. Why is the naive full-recompute implementation not dead code, and what would be lost by
   deleting it once the fast one works?
5. Name the structure that *does* make deletion cheap, state its complexity, and say why you did
   not need it. Then say what would have to change for you to need it.
6. Why does each node carry a `next` pointer? What would the obvious alternative cost, and why
   does it interact badly with union by rank specifically?
7. Why does the rebuild sort its survivors before the BFS, given that sorting is strictly extra
   work? What property would be lost without it?
8. The differential fuzz initially averaged five events per sequence and passed. Why did nothing
   catch that, and what is now in place so it cannot happen quietly again?
9. Why is the fuzz seed pinned rather than drawn fresh each run? Give the argument *against*
   pinning too, and say why it loses.
10. A degradation arrives whose event time is older than `CORRELATION_WINDOW_MS` behind the
    watermark. What happens to it, and what goes wrong if you admit it instead?
11. `representativeOf` returns a union-find root. Why must nothing downstream use it as an
    incident id? Describe the concrete sequence that changes it while the component's membership
    is unchanged.
12. Why must the adjacency relation be symmetric? Name the specific place the incremental path
    and the oracle would disagree if it were not.

### 2026-09-17 — S3: WP1 (H3 neighbour graph)

- **WP1 done.** `NeighbourGraph` answers "who is adjacent to this zone" out of a
  `Map<cell, zoneId[]>` occupancy index and a cached `gridDisk`, so a lookup is a handful of
  hash hits over 7 cells rather than any distance computation at all. `addZone` keeps it
  incremental, because zones are discovered at runtime and a one-shot build would miss them
  until a restart.
- **It lives in `packages/spatial` (`@geopulse/spatial`), a `file:` dependency, not a copy.**
  Two processes have to agree on this geometry — `stream-processor` writes a zone's cell at
  registration, the correlation engine builds components out of it — and a disagreement is
  silent rather than loud: res-5 and res-6 ids are both valid, just in different tilings, so
  every lookup returns empty and the system calmly reports that nothing in the world is
  correlated. The service's `spatial.ts` is deleted and it now compiles against the package, so
  the sharing is real rather than aspirational. Cost: the package has to be built before a
  consumer compiles, noted in `CLAUDE.md`.
- **The graph is flat in the fleet size and the scan is linear**, which was the thing to prove:
  0.58 → 1.03 µs across 1k → 100k zones against 39.6 → 4630.7 µs, a 4484× gap at 100k. Packing
  the same 400 km square tighter instead *does* slow the graph down, 0.70 → 27.9 µs, because
  the answer itself grows from 7.6 zones to 771 — it pays for the size of the answer, never for
  the size of the search. Both series are committed; the second is the unflattering half and it
  is the one that shows the cost model is understood.
- **The benchmark caught something worth keeping.** Neighbour counts drifted 2.9 → 4.2 in a
  series where the zone density was fixed. It tracks the mean area of the cells the field landed
  in (188 → 257 km²): a res-5 cell is 156 km² in some parts of the world and 305 km² in others,
  so the same sensor density gives different neighbourhood sizes depending on where on the
  icosahedron the region sits. Now a measured column rather than a mystery. Placement also had
  to scale longitude by 1/cos(lat), or the 100k field would have been 13% denser at its edges
  than at its middle and part of the result would have been an artefact of the field.
- **31 tests, including the cases that break naive schemes.** Antimeridian — two zones 4.4 km
  apart on the ground and 359.96° apart in the coordinate land in one cell — plus the mirror
  case, that merely being on both sides of the line is not adjacency. Both poles. A zone inside
  one of the twelve pentagons (`gridDisk`, never the `gridRing*Unsafe` variants, which throw
  there). Zones alone in a cell and several in one cell. Agreement with a haversine oracle that
  shares no code with the implementation, and with an independent grid-distance definition.
  Neighbour ordering is asserted element for element, because WP2 will merge components in the
  order it walks these lists.
- **A stored `h3Cell` at the wrong resolution is recomputed and counted, not trusted.** That is
  the silent-failure guard: the registry's cell is used only when it is valid *and* at this
  graph's resolution, and `stats().recomputedCells` makes a producer disagreement visible.
- **ADR-001 written**, every number in it produced by `benchmarks/neighbour-graph.ts`: hexagon
  equidistance 1.045 median / 1.207 worst against a square grid's exact 1.4142 for its
  diagonals, res-5 area spread 1.95×, and the honest cost — adjacency brackets a distance
  rather than equalling one (9.2 km can already be non-adjacent, 31.7 km can still be
  adjacent). The filter-then-verify upgrade is recorded as deferred with an explicit trigger,
  not dismissed.
- **Next:** WP2, the correlation core — the package that carries the interview. Owner owes the
  WP0, WP6a and WP1 understanding checkpoints.

#### WP1 understanding checkpoint — questions owed

Answer these without looking at the code. The first four are the WP1 questions from
`02-PHASE-1-CORRELATION.md`; the last two came out of this session.

1. Why hexagons rather than squares? Give the geometric reason and say what it does to a
   *measured* incident extent — not "Uber uses it".
2. What does resolution 5 mean in kilometres, and how was it chosen? What breaks if it is too
   coarse? Too fine? (D9 is the concrete version of one of those failures.)
3. H3 cells are not uniform in area — why not, and does it matter here? Say why the variation is
   tolerable for the claim this system makes, and name a claim it would not be tolerable for.
4. Two zones 500 m apart that fall on opposite sides of a cell boundary — what happens to them,
   and where does the discontinuity actually live?
5. Why does `neighboursOf` get slower in the constant-area series but not in the
   constant-density one? State the cost model in one sentence.
6. Why is the neighbour graph a shared package rather than a module copied into each service?
   Describe the failure a copy would eventually cause, and why nothing would appear in the logs.

### 2026-09-17 — S2c: D10 diagnosed and closed

- **The lead was wrong, and it was worth testing rather than building on.** The session opened
  with a strong hypothesis: `ZoneStateStore` takes its watermark as a global max, zones live on
  12 independently-drained partitions, the observed 22-minute `lastEventTime` spread exceeded the
  15-minute idle TTL, so zones on a lagging partition should have been evicted in a loop. The
  numbers fitted. It was still wrong — the events were never reaching the processor to be evicted.
- **Root cause: Kafka was deleting the events.** `raw.zone.events` was empty — earliest offset
  equal to latest on all 12 partitions. The simulator set each record's Kafka timestamp to its
  *simulated* event time (2026-01-15, fixed by ADR-005 so runs stay comparable). Retention is
  evaluated against that field, the broker's clock says September, and the topics ran `CreateTime`
  with 7-day retention — so every message arrived **245 days past its deletion deadline** and the
  broker deleted each segment seconds after it rolled. 64 deletions, several of them at 16:49:55
  while the S2b consumer was mid-read. Evidence: `benchmarks/results/d10-root-cause.txt`.
- **A false premise is what kept S2b from getting there.** S2b treated `avg1m = avg5m = 0` in
  Redis as a symptom needing explanation, and concluded eviction was insufficient because an
  evicted zone refills its window in five minutes. But `writeZoneState` only fires on a state
  transition — those zeroes were the `registerZone` defaults for a zone that never transitioned,
  and never said anything about window state at all.
- **Fix: the producer sets no record timestamp, and all topics pin
  `message.timestamp.type=LogAppendTime`.** Event time still travels in the payload, which is the
  only place any consumer reads it. A Kafka record timestamp is a storage-layer fact about data
  ageing and belongs to the broker; deciding when a broker deletes its own data is not a
  producer's call. ADR-007.
- **A third change was needed to make the fix real.** `admin.createTopics` does not apply
  `configEntries` to a topic that already exists, so the topic config would have been a silent
  no-op on every broker that already had the topics — which is every broker that has ever run
  this project. **D10 would have survived its own fix.** The bootstrap now reconciles configs
  against what the broker actually has, and logs every change.
- **Verified end to end.** Same scenario, same seed, nothing else changed: 5,760,000 events, **0**
  segment deletions, **62** zones STRESSED and **47** CRITICAL — matching the offline replay's
  prediction exactly, down to the last STRESSED landing at the same millisecond of event time.
  All 62 recover when the anomaly decays. `benchmarks/results/d10-after-fix.txt`.
- **The watermark question is filed as D11, open and unobserved.** The minimum-across-partitions
  design is right in general and the change is small, but the post-fix run logged **0 evictions
  across 400 zones and 5.76M events**: when the consumer keeps pace, skew stays far below the TTL,
  and the S2b spread that made the hypothesis attractive was itself an artefact of segments being
  deleted mid-read. Not fixed, because fixing an unobserved defect is exactly how the wrong
  diagnosis became attractive. The instrumentation to answer it with a number is now in place.
- **Next:** WP1 (spatial layer), then WP2. WP6b is unblocked but still needs WP3 before there are
  incidents to score. Owner owes the WP0 and WP6a understanding checkpoints.

#### D10 understanding checkpoint — questions owed

1. What is a Kafka record timestamp *for*, and why is it not the same thing as application event
   time? What breaks when you conflate them?
2. Consumer lag read zero on every partition throughout. Why was that not evidence that the data
   had been consumed?
3. Why does `LogAppendTime` on the topic matter when the producer has already stopped setting a
   timestamp? What does each of the two changes buy on its own?
4. The bootstrap had to learn to reconcile configs. Why would the fix otherwise have been a no-op
   on every existing broker, and what class of bug does that pattern belong to?
5. The eviction hypothesis fitted the observed numbers well. What was the one observation that
   should have made it suspect, and what would have tested it fastest?

### 2026-09-17 — S2b: WP6a (anomaly scenarios + ground truth)

- **WP6a done.** All four scenarios from `03-MEASUREMENT.md` §2.1 inject faults and emit labels
  to `evals/groundtruth/<run-id>.jsonl` in the §2 schema: `regional-anomaly`,
  `propagating-anomaly`, `multi-anomaly` (two disjoint faults, catches over-grouping) and
  `noise` (16 isolated single-zone bursts, catches hallucinated incidents; the correct answer
  there is zero incidents).
- **The design point.** One severity function, called by both the event generator and the label
  deriver, on the same tick grid, at the same instants the events are stamped with. The labels
  cannot drift from the stream because there is no second implementation for them to drift from.
  Written up in `docs/adr/ADR-006-ground-truth-by-construction.md`.
- **Found and fixed a bias in my own labels.** Onset was recorded when severity crossed the
  membership cut, which on a 120-second ramp is ~12 s after the zone's load has already crossed
  the degradation threshold — so every time-to-detect would have been reported 12 s faster than
  it was. Membership and onset are now separate thresholds; onset is pinned to the earliest
  instant the load *could* have crossed, so the residual error is conservative, never flattering.
  The deriver also now refuses to emit a label whose peak severity falls between the two.
- **Found D9, closed it.** The fibonacci-spiral zone layout put the closest pair of zones 160 km
  apart at 5000 zones, with **zero** pairs inside an H3 res-5 neighbour ring at any zone count.
  A regional anomaly would have covered one zone and the collapse ratio would have been zero
  regardless of what WP1/WP2 did — the engine would have measured as broken while being correct.
  New `regional-grid` layout; anomaly scenarios default to it. Base loads are drawn i.i.d. there
  rather than by `index % 7`, which on a grid lays down diagonal stripes of spatially correlated
  baseline load — exactly the structure the engine is supposed to find only when an anomaly put
  it there.
- **Determinism asserted byte-for-byte**, across zone placement, the anomaly plan, the event
  stream and the ground-truth file — and the mirror image too, that a different seed gives a
  different run, since a builder that ignored its seed would pass every reproducibility check.
  The run id is derived from the simulated epoch, scenario and seed rather than the wall clock:
  it is embedded in every record, so a wall-clock id would make every record non-deterministic.
- **Labels verified against the real state machine**, not only against the simulator's own idea
  of a degrading load. Ordered replay through the stream-processor's `TimeWindowManager` and
  `StateMachine`: 62/62, 57/57, 43/43, 16/16 labelled zones reach STRESSED; 0 of 40 unlabelled
  controls transition. Median detection lag 256 s — the documented floor, not a defect.
- **Found D10, open, blocks WP6b.** A live 400-zone run put 5.76M events through the stack —
  lag 0 on every partition, all 400 zones registered — and produced **zero** degradations, with
  every zone left at `avg5m = 0`. The ordered replay proves the events are fine, so the fault is
  in the consumption path. The obvious suspect is watermark-driven eviction under cross-partition
  skew, and eviction does happen (7,230 evictions at 20 min of skew) — but it was tested and does
  not account for the symptom, because an evicted zone refills its window within five simulated
  minutes and still crosses the threshold. Recorded as a lead, not a diagnosis.
- **Next:** **D10 first** — WP6b cannot produce a meaningful number until it is fixed, and it is
  cheap to get wrong quietly. Then WP1 (spatial layer), which is unblocked and now has a zone
  field dense enough to test against. Owner still owes the WP0 understanding checkpoint.

#### WP6a understanding checkpoint — questions owed

Answer these without looking at the code:

1. Why is the ground truth derived from the same function the generator uses, rather than
   observed from the emitted stream? What specifically would go wrong with the observed version?
2. Why are there two severity thresholds rather than one? Which metric would be wrong with one,
   and in which direction?
3. Why is the radial profile floored instead of falling smoothly to zero at the rim? What does
   that cost, and why is the cost worth paying?
4. Why do `multi-anomaly` and `noise` exist? Name the specific failure each catches, and say what
   a suite without them would report for a system that merged the whole map into one incident.
5. Why is the run id not a wall-clock timestamp?
6. What is the detection floor, where does it come from, and why would a *faster* measured TTD be
   a reason for suspicion rather than celebration?

### 2026-09-17 — S2a: D8 (simulator event clock) + infra hardening
- **D8 closed.** Replaced the per-zone event-time accumulator with one `VirtualClock` shared by
  every zone: simulated time is a pure function of the tick count from a fixed epoch, so zones
  cannot drift. Per-zone sensor lag stays — the consumer should face out-of-order arrival — but
  as a bounded offset (0–20 ms, hashed from the zone id), never a rate.
- Added `SPEED_MULTIPLIER` (simulated ms per real ms). A 60× run emits byte-identical events with
  identical timestamps to a 1× run, in a sixtieth of the wall clock. `SimulationLoop` owns the
  only wall-clock read left in the simulator and uses it purely to pace, against absolute
  deadlines so timer rounding cannot accumulate.
- Event ids are now v5 (name-based) UUIDs over `zoneId:eventTimestamp`. `uuidv4()` made two runs
  of the same scenario differ byte for byte, which defeated the point of a deterministic
  simulator. `EVENTS_PER_SECOND` removed — see `01-ARCHITECTURE.md` §7.2.
- **Verified live at 60×**: all ten zones reached `STRESSED` within a **17 ms** spread of event
  time, ~2.5 s after the simulator started. WP0's run produced zero transitions in 120 s. 19 rows
  landed in Postgres and the zone registry populated, all through password-authenticated Redis.
- Wrote `docs/adr/ADR-005-simulated-event-time.md` (alternatives rejected, costs accepted).
- **Infra hardening.** `geopulse-redis` now requires a password (`--requirepass`, dev credential
  `geopulse-dev`) and every service authenticates, so a service that reaches another project's
  Redis fails `AUTH` instead of silently sharing its keyspace — verified against `creavo_redis`.
  Host ports moved: **Redis 6380 → 6390, Postgres 5432 → 5434**. Not 5433 as planned: that is
  taken too (`entrance-ug-postgres`), which is the argument for the password rather than the port
  move. Both clients log their resolved target at startup.
- `infra_postgres_data` is clean — `zone_alerts` was empty before this session's run, so the 21
  February rows noted in S1 are gone.
- **Next:** S2b (WP6a scenarios + ground truth), or WP1 (spatial layer). Both are open; WP2 is
  unblocked whenever WP1 lands. Owner still owes the WP0 understanding checkpoint.

### 2026-09-17 — WP0: foundation and defect cleanup (S1)
- Closed D1 (silent alert loss: retry + backoff + `zone.degradations.dlq`, exception now
  propagates out of `eachMessage`), D2 (`KEYS` → `zones:registry` SET + one pipeline),
  D4 (stub `AlertProcessor` deleted, real class under test, coverage config honest),
  D5 (`ZoneStateStore`, event-time idle eviction). D3 deferred as the spec allows.
- Found and closed **D7**, new: the simulator's time-of-day load pattern used local-time
  `getHours()`, so load depended on the host timezone. Determinism is load-bearing here.
- Added `tools/kafka-bootstrap` (explicit topics, 12 partitions) and set
  `allowAutoTopicCreation: false` everywhere; added `h3-js` and the `zones:registry` +
  `h3Cell`/`h3CoarseCell` zone registry that WP1 reads; added jest to `api` and
  `sensor-simulator`, which previously had no tests at all.
- Wrote `docs/adr/ADR-000-delivery-semantics-and-dlq.md`.
- **Verified WP0 end to end against live Kafka/Redis/Postgres.** All four acceptance criteria
  pass. Two fixes came out of verification: zones now carry `state: NORMAL` from registration
  (previously the API listed quiet zones with no state at all), and the integration suite gained
  a real-rejection DLQ proof.
- **Found D8, which blocks WP2.** The simulator's event clock advances per-event rather than
  with elapsed time, so it runs at 0.5–10% of real time *and every zone runs at a different
  rate* (20× spread within 60s). Adjacent zones can therefore never appear to degrade in the
  same window — the exact judgement Phase 1 rests on. Not fixed here: the event-time model is a
  WP6a design decision. Evidence in `benchmarks/results/d8-simulator-event-clock.txt`.
- **Next:** WP1 (spatial layer) is unblocked — the registry shape it needs is live. **Pull WP6a
  forward ahead of WP2** to fix D8. Owner still owes the WP0 understanding checkpoint.

#### WP0 acceptance — all four verified against the live stack

| Criterion | Result |
|---|---|
| Bootstrap yields 12-partition topics, confirmed with `kafka-topics --describe` | OK — `PartitionCount: 12` on all main topics; DLQ 1 partition with `retention.ms=1209600000`. Re-running the bootstrap is a clean no-op. |
| A test where Postgres insertion fails and the message is provably still available | OK — unit tests, plus an end-to-end test using a real rejection (`zone_id` exceeds `varchar(10)`). Dead letter read straight off the broker with `kafka-console-consumer`, payload intact and provenance headers present. |
| No `KEYS` in any request path | OK — `grep` clean; the api fake Redis throws on `keys()` so a regression fails the suite. Live `GET /zones`, `/zones/:id` and `/zones/near` all served from the registry. |
| `npm test` passes in every service, coverage over real files | OK — 10 / 54 / 14 / 9 tests green across the four services. |

Also verified live: the registry populates with `h3Cell` + `h3CoarseCell` for all zones including
ones that never transition; the real `alert-processor` service retried a poisoned message at
100/300/900 ms and dead-lettered it without dropping it or stalling its partition.

**Local environment note.** Ports 5432 and 6380 were already taken by other projects
(`entrance_ug_db`, `creavo_redis`), so verification ran with a temporary port override
(Redis 6381, Postgres 5434), and `creavo_redis` on 6380 was a live hazard: a GeoPulse service
started while `geopulse-redis` was down read and wrote another project's Redis with no error
anywhere. **Both resolved in S2a** — Redis 6390 with a required password, Postgres 5434, and
`docker-compose up -d` now brings the whole stack up as committed.

### 2026-09-17 — Build roadmap and git rules
- Added git rules 7–10 to `CLAUDE.md`: commit incrementally throughout a session, author as the
  repo owner, **no Claude co-author trailers**, don't push unless asked.
- Wrote `docs/07-BUILD-ROADMAP.md` — 13 build sessions with copy-paste prompts and manual
  verification steps. Orchestration model: docs are the persistent master, one WP per session,
  `STATUS.md` is the handoff channel.
- **Next:** S1 (WP0). Prompt is in `07-BUILD-ROADMAP.md` §4.

### 2026-09-17 — Ideation and planning
- Audited the existing codebase; found defects D1–D6 and documented them.
- Evaluated five candidate directions; owner selected ① spatial correlation, targeting
  backend/distributed-systems roles, 2–3 week horizon.
- Wrote the full documentation set (`CLAUDE.md`, `docs/00`–`06`, this file).
- **Next:** WP0. Also ship the interim resume bullets from `05-RESUME.md` §2 immediately.
