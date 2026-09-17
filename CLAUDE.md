# GeoPulse — Agent Entry Point

**If you are a Claude session or agent picking up this project, read this file first, then `docs/STATUS.md` to find out where we are.**

---

## One-line summary

GeoPulse is being repositioned from a generic "Kafka monitoring pipeline" into a
**spatiotemporal event-correlation engine**: a system that collapses storms of individual
zone alerts into a small number of geographically-coherent *incidents*.

The thesis, in one sentence:

> **A single sensor going critical is noise. The signal is the geometry.**

## Why this repositioning exists

This repo was built in Feb 2026 as a student project. It works, but the idea
("detect when a metric crosses a threshold, alert on it") is a commodity resume project
and the geospatial dimension was decorative — lat/lon was stored but never used in any
detection logic.

The owner is a 4th-year student targeting **backend / distributed-systems roles**. The goal
is a project that (a) makes an interviewer say "I haven't seen that before", and (b) holds up
under deep technical questioning. See `docs/00-VISION.md` for the full reasoning.

## Document map

| Doc | What it is | Read it when |
|---|---|---|
| `docs/STATUS.md` | **Living progress tracker.** Current phase, what's done, what's next. | **Always, first.** |
| `docs/00-VISION.md` | The idea, the problem domain, why it matters, what success looks like. | Starting fresh / need the "why". |
| `docs/01-ARCHITECTURE.md` | As-built audit (incl. known bugs) + target architecture. | Before touching any service. |
| `docs/02-PHASE-1-CORRELATION.md` | **The executable build plan.** Work packages WP0–WP7 with acceptance criteria. | Implementing anything. |
| `docs/03-MEASUREMENT.md` | Ground-truth generation, metrics definitions, benchmark methodology. | Any time a number is claimed. |
| `docs/04-INTERVIEW-GUIDE.md` | The story to tell + the questions that will be asked + the answers. | After each work package. |
| `docs/05-RESUME.md` | Bullet drafts, interim + target. Rules about honesty of numbers. | When updating the resume. |
| `docs/06-FUTURE-PHASES.md` | Phases 2–5 specified but deferred. | Phase 1 is done. |
| `docs/07-BUILD-ROADMAP.md` | **Session-by-session execution manual** — the 13 build sessions, their prompts, and the owner's manual verification steps. | Owner planning what to run next. |

## Hard rules for agents working on this repo

1. **Never invent a metric.** Every number that could reach the resume must be produced by a
   committed, re-runnable script under `benchmarks/` or `evals/`, with its raw output committed.
   If a number is not yet measured, write `TBD` — never a plausible-looking placeholder.
2. **Explain, don't just implement.** The owner must be able to defend every design decision in
   an interview. When you implement a non-obvious algorithm, add an entry to `docs/adr/` (one
   short Architecture Decision Record: what we chose, what we rejected, why). This is not
   bureaucracy — it is the interview prep.
3. **Determinism is a feature.** The simulator is deterministic and this is load-bearing for
   measurement and replay. Never introduce `Math.random()` or wall-clock reads into the
   simulator or correlation hot paths. Use seeded PRNGs and event-time.
4. **Update `docs/STATUS.md`** at the end of any session where work-package state changed.
5. **Don't bolt on technology for resume garnish.** Every dependency must earn its place with a
   stated reason. The previous version of this project added Prometheus partly to look impressive;
   we are not repeating that pattern.
6. **Prefer the honest fix over the impressive-sounding one.** Known bugs are listed in
   `docs/01-ARCHITECTURE.md` §3 — these are real and must be fixed before measurements are trusted.

## Git rules (non-negotiable)

7. **Commit incrementally, throughout the work — never only at the end.** Commit after each
   logically complete unit: a module plus its tests, a bug fix, a migration, a doc update. A
   session should typically produce 3–8 commits, not one. If a session dies mid-way, everything
   before the last commit must still be safe.
8. **Commits must be authored by the repo owner, with no Claude attribution.**
   - Identity is already configured: `Dhruv Ranjan <irldhruv196@gmail.com>` →
     `github.com/dhruv-ship-it/geopulse`. Do not change it, do not pass `--author`.
   - **Never append `Co-Authored-By: Claude ...`** to a commit message. Never add "Generated with
     Claude Code" to a PR body. This deliberately overrides the default harness behaviour — this
     is a portfolio repo that interviewers read, and the commit history is part of the artefact.
   - Write messages in the owner's voice: imperative mood, what changed and why.
     Good: `fix: propagate postgres insert failure so kafka retries instead of committing offset`
     Bad: `Update alertProcessor.ts`
9. **Do not push unless explicitly asked.** Commit freely; pushing is the owner's call.
10. **Never commit secrets.** `services/*/.env` files exist and are gitignored — keep it that way.

## Tech stack

TypeScript (Node 18+), Kafka (kafkajs), Redis, PostgreSQL, Docker Compose, Jest, Prometheus.
Phase 1 adds **H3** (`h3-js`) for hex-grid spatial indexing.

## Repo layout

```
infra/                       docker-compose (kafka, zookeeper, redis, postgres)
tools/
  kafka-bootstrap/           explicit topic creation (partition counts, DLQ retention)
services/
  sensor-simulator/          synthetic event generation -> Kafka
  stream-processor/          per-zone windows + state machine -> Redis, Kafka
  alert-processor/           alert persistence (Redis + Postgres) + DLQ
  api/                       Express read API
  correlation-engine/        [PHASE 1 - NEW] spatial correlation -> incidents
docs/                        this documentation set
docs/adr/                    architecture decision records
benchmarks/                  committed benchmark scripts + raw results
evals/                       [PHASE 1 - NEW] ground-truth eval harness + results
```

## Commands

```bash
cd infra && docker-compose up -d                        # start kafka/redis/postgres
cd tools/kafka-bootstrap && npm install && npm run bootstrap   # create topics (run once, after compose)
cd services/<svc> && npm install && npm run dev
cd services/<svc> && npm test                           # jest; all four services have tests
cd services/alert-processor && GEOPULSE_INTEGRATION=1 npm test  # end-to-end, needs the stack up
./benchmarks/run-coverage.sh                            # coverage across every service
```

Topics are no longer auto-created. If `npm run bootstrap` has not been run against a fresh
broker, services fail to start — deliberately.
