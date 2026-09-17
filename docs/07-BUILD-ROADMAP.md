# 07 — Build Roadmap: Session-by-Session Execution Manual

> **This is the operating manual for actually building Phase 1.**
> Each section below is one Claude Code session. Open a fresh session, paste the prompt, do the
> manual steps, verify, move on.

---

## 1. The orchestration model

**The documentation is the master. There is no long-running master session.**

A live "master session" that coordinates others is the wrong design: it dies when its context
window fills, and takes the plan with it. Files survive. `CLAUDE.md` is auto-loaded by Claude Code
into every session opened in this repo, so a fresh session bootstraps itself in ~3 tool calls.

```
        docs/  ── the persistent master (design, contracts, acceptance criteria)
          │
          ├──► Session 1  ── WP0 ──► commits ──► updates STATUS.md ──► dies
          ├──► Session 2  ── WP6a ─► commits ──► updates STATUS.md ──► dies
          ├──► Session 3  ── WP1 ──► commits ──► updates STATUS.md ──► dies
          └──►  ...
                              ▲
                              └── each one reads STATUS.md to learn what happened before it
```

`docs/STATUS.md` is the handoff channel between sessions. That is why rule 4 in `CLAUDE.md`
("update STATUS.md") matters — it is not bookkeeping, it is the mechanism that makes session
death harmless.

### Who does which thinking

| Thinking | Who | Where it lives |
|---|---|---|
| What to build, and why | **Already done** | `docs/00`–`06` |
| Contracts: interfaces, data shapes, file layout, acceptance criteria | **Already done** | `docs/01` §4, `docs/02` |
| How to implement it in TypeScript, edge cases, test cases | **The build session** | the code |
| Whether it actually works | **You**, via the manual verification steps below | your terminal |

The build session does implementation ideation because it has the real repo loaded file-by-file.
Pre-writing the code in a planning session would be writing blind — worse code, and it would burn
exactly the tokens this structure exists to save.

---

## 2. Session rules

**One work package per session.** Never two. The second one always gets worse code, because by
then the context is full of the first one.

**Start every session fresh** (new terminal / `/clear`). Do not continue a session across work
packages just because it is still alive.

**End a session when any of these is true:**
- The work package's acceptance criteria pass → commit, update `STATUS.md`, close.
- The session starts auto-compacting context → finish the file you are on, commit, close, resume
  with the "continue" prompt in §5.
- You have been going more than ~90 minutes → commit and close regardless. Quality degrades.

**Every session must end with a commit and a `STATUS.md` update.** If it does not, the next
session starts blind.

---

## 3. The session plan

14 sessions. At two sessions a day that is about a week; at one a day, under two weeks.

**S2a was inserted after S1's verification run found D8** — the simulator's event clock. Everything
from WP2 onward is measured against simulated data, so a broken clock silently invalidates all of it.

| # | Work package | What gets built | Est. | Manual work after |
|---|---|---|---|---|
| S1 | WP0 | Defect fixes D1/D2/D4/D5, topic bootstrap, zone registry | 60–90m | Start infra, verify partitions |
| S2a | D8 | Virtual event clock + redis password/port hardening | 50–75m | **Confirm transitions actually fire** |
| S2b | WP6a | `regional-anomaly` scenarios + ground-truth emission | 45–60m | Run simulator, inspect JSONL |
| S3 | WP1 | H3 neighbour graph + micro-benchmark + ADR-001 | 40–60m | Run bench, record numbers |
| S4 | WP2a | CorrelationWindow, TimeAwareConnectivity, naive oracle, differential fuzz | 75–100m | Run fuzz test |
| S5 | WP2b | IncidentLifecycle, merge/split, deterministic IDs, ADR-002/003 | 75–100m | Run property tests |
| S6 | WP3a | `correlation-engine` service, Kafka wiring, Redis state, metrics | 60–90m | Service starts clean |
| S7 | WP3b | stream-processor emits degradations, Postgres schema, full E2E | 60–90m | **Full stack E2E run** |
| S8 | WP6b-1 | Eval harness + scoring | 60–75m | **Run eval → first real numbers** |
| S9 | WP6b-2 | Benchmarks + parameter sweep | 60–75m | Run bench (slow), commit results |
| S10 | WP4 | Propagation vector + validation | 45–60m | Verify against ground truth |
| S11 | WP5-1 | Incident API endpoints | 45–60m | curl the endpoints |
| S12 | WP5-2 | Live map UI + SSE | 60–90m | **Record demo GIF** |
| S13 | WP7 | README, ADR-004, fill resume numbers | 45–60m | Update actual resume |

