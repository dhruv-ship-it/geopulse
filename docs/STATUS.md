# STATUS — Living Progress Tracker

> **Agents: read this first, and update it at the end of any session that changed work-package
> state.** Keep it terse and factual. This file is the handoff between sessions.

---

## Current position

| Field | Value |
|---|---|
| **Phase** | Phase 1 — Spatiotemporal Incident Correlation |
| **Active work package** | WP0 — code complete, one acceptance criterion unverified (see below) |
| **Last updated** | 2026-09-17 |
| **Last commit at time of writing** | `7fa7e0a` |
| **Blocked on** | Nothing. Owner needs to run the Docker verification in "WP0 verification owed". |

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
| WP0 | Foundation & defect cleanup | ◐ Code complete | D1, D2, D4, D5 closed, plus D7 (new, found in passing). D3 deferred as planned. 3 of 4 acceptance criteria verified; the partition-count check needs Docker running. |
| WP1 | Spatial layer (H3 neighbour graph) | ☐ Not started | |
| WP2 | Correlation core (time-aware connectivity) | ☐ Not started | **The deep one.** Budget the most time here. |
| WP3 | `correlation-engine` service | ☐ Not started | |
| WP4 | Propagation vector | ☐ Not started | |
| WP5 | API + live map UI | ☐ Not started | |
| WP6a | Simulator ground truth | ☐ Not started | Can run in parallel with WP1/WP2. |
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
- **Next:** WP1 (spatial layer). The registry shape it depends on is live. Before that, the
  owner should run the Docker verification below and the WP0 understanding checkpoint.

#### WP0 verification owed (could not be run in the build session — Docker was not running)

```bash
cd infra && docker-compose up -d
# topics from a previous run were auto-created with 1 partition; delete them first
docker exec geopulse-kafka kafka-topics --bootstrap-server localhost:9092 --delete --topic raw.zone.events
docker exec geopulse-kafka kafka-topics --bootstrap-server localhost:9092 --delete --topic zone.alerts
cd tools/kafka-bootstrap && npm install && npm run bootstrap
docker exec geopulse-kafka kafka-topics --bootstrap-server localhost:9092 --describe --topic raw.zone.events
# expect: PartitionCount: 12

cd services/alert-processor && GEOPULSE_INTEGRATION=1 npm test   # end-to-end suite
```

Everything else in the WP0 acceptance list was verified in-session: the Postgres-failure test
passes, `grep -rn "\.keys(" services/*/src` is clean of Redis KEYS, and `npm test` passes in
all four services.

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
