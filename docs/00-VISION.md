# 00 — Vision: What We Are Building and Why

> Read this if you need the *why*. For the *how*, go to `02-PHASE-1-CORRELATION.md`.

---

## 1. The problem we are solving

### 1.1 The real-world problem (this is not invented for a resume)

Every large monitored system — a telecom network, a power grid, a fleet of delivery vehicles,
a CDN's edge nodes, a chain of warehouses, an IoT sensor deployment — has the same failure mode
in its alerting layer:

**One root cause produces hundreds of alerts.**

A fibre cut degrades every cell tower downstream of it. A storm front degrades every sensor it
passes over. A regional power dip degrades every node in that region. The monitoring system,
which evaluates each node independently, dutifully fires one alert per node.

The on-call engineer's phone buzzes 200 times in 90 seconds.

This is called **alert fatigue**, and its consequences are well documented in SRE practice:
engineers mute channels, real incidents get lost in noise, and mean-time-to-resolution goes up
precisely when it most needs to go down. The industry response is a product category usually
called **event correlation** or **AIOps** — PagerDuty's Intelligent Alert Grouping, BigPanda,
Moogsoft, Datadog Watchdog, Splunk ITSI. These are real products that real companies pay real
money for.

### 1.2 What almost every such system gets wrong

Most correlation products group alerts by *metadata*: same service tag, same host, same
deployment, textual similarity of alert titles. That works for software topology.

It does **not** work for physically-distributed infrastructure, where the thing that actually
correlates failures is **space**. Two cell towers on the same fibre run are not tagged as
related — they are related because they are 3 km apart and the fault is between them.

### 1.3 Our angle

> **A single sensor going critical is noise. The signal is the geometry.**

GeoPulse correlates alerts **spatially and temporally**. If one zone degrades, that's a blip —
maybe a flaky sensor, maybe local load. If six *adjacent* zones degrade inside a two-minute
window, that is not six problems. That is one incident with a geographic footprint, and quite
possibly a direction of travel.

So instead of emitting alerts, we emit **incidents**:

```
BEFORE (what the project does today)
  [ALERT] Z-0147 NORMAL -> CRITICAL
  [ALERT] Z-0148 NORMAL -> CRITICAL
  [ALERT] Z-0151 NORMAL -> STRESSED
  [ALERT] Z-0152 NORMAL -> CRITICAL
  ... x 194 more ...

AFTER (what we are building)
  [INCIDENT INC-8f2a] OPEN  severity=CRITICAL  zones=198
      footprint : 47 H3 cells, centroid 52.31N 13.04E, radius ~84 km
      opened    : 14:22:07 (11.4s after first zone degraded)
      spreading : bearing 041 deg (NE) at ~38 km/h
      timeline  : 6 zones -> 41 zones -> 198 zones over 3m12s
```

One page instead of 198. And the page contains information *no individual alert could
possibly have contained*: the shape, the size, and the movement of the problem.

That last point is the heart of the project. **The correlated view is not just less noisy —
it is strictly more informative.** Propagation direction is an emergent property that literally
does not exist at the level of a single sensor. That is the intellectually interesting claim,
and it is the thing to lead with in an interview.

---

## 2. Why this is a good project for a backend / distributed-systems candidate

Three reasons, in order of importance:

**It is immediately understandable but not obvious.** An interviewer grasps "200 pages for one
outage is bad" in two seconds — no domain setup needed. But "use the hex-grid adjacency graph
and streaming connected-components to collapse them" is not something they have seen on a
student resume. That gap between *instantly understandable problem* and *non-obvious solution*
is exactly where good project conversations happen.

**The hard parts are genuinely hard, and they are distributed-systems hard.** Not "I wired four
services together" hard. Specifically:

- *Connectivity under expiry.* Union-find is the textbook tool for connected components, but it
  has no delete operation — and our members expire out of a sliding time window. Resolving that
  is a real algorithmic design decision with several defensible answers. (See ADR-002.)
