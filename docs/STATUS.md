# STATUS — Living Progress Tracker

> **Agents: read this first, and update it at the end of any session that changed work-package
> state.** Keep it terse and factual. This file is the handoff between sessions.

---

## Current position

| Field | Value |
|---|---|
| **Phase** | Phase 1 — Spatiotemporal Incident Correlation |
| **Active work package** | S2a done — D8 closed and the simulator event clock rebuilt. WP1 and WP2 are both open. |
| **Last updated** | 2026-09-17 |
| **Last commit at time of writing** | `aceb776` |
| **Blocked on** | Nothing. **D8 is closed, so WP2 is unblocked.** |

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
| WP1 | Spatial layer (H3 neighbour graph) | ☐ Not started | |
| WP2 | Correlation core (time-aware connectivity) | ☐ Not started | **The deep one.** Budget the most time here. Was blocked by D8; unblocked as of S2a. |
| WP3 | `correlation-engine` service | ☐ Not started | |
| WP4 | Propagation vector | ☐ Not started | |
| WP5 | API + live map UI | ☐ Not started | |
| WP6a | Simulator ground truth | ◐ In progress | The event-time model landed in S2a (virtual clock, D8 closed, ADR-005). The anomaly-injection scenarios and ground-truth emission are still to do — that is S2b. |
| WP6b | Eval harness + benchmarks | ☐ Not started | |
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
| WP1 | ☐ | |
| WP2 | ☐ | |
| WP3 | ☐ | |
| WP4 | ☐ | |

---

## ADRs written

| ADR | Title | Status |
|---|---|---|
| ADR-000 | Delivery semantics for alert persistence, and what happens on failure | ☑ Written (WP0) |
| ADR-001 | H3 vs geohash vs k-d tree | ☐ Not written |
| ADR-002 | Time-aware connectivity strategy | ☐ Not written |
| ADR-003 | Incident identity, merge and split semantics | ☐ Not written |
| ADR-004 | Partitioning on coarse H3 cells | ☐ Not written |
| ADR-005 | Simulated event time: virtual clock, bounded lag, speed multiplier | ☑ Written (S2a) |

---

## Measured numbers

**Empty until measured. Do not fill from estimates.** Every row must cite a committed file.

| Metric | Value | Scenario / config | Source file | Date |
|---|---|---|---|---|
| Test coverage, sensor-simulator | 36.70% stmts | whole src tree, `npx jest --coverage` | `benchmarks/results/wp0-coverage.txt` | 2026-09-17 |
| Test coverage, stream-processor | 38.39% stmts | whole src tree | `benchmarks/results/wp0-coverage.txt` | 2026-09-17 |
| Test coverage, alert-processor | 47.08% stmts | whole src tree, integration suite skipped | `benchmarks/results/wp0-coverage.txt` | 2026-09-17 |
| Test coverage, api | 19.17% stmts | whole src tree | `benchmarks/results/wp0-coverage.txt` | 2026-09-17 |
| Simulator event-time rate | 1.000× real time | 20 zones, `SIM_STEP_MS=1000`, `SPEED_MULTIPLIER=1` | `benchmarks/results/d8-simulator-event-clock-after.txt` | 2026-09-17 |
| Zone-to-zone event-time divergence | 0 ms over 60 s (spread bounded at ≤ 20 ms) | as above; was 5681 ms before the fix | `benchmarks/results/d8-simulator-event-clock-after.txt` | 2026-09-17 |
| Wall clock per 60 s confirmation window | 60.00 s at 1×, 1.00 s at 60× | as above | `benchmarks/results/d8-simulator-event-clock-after.txt` | 2026-09-17 |

Re-run with `./benchmarks/run-coverage.sh`. These are low and they are honest — the previous
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
| D8 | Simulator event clock runs at 0.5–10% of real time and each zone's clock runs at a different rate (20× spread in 60s) | ☑ Closed — S2a. One shared virtual clock; per-zone lag is now a bounded offset. Before/after: `benchmarks/results/d8-simulator-event-clock.txt` vs `-after.txt`; rationale in `docs/adr/ADR-005-simulated-event-time.md`. |

---

## Session log

Append one entry per working session. Newest at the top. Keep to 2–4 lines.

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