**Resume checkpoints:** after **S9** you have measured numbers for target bullets 1 and 3 — update
the resume that day, do not wait. After **S12** you have the demo and bullet 4. After **S13** the
entry is complete.

---

## 4. The prompts

Copy the whole block. Each assumes a fresh session in this repo (so `CLAUDE.md` is already loaded).

---

### S1 — WP0: foundation and defect cleanup

```
Read docs/STATUS.md, then docs/01-ARCHITECTURE.md section 3, then docs/02-PHASE-1-CORRELATION.md WP0.

Implement WP0 completely. All six items in the spec, all four acceptance criteria.

Priorities and gotchas:
- D1 is the important one. The exception from a failed Postgres insert is swallowed inside
  eachMessage, so the offset commits and the alert is gone. Fix by letting it propagate, with
  bounded retry + backoff, then a zone.degradations.dlq dead-letter topic after exhaustion.
  Write a test that proves the message survives a Postgres failure.
- D4: alertFlow.int.test.ts declares a stub AlertProcessor class inside the test file and tests
  that instead of the real one. Rewrite it to exercise the real implementation, or delete it and
  write a real one. Do not leave a test that tests nothing.
- The zone registry (item 5) is what WP1 depends on. Get the shape right:
  zones:registry SET + zone:<id> HASH extended with h3Cell and h3CoarseCell.
  h3-js is not installed yet; add it now and compute the cells here.

Commit incrementally as you go (one commit per defect fix is about right), no Claude co-author
trailers. Update docs/STATUS.md when done: WP0 status, D1/D2/D4/D5 marked closed.
```

**Manual afterwards** (actual commands, as built in S1):
```bash
cd infra && docker-compose up -d

# topics from the original build were auto-created with 1 partition, and createTopics
# will NOT resize an existing topic. Delete them first or the bootstrap silently no-ops.
docker exec geopulse-kafka kafka-topics --bootstrap-server localhost:9092 --delete --topic raw.zone.events
docker exec geopulse-kafka kafka-topics --bootstrap-server localhost:9092 --delete --topic zone.alerts

cd tools/kafka-bootstrap && npm install && npm run bootstrap
docker exec geopulse-kafka kafka-topics --bootstrap-server localhost:9092 --describe --topic raw.zone.events
# expect: PartitionCount: 12

cd services/alert-processor && GEOPULSE_INTEGRATION=1 npm test
```
Confirm 12 partitions, and that the integration suite goes green. Both are verification gates
(§8) — the next work package does not start until they pass.

---

### S2a — D8: the simulator event clock, plus infra hardening

> **Added after S1's verification run found D8.** WP6a cannot produce meaningful ground truth
> until event time is fixed, and WP2 cannot be built or measured at all. This session does only
> the clock and the infra guard — the scenarios follow in S2b.

