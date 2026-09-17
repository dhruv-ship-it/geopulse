# 05 — Resume Bullets

> **Rule: no number appears here until a committed script under `evals/` or `benchmarks/`
> produced it.** Placeholders are written `TBD`, never as a plausible-looking fake. A fabricated
> metric that collapses under one question costs more than the bullet ever gained.

---

## 1. What is wrong with the current entry

```
GeoPulse | TypeScript, Kafka, Redis, PostgreSQL, Docker, Prometheus
• Built an event-driven geospatial monitoring pipeline on Kafka with sliding-window
  aggregation and state-machine alert transitions for real-time anomaly detection
• Designed an alert persistence layer for low-latency state reads and durable history,
  exposed through time-range and aggregation REST APIs
• Instrumented the pipeline with structured logging and Prometheus metrics; held 90%+
  unit test coverage on core stream-processing logic
```

Specific problems:

| Problem | Detail |
|---|---|
| **All description, no outcome** | Built / Designed / Instrumented. Three bullets, three verbs, zero results. A screener learns what you touched but nothing about what happened. |
| **Generic idea** | "Event-driven monitoring pipeline on Kafka" is one of the most common resume projects in existence. Nothing here distinguishes it from a tutorial. |
| **The only number is a weak one** | Test coverage is low-signal to screeners and can read as filler. Worse, it is scoped to two files, and the alert-processor integration test tests a stub class — so it does not survive a follow-up question. |
| **"Geospatial" is unearned** | Nothing in the detection logic uses location. An interviewer who asks "what's geospatial about it?" gets a weak answer. |
| **Persistence bullet is table stakes** | "Wrote to Redis and Postgres and exposed REST endpoints" is expected of any backend intern, not a differentiator. |

---

## 2. Interim version — use this NOW, before any new work lands

Honest, no fabrication, just accurate framing of what already exists. This is strictly better than
the current entry and costs nothing to deploy today.

```
GeoPulse | TypeScript, Kafka, Redis, PostgreSQL, Docker, Prometheus
• Built a 4-service event-streaming pipeline processing synthetic geo-sensor telemetry through
  Kafka, with per-zone sliding-window aggregation over event-time and a hysteresis-based state
  machine that suppresses alert flapping via asymmetric thresholds and confirmation delays
• Partitioned by zone key for horizontal consumer scaling; materialised live state in Redis
  (hash + GEO index) for O(1) reads while dual-writing to PostgreSQL for durable alert history
• Instrumented end-to-end with Prometheus metrics and structured JSON logging; property-tested
  the window and state-transition logic with Jest
```

What changed and why it is defensible:

- **"hysteresis-based ... suppresses alert flapping via asymmetric thresholds and confirmation
  delays"** — this is the genuinely clever part of your existing code and it was completely
  invisible in the old bullets. It is specific, it is true, and it invites a good question.
- **Coverage claim removed.** It is the weakest number you have and the most likely to be probed.
  Removing a fragile claim is a net gain.
- **"property-tested"** — only keep this word once WP2's property tests actually exist. Until then
  write "unit-tested".
- Still honest about scale: no throughput number, because you have not measured one.

---

## 3. Target version — after Phase 1 (fill numbers from `evals/` + `benchmarks/`)

```
GeoPulse — Spatiotemporal Incident Correlation Engine
TypeScript, Kafka, Redis, PostgreSQL, H3, Docker, Prometheus

• Built a streaming correlation engine that collapses geographically-clustered sensor alerts into
  single incidents using connected-components over an H3 hex-adjacency graph with time-expiring
  membership — reduced [TBD] raw alerts to [TBD] incidents ([TBD]% fewer pages) on a [TBD]-zone
  replay, at [TBD] membership precision against injected ground truth

• Solved connectivity-under-expiry (union-find supports merge but not delete) with incremental
  unions plus component-local rebuilds on expiry; verified against a naive full-recompute oracle
  by differential fuzzing over 10K randomised event sequences with zero divergence

• Repartitioned the alert stream from zone-hash onto coarse H3 cells so spatially-adjacent zones
  co-locate on a partition, making correlation node-local; sustained [TBD] events/sec with [TBD]ms
  p99 correlation latency at [TBD] zones

• Derived incident propagation vectors (bearing + speed) by regressing member join-times against
  position, recovering injected fault trajectories within [TBD]° — surfacing movement that is
  invisible at the individual-sensor level
```