- *Correlation resists partitioning.* The existing pipeline partitions by `zoneId`, which is
  correct and scales linearly. But correlation needs to see *neighbouring* zones together, and
  neighbours-by-geography are not neighbours-by-hash. Redesigning the partitioning key around
  spatial locality — and handling incidents that straddle a partition boundary — is a
  genuinely interesting distributed systems problem. (See ADR-004 and §6 of the architecture doc.)
- *Identity under merge.* Two separate incidents can become one when a bridging zone degrades.
  We have already told downstream consumers about both IDs. What is the contract? This is the
  same class of problem as stream-stream joins and CRDT merge semantics.

**It produces real, defensible numbers.** Because the simulator is deterministic and we control
what anomalies get injected, we have **ground truth** — we know exactly which zones *should*
have been grouped. That converts hand-wavy claims into measured precision, recall, and
collapse ratio. See `03-MEASUREMENT.md`. Most student projects cannot do this; almost all
resume metrics in this space are fabricated, and interviewers know it.

---

## 3. What "done" looks like for Phase 1

Phase 1 is complete when all of the following are true:

1. A new `correlation-engine` service consumes zone degradation events and emits incidents to a
   `zone.incidents` Kafka topic, with a full OPEN / GROW / MERGE / SHRINK / CLOSE lifecycle.
2. The simulator can inject a **regional anomaly** of known extent, shape, and propagation
   velocity, and writes the ground truth to a side channel for scoring.
3. An eval harness in `evals/` scores the engine against that ground truth and outputs
   collapse ratio, membership precision/recall, time-to-detect, and propagation-vector error.
4. A benchmark in `benchmarks/` reports sustained throughput and p99 correlation latency.
5. A live map UI shows H3 hexes lighting up and incidents growing across the map in real time.
6. Every design decision with a real alternative has an ADR in `docs/adr/`.
7. The owner can answer every question in `04-INTERVIEW-GUIDE.md` §3 without notes.

Point 7 is not optional decoration. A project you cannot defend is worse than no project,
because it reads as inflated and casts doubt on the rest of the resume.

---

## 4. Explicit non-goals for Phase 1

Stating these matters — an interviewer respects "I scoped that out deliberately, here's what I'd
do" far more than an unconvincing attempt at everything.

- **Not building crash-safe state.** The correlation engine holds state in memory and will lose
  it on restart. This is a known, accepted limitation for Phase 1, specified as Phase 3 in
  `06-FUTURE-PHASES.md`. Know the answer to "what happens when it crashes" (see interview guide
  Q7) even though we haven't built the fix.
- **Not learning thresholds.** Zone-level degradation still uses the existing static-threshold
  state machine. Adaptive baselines are Phase 2.
- **Not multi-broker / production Kafka.** Still single-broker Zookeeper-mode Kafka locally.
  Know that KRaft is the modern answer and that Zookeeper was removed in Kafka 4.0.
- **Not real geospatial data.** Zones are synthetic. This is a genuine strength for measurement
  (ground truth) and should be presented that way, not apologised for.

---

## 5. The narrative arc (for interviews and for the README)

This is the story, in the order it should be told:

1. *"I built a monitoring pipeline — Kafka, sliding windows, a state machine with hysteresis so
   a flapping metric wouldn't spam alerts."*
2. *"Then I ran it at scale with a regional fault injected, and got 200 alerts in 90 seconds for
   what was obviously one event. The hysteresis had solved flapping in the **time** dimension and
   done nothing at all in the **space** dimension."*
3. *"So I asked: what actually relates these alerts? Not tags, not service names — physical
   adjacency. Which turns the problem into streaming connected-components over a spatial graph."*
4. *"Here's how I built it, and here's where it got hard: union-find has no delete, and my
   members expire."*
5. *"And here's the payoff — 198 alerts became 1 incident, and the incident knows which way the
   fault is moving, which no individual alert could ever have told you."*

Step 2 is the most important sentence in the whole story. It shows you *found* the problem by
running your own system and looking at the output honestly — which is exactly what engineers do
and what most candidates cannot demonstrate.