```
Read docs/STATUS.md, then docs/01-ARCHITECTURE.md section 3.2 (D8), then
benchmarks/results/d8-simulator-event-clock.txt.

Fix D8. The event-time model is the design decision this session owns, so build it deliberately
rather than patching the arithmetic.

Required design — a virtual clock, decoupled from wall time:

- One VirtualClock shared by every zone. It starts at a fixed epoch (SIM_START_EPOCH_MS, a
  constant default so runs reproduce) and advances by SIM_STEP_MS per tick. Nothing in event
  generation reads Date.now() — CLAUDE.md rule 3.
- All zones read the SAME clock. This is the whole point: "these adjacent zones degraded within
  the same window" has to be expressible, and today it is not.
- Per-zone sensor lag stays, because out-of-order arrival across zones is realistic and the
  consumer should face it — but it must be a BOUNDED offset applied to the shared clock
  (eventTime = clock.now() - lagMs(zoneId), lag in roughly 0-20ms, derived deterministically
  from the zone id), never an accumulator. The current bug is that the offset accumulates and
  each zone accumulates at a different rate.
- Add SPEED_MULTIPLIER: simulated time per real second. This matters more than it looks. The
  state machine needs 60s of event time to confirm STRESSED, and the eval scenarios span
  minutes; at 1x every eval run costs its full simulated duration in wall clock. At 60x a
  60-second confirmation window elapses in one real second. Benchmarks and evals become
  practical instead of overnight jobs.
- producedAt should also come from the virtual clock so the whole record is deterministic. If
  real ingest lag is worth measuring later, that is a separate field stamped by the consumer,
  not this one.

Tests: event time advances at exactly SPEED_MULTIPLIER x real rate; all zones stay within the
lag bound of each other indefinitely (assert over a long simulated run, not 60s); the same seed
and speed produce byte-identical output; changing only SPEED_MULTIPLIER produces the same event
sequence with the same event timestamps.

Re-run benchmarks/simulator-event-clock.ts afterwards and commit the new output next to the old
one. The before/after is worth keeping — it is the evidence the bug was real.

Then, infra hardening (small, but it must land before any measured run):
- Another project's redis (creavo_redis) is bound to port 6380, which is GeoPulse's default. A
  GeoPulse service started while geopulse-redis is down currently connects to it silently and
  reads and writes another project's data.
- Remapping the port alone is not the fix - it just relocates the collision. Set a password on
  geopulse-redis via --requirepass, put it in the compose file and the env files, and have every
  service authenticate. A wrong connection then fails immediately instead of silently corrupting
  two projects at once.
- Also move the host ports off contended ones (redis 6380 -> 6390, postgres 5432 -> 5433) and log
  the resolved host:port at startup so the connection target is visible.

Commit incrementally. Update docs/STATUS.md: close D8, unblock WP2, note the new ports.
```

**Manual afterwards** — this is a verification gate:
```bash
cd infra && docker-compose up -d        # redis 6390 (password), postgres 5434
cd tools/kafka-bootstrap && npm run bootstrap

# run the pipeline and confirm it now actually transitions
cd services/stream-processor && npm run dev          # terminal 1
cd services/sensor-simulator && SCENARIO=spike SPEED_MULTIPLIER=60 npm run dev   # terminal 2
```
**You must see state transitions within a minute or two of wall clock.** S1's run produced zero
over 120 seconds — that is the symptom D8 caused, and it is the thing this session has to reverse.
If you still see none, stop and diagnose; do not proceed to S2b.

**Status: gate passed during S2a.** All ten zones reached `STRESSED` roughly 2.5 seconds after the
simulator started, within a 17 ms spread of event time; 19 alert rows reached Postgres through
password-authenticated Redis. `zone_alerts` was already empty, so no volume drop was needed.
Ports: Redis 6380 → **6390** with `--requirepass`, Postgres 5432 → **5434** (5433 is taken by
another project as well).

---

### S2b — WP6a: simulator ground truth

```
Read docs/STATUS.md, then docs/03-MEASUREMENT.md, then docs/02-PHASE-1-CORRELATION.md WP6a.

D8 is fixed and the virtual clock is in place; build on it rather than reintroducing wall-clock
reads. All ground-truth timestamps are virtual event time.

Implement WP6a: the anomaly injection scenarios and ground-truth emission in sensor-simulator.

All four scenarios from docs/03-MEASUREMENT.md section 2.1 are required — regional-anomaly,
propagating-anomaly, multi-anomaly, and noise. The last two exist to catch over-grouping and
hallucinated incidents; do not skip them because they seem less interesting.

Ground truth goes to evals/groundtruth/<run-id>.jsonl in exactly the schema in
docs/03-MEASUREMENT.md section 2, with the seed embedded in the run id.

Hard constraint from CLAUDE.md rule 3: everything stays deterministic. Seeded PRNG only, no
Math.random(), no Date.now() in generation logic. Same seed must produce a byte-identical run.
Write a test that asserts exactly that.

Commit incrementally. Update docs/STATUS.md.
```

