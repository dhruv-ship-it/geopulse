# STATUS — Living Progress Tracker

> **Agents: read this first, and update it at the end of any session that changed work-package
> state.** Keep it terse and factual. This file is the handoff between sessions.

---

## Current position

| Field | Value |
|---|---|
| **Phase** | Phase 1 — Spatiotemporal Incident Correlation |
| **Active work package** | WP0 — ☑ done, all four acceptance criteria verified against the live stack |
| **Last updated** | 2026-09-17 |
| **Last commit at time of writing** | `1d83864` |
| **Blocked on** | Nothing for WP1. **WP2 is blocked by D8** (simulator event clock) — see below. |

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
| WP2 | Correlation core (time-aware connectivity) | ☐ Not started | **The deep one.** Budget the most time here. **Blocked by D8** — fix the simulator event clock (WP6a) first. |
| WP3 | `correlation-engine` service | ☐ Not started | |
| WP4 | Propagation vector | ☐ Not started | |
| WP5 | API + live map UI | ☐ Not started | |
| WP6a | Simulator ground truth | ☐ Not started | Can run in parallel with WP1. **Now carries D8** — pull it forward to before WP2. |
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

---

## Measured numbers

**Empty until measured. Do not fill from estimates.** Every row must cite a committed file.

| Metric | Value | Scenario / config | Source file | Date |
|---|---|---|---|---|
| Test coverage, sensor-simulator | 36.70% stmts | whole src tree, `npx jest --coverage` | `benchmarks/results/wp0-coverage.txt` | 2026-09-17 |
| Test coverage, stream-processor | 38.39% stmts | whole src tree | `benchmarks/results/wp0-coverage.txt` | 2026-09-17 |
| Test coverage, alert-processor | 47.08% stmts | whole src tree, integration suite skipped | `benchmarks/results/wp0-coverage.txt` | 2026-09-17 |
| Test coverage, api | 19.17% stmts | whole src tree | `benchmarks/results/wp0-coverage.txt` | 2026-09-17 |

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
| D8 | Simulator event clock runs at 0.5–10% of real time and each zone's clock runs at a different rate (20× spread in 60s) | ⛔ **Open — blocks WP2.** New, found in live verification. Evidence: `benchmarks/results/d8-simulator-event-clock.txt`, analysis in `01-ARCHITECTURE.md` §3.2. Fix belongs to WP6a. |

---

## Session log

Append one entry per working session. Newest at the top. Keep to 2–4 lines.

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
(Redis 6381, Postgres 5434). `infra/docker-compose.yml` is unchanged and still asks for
5432/6380, so a plain `docker-compose up -d` will fail on those two services until the conflict
is resolved. **`creavo_redis` on 6380 is a live hazard**: it occupies the exact port GeoPulse
defaults to, so a service started while it is up and `geopulse-redis` is down will silently read
and write another project's Redis.

Also note `infra_postgres_data` still holds 21 `zone_alerts` rows from February 2026. Drop the
volume before any measured run.

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