### Why each bullet is built the way it is

**Bullet 1 — the hook.** Leads with the novel mechanism, lands a concrete before/after, and closes
with an accuracy figure that proves it is not just aggressive grouping. The absolute numbers
(`12,400 → 740`) matter more than the percentage; percentages alone read as inflated.

**Bullet 2 — the depth signal.** Names a specific hard problem in a form a systems engineer
immediately recognises as real ("union-find has no delete" is an instantly legible difficulty).
"Differential fuzzing against an oracle" signals testing maturity well beyond typical student work.
This is the bullet that gets you asked a *good* question rather than a generic one.

**Bullet 3 — the distributed-systems bullet.** Repartitioning for spatial locality is a real design
decision with a real trade-off, and it is exactly what a backend/infra interviewer wants to dig
into. Throughput and p99 give the screener scannable numbers.

**Bullet 4 — the memorable one.** Bearing and speed of a moving fault is vivid and easy to picture.
"Invisible at the individual-sensor level" states the emergent-property insight in seven words.

### Bullet-writing rules used here

1. **Mechanism + outcome in the same bullet.** "Did X using Y, achieving Z." Mechanism alone is a
   job description; outcome alone is unverifiable.
2. **Absolute numbers beside percentages.** `12.4K → 740 (94%)` reads as measured;
   `94% reduction` alone reads as invented.
3. **Name the hard part explicitly.** Most candidates hide difficulty. Naming it ("union-find
   supports merge but not delete") signals you understand your own work.
4. **Front-load the distinctive noun.** "Spatiotemporal correlation engine", "H3 hex-adjacency
   graph", "differential fuzzing" — a screener skimming for 6 seconds should hit something
   unfamiliar and stop.
5. **One bullet per skill dimension.** Algorithms (1, 2) / distributed systems (3) / testing
   rigour (2) / analytical depth (4). Four bullets, four different competencies demonstrated.
6. **Never two bullets making the same point.** The old entry's bullets 2 and 3 were both "I
   wired up infrastructure."

---

## 4. Project title options

| Title | Notes |
|---|---|
| `GeoPulse — Spatiotemporal Incident Correlation Engine` | **Recommended.** Keeps the name, and the subtitle does the work. "Correlation engine" reads as a system, not a CRUD app. |
| `GeoPulse — Turning Alert Storms into Incidents` | Punchier, more product-flavoured. Good if the rest of the resume is dry. |
| `GeoPulse — Geospatial Alert Correlation for Distributed Sensor Networks` | Most conservative; fine for formal/enterprise submissions. |

Avoid "monitoring platform" and "pipeline" in the title — they are the words every generic project
uses, and they actively hide what is distinctive here.

---

## 5. One-line version (LinkedIn headline / GitHub description / elevator)

> Collapses storms of geo-distributed sensor alerts into single incidents via streaming
> connected-components over an H3 hex grid — 200 pages become 1, and the incident knows which
> way the fault is moving.

---

## 6. Update schedule

| When | Action |
|---|---|
| **Today** | Deploy the §2 interim version. Zero risk, immediate improvement. |
| After WP6b (~day 11) | Real numbers exist → deploy target bullets 1 and 3. |
| After WP4/WP5 (~day 13) | Add bullet 4 (propagation). |
| After WP7 (~day 14) | Full entry, README with results table and demo GIF, repo link live. |

Do not wait for everything to be finished before updating. Each measured milestone is worth
deploying on its own.