**Manual afterwards:**
```bash
cd services/sensor-simulator
SCENARIO=regional-anomaly NUM_ZONES=200 npm run dev
# let it run ~2 min, Ctrl+C
cat ../../evals/groundtruth/*.jsonl | head -3
```
Check the JSONL has `affectedZones` with per-zone onset times. Run the same seed twice and
confirm the files are identical (`diff`).

---

### S3 — WP1: H3 spatial layer

```
Read docs/STATUS.md, then docs/02-PHASE-1-CORRELATION.md WP1.

Implement WP1: the NeighbourGraph over H3 cells, its tests, the micro-benchmark, and ADR-001.

Put it in a place both stream-processor and the future correlation-engine can use — either a
shared package or a module that gets copied; pick one, say why in the code, keep it consistent.

Tests must cover the antimeridian (lon near +/-180) and high latitudes, plus zones alone in a
cell and several zones in one cell.

The micro-benchmark compares neighboursOf against a naive haversine scan over all zones at
1k/10k/100k zones. Commit the raw output under benchmarks/results/. This benchmark is what
justifies the design choice, so it matters that it is real.

ADR-001 must record why H3 over geohash and over k-d tree/R-tree KNN, and specifically why
hexagons: all six neighbours equidistant, versus a square grid where diagonals are sqrt(2)
farther, which would make "adjacent" direction-dependent.

Commit incrementally. Update docs/STATUS.md and the ADR table.
```

**Manual afterwards:** run the benchmark, confirm the lookup curve is flat vs the naive linear
one, and copy the numbers into `docs/STATUS.md`'s measured-numbers table.

---

### S4 — WP2a: connectivity core

```
Read docs/STATUS.md, then docs/02-PHASE-1-CORRELATION.md WP2 (all of it), then
docs/01-ARCHITECTURE.md section 5.

Implement WP2 items 1 and 2 ONLY this session — CorrelationWindow and TimeAwareConnectivity,
plus the NaiveConnectivity oracle and the differential fuzz test. Stop before IncidentLifecycle;
that is the next session.

This is the algorithmic core of the whole project, so take it slowly and prioritise correctness
over cleverness.

- Union-find with path compression and union by rank on the hot path.
- Expiry via a compaction tick that rebuilds ONLY components that lost a member (local BFS over
  that component's survivors), not a global recompute.
- NaiveConnectivity does a full recompute every tick. It is not dead code — it is the test oracle.
- The differential fuzz test drives both with the same 10,000 randomised event sequences and
  asserts identical component partitions. Use fast-check if helpful.
- Event-time only. No Date.now() anywhere in this logic.

Commit incrementally — CorrelationWindow, then naive, then optimised, then the fuzz test.
Update docs/STATUS.md.
```

**Manual afterwards:** `npm test` — the differential fuzz must show zero divergence. If it finds
a divergence, that is the test doing its job; the next session fixes it before moving on.

---

### S5 — WP2b: incident lifecycle

```
Read docs/STATUS.md, then docs/02-PHASE-1-CORRELATION.md WP2 items 3, 4, 5.

Implement IncidentLifecycle: OPENED / GREW / MERGED / SHRANK / CLOSED, deterministic incident
IDs, split handling, property-based tests, and ADR-002 and ADR-003.

The two decisions that need to be exactly right, because they are the ones that get asked about
in interviews:
- MERGE: survivor is the earlier openedAt, ties broken lexicographically on incidentId. Emit
  MERGED on the survivor with mergedFrom, and a terminal event on each loser with supersededBy.
- SPLIT (bridging member expires): largest surviving fragment keeps the ID, other fragments open
  fresh incidents. Record the reasoning in ADR-003 — on-call continuity over set-theoretic purity.

incidentId must be a hash of (sorted seed member IDs + opening event time). Not a UUID, not a
counter — it has to be stable across replays.

Property tests: every active zone in exactly one component; two zones share a component iff a
path of active adjacent zones connects them; no OPEN incident below MIN_ZONES; replaying the same
sequence twice produces byte-identical output.

Commit incrementally. Update docs/STATUS.md and mark WP2 done.
```

---

### S6 — WP3a: correlation-engine service

```
Read docs/STATUS.md, then docs/02-PHASE-1-CORRELATION.md WP3, then docs/01-ARCHITECTURE.md
sections 4.2 and 6.

Build the services/correlation-engine service: items 1-5 and 7 of the WP3 spec. Leave item 6
(Postgres persistence) and item 8 (stream-processor changes) for the next session.

Follow the conventions of the existing services exactly — pino logger, prom-client metrics,
tsconfig, jest setup, package.json script names. Consistency matters here; an inconsistent new
service looks bolted on.

Use eachBatch, not eachMessage. The reason goes in the service README: a regional event produces
a burst of degradations, and batching means one consolidated incident update instead of one GREW
event per zone.

Wire in the WP1 NeighbourGraph and the WP2 correlation core rather than reimplementing anything.

Commit incrementally. Update docs/STATUS.md.
```

---

### S7 — WP3b: end-to-end integration

```
Read docs/STATUS.md, then docs/02-PHASE-1-CORRELATION.md WP3 items 6 and 8.

Finish the pipeline end to end:
- stream-processor emits ZoneDegradation to zone.degradations keyed by h3CoarseCell, including
  recovery transitions to NORMAL so the correlation window can release members early.
- Postgres migration for incidents, incident_members, incident_events with the indexes in the spec.
- Incident persistence (extend alert-processor or add incident-processor — pick one, justify it
  briefly in the commit message).
- Containerise all services and extend infra/docker-compose.yml so the whole stack comes up with
  one command, not just infra.

Carried over from WP0 (deliberately deferred to this session, do not skip):
- stream-processor/src/kafkaConsumer.ts still has the D1 bug — its eachMessage wraps everything
  in try/catch and logs, so a failed event is silently dropped and the offset commits. Reuse
  alert-processor's processWithRecovery rather than writing a second implementation; extract it
  to somewhere both services import. Decide and document whether a dropped sensor event deserves
  the same retry-then-DLQ treatment as a dropped alert, or a cheaper policy — they are not
  obviously the same stakes, and the reasoning belongs in ADR-000 as an amendment.
- The DLQ topic is named zone.degradations.dlq while alert-processor still consumes zone.alerts.
  That mismatch resolves itself once this session does the rename; make sure it actually lines up
  rather than leaving two differently-named topic families.

Then run the full stack against SCENARIO=regional-anomaly and confirm one injected regional
anomaly produces exactly one incident. Fix what that reveals.

Commit incrementally. Update docs/STATUS.md.
```

**Manual afterwards — this is the big moment:**
```bash
cd infra && docker-compose up -d --build
docker-compose logs -f correlation-engine
# in another terminal:
cd services/sensor-simulator && SCENARIO=regional-anomaly NUM_ZONES=500 npm run dev
```
You should see one incident OPEN and grow, not hundreds. Then:
```bash
docker exec geopulse-postgres psql -U geopulse -d geopulse -c "select incident_id, status, member_count from incidents;"
```

---

### S8 — WP6b-1: eval harness

```
Read docs/STATUS.md, then all of docs/03-MEASUREMENT.md, then docs/02-PHASE-1-CORRELATION.md WP6b.

Build evals/score.ts: consume the ground truth and the emitted incidents, produce every metric in
docs/03-MEASUREMENT.md section 3 — collapse ratio, membership precision/recall/F1 (greedy
one-to-one Jaccard matching), time-to-detect p50/p95, fragmentation index, false-incident rate.
Propagation error can be stubbed until WP4 lands.

One command to run: npm run eval. Writes timestamped raw results to evals/results/ including the
seed and full config. Those files are the provenance for every number that reaches the resume,
so they must be complete.

Run it against all four scenarios and commit the raw results.

Commit incrementally. Update docs/STATUS.md — and fill in the measured-numbers table with whatever
it actually produced, good or bad.
```

**Manual afterwards:** `npm run eval`. **These are your first real numbers.** If the false-incident
rate on `noise` is bad or fragmentation is high, that is data — record it, then tune in S9. Do not
hide it.

---

### S9 — WP6b-2: benchmarks and tuning

```
Read docs/STATUS.md, then docs/03-MEASUREMENT.md sections 3.7 and 4.

Build benchmarks/throughput.ts per the protocol in section 4 — 60s warmup discarded, steady state
only (consumer lag must be flat or the number is invalid), p50/p95/p99 not means, fixed seed,
environment recorded, raw output committed.

Measure at 1k / 10k / 50k zones: sustained throughput, correlation latency, compaction duration p99.

Also measure the baseline: per-message, single partition, no batching, on the same hardware on the
same day. A speedup claim is only meaningful against a baseline actually measured.

Then run the parameter sweep over CORRELATION_WINDOW_MS, H3_RESOLUTION and NEIGHBOUR_RING_SIZE
across all four eval scenarios, and produce the tuning curve. Pick the operating point off that
curve and record why in docs/STATUS.md.

Commit raw results. Update docs/STATUS.md measured-numbers table.
```

**Manual afterwards:** benchmarks take real wall-clock time — start them and go do something else.
Then **update your resume** using `docs/05-RESUME.md` §3 with the real numbers.

---

### S10 — WP4: propagation vector

```
Read docs/STATUS.md, then docs/02-PHASE-1-CORRELATION.md WP4.

Implement the propagation vector: weighted least squares of lat-vs-time and lon-vs-time over
member join times, converted to bearing and speed, with the cos(latitude) correction on longitude.

Emit propagation: null rather than a garbage vector when rSquared is low or there are fewer than
3 members with distinct join times. Refusing to report an untrustworthy number is deliberate and
should be visible in the output.

Guard the degenerate cases: all members joined simultaneously, collinear in time, single cell.

Then wire it into evals/score.ts and validate against the propagating-anomaly ground truth —
report bearing error, speed error, AND what fraction of propagating anomalies produced a usable
vector at all.

Commit incrementally. Update docs/STATUS.md.
```

---

### S11 — WP5-1: incident API

```
Read docs/STATUS.md, then docs/02-PHASE-1-CORRELATION.md WP5 item 1.

Implement the six incident endpoints. Follow the existing routes' conventions in services/api/src/routes/.

GET /stats/collapse is the important one — it computes the headline collapse metric live, and its
output must agree with what evals/score.ts computes. Add a test asserting they agree.

Commit incrementally. Update docs/STATUS.md.
```

---

### S12 — WP5-2: live map UI

```
Read docs/STATUS.md, then docs/02-PHASE-1-CORRELATION.md WP5 items 2 and 3.

Build the live map: single static page, MapLibre GL or Leaflet, served by the api service.
H3 cells as hex polygons coloured by zone state, incidents as a hull over member cells with an
arrow for the propagation vector, and a live counter showing degradations vs incidents with the
collapse percentage.

Stream updates over SSE from the api service fed by the zone.incidents topic.

This is the artefact that sells the project, so make it legible at a glance rather than dense.

Commit incrementally. Update docs/STATUS.md.
```

**Manual afterwards:** run a `propagating-anomaly` scenario and **record a GIF** of the incident
spreading. That GIF goes at the top of the README.

---

### S13 — WP7: documentation and resume

```
Read docs/STATUS.md, then docs/02-PHASE-1-CORRELATION.md WP7, then docs/05-RESUME.md.

Rewrite the root README.md around the new thesis: problem, insight, architecture diagram, results
table, demo GIF, how to run, limitations. Lead with the results table — real numbers from
evals/results/ and benchmarks/results/ only, no estimates.

Write ADR-004 (partitioning on coarse H3 cells) and verify ADR-001 through 003 are complete and
honest about rejected alternatives.

Add a LIMITATIONS section stating plainly what is not built — crash-safety, cross-partition merge,
learned thresholds — and the fix for each, referencing docs/06-FUTURE-PHASES.md.

Then fill docs/05-RESUME.md section 3 with the measured numbers, replacing every TBD. If a number
was never measured, leave TBD and say so — do not estimate.

Commit incrementally. Mark Phase 1 complete in docs/STATUS.md.
```

---

## 5. Recovery prompts

**Continuing a work package that ran out of session:**
```
Read docs/STATUS.md and git log --oneline -15 to see where the last session stopped.
Continue work package WP<N> from docs/02-PHASE-1-CORRELATION.md. Do not restart finished parts.
Commit incrementally. Update docs/STATUS.md when done.
```

**A session made a mess:**
```
Read docs/STATUS.md. git log --oneline -10 and git status.
The last session left WP<N> in a broken state: <describe the symptom>.
Diagnose before changing anything, tell me what went wrong, then fix it. Do not rewrite working
code that is unrelated to the failure.
```

**Checking in without building anything:**
```
Read docs/STATUS.md. Summarise what is done, what is next, and anything the last session flagged
as a problem. Do not write any code.
```

---

## 6. Manual work summary

Everything here is yours, not an agent's:

| When | What |
|---|---|
| Once, before S1 | `cd infra && docker-compose up -d`, confirm Kafka/Redis/Postgres are healthy |
| After every session | Read the diff (skim is fine for now), `npm test`, confirm the commits look right |
| After S1 | Verify topics have 12 partitions |
| After S2 | Inspect the ground-truth JSONL; run the same seed twice and `diff` |
| After S7 | **Full E2E run** — the first time you see one incident instead of hundreds |
| After S8 | **Run the eval — first real numbers** |
| After S9 | Run benchmarks (slow); **update the resume** |
| After S12 | **Record the demo GIF** |
| After S13 | Final resume entry, push to GitHub |

---

## 7. If you only remember four things

1. **One work package per session.** Fresh session each time.
2. **Every session ends with commits and a `STATUS.md` update.** That is what makes session death
   harmless.
3. **Update the resume at S9**, not at the end. Two measured bullets beat four imagined ones.
4. **A bad measured number is worth more than a good invented one.** If the eval comes back ugly,
   that is the project working — record it, diagnose it, fix it, and you have an interview story
   nobody else has.

---

## 8. Verification gates

Some sessions produce work that cannot be verified inside the session — typically because the
infrastructure was not running. That work is **not done**; it is *written*. The distinction
matters, because an unverified fix that silently does not work will be discovered at the worst
possible moment, during an end-to-end debug session where three layers are suspect at once.

**Rule: when a session ends owing verification, run it before starting the next session.**

Each such debt is recorded in `STATUS.md` under a "verification owed" heading with the exact
commands. If verification fails, do not carry on to the next work package — open a session with
the repair prompt in §5 instead.

| Gate | After | Why it cannot wait |
|---|---|---|
| Topic partition counts | S1 | Every scaling claim and every throughput benchmark rests on real partitions. Pre-existing topics auto-created with 1 partition are *not* resized by `createTopics` — they must be deleted first. |
| Integration suite green | S1 | The D1 retry/DLQ path is only covered by the gated integration test; unit coverage of the wiring is 0%. Until it runs, "alerts are never silently lost" is a claim about code that has never executed. |
| Pipeline actually transitions | S2a | S1's 120-second run produced **zero** state transitions with avg5m ≈ 0.9 against a 0.75 threshold. If the fixed clock does not reverse that, the correlation engine would be built against a simulator that can never express simultaneity. |
| One incident, not hundreds | S7 | The entire thesis. If this is wrong, everything measured afterwards is measuring the wrong thing. |
| Eval agrees with the live API | S11 | Two implementations of the headline metric that disagree means one is wrong, and it must not be the one on the resume. |
