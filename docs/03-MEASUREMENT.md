# 03 — Measurement: Ground Truth, Metrics, and Benchmarks

> Every number that reaches the resume is produced here. If a number is not produced by a
> committed, re-runnable script with committed raw output, it does not go on the resume.

---

## 1. Why we can measure this at all

Most projects in this space cannot produce honest accuracy numbers, because on real telemetry
nobody knows which alerts *should* have been grouped. There is no label.

We have an advantage that is worth stating explicitly in interviews: **our simulator is
deterministic and we inject the anomalies ourselves**, so we know exactly which zones were
affected, when each was affected, and how the fault moved. That is ground truth. It converts
"this seems to work" into measured precision and recall.

This is a real methodological strength, not a workaround for not having real data. Say it that
way: *"I built the fault injector and the scorer before I built the detector, so I could never
fool myself about whether it worked."* That sentence signals research discipline, and most
candidates cannot say anything like it.

---

## 2. Ground truth format

The simulator writes one JSONL record per injected anomaly to `evals/groundtruth/<run-id>.jsonl`:

```jsonc
{
  "anomalyId": "A-001",
  "runId": "2026-09-20T14:02:11Z-seed42",
  "kind": "regional-anomaly",
  "seed": 42,
  "onsetEventTime": 1774000000000,
  "endEventTime":   1774000240000,
  "origin":   { "latitude": 52.31, "longitude": 13.04 },
  "radiusKm": 84,
  "propagation": { "bearingDeg": 41, "speedKmh": 38 },   // null if stationary
  "affectedZones": [
    { "zoneId": "Z-0147", "onsetEventTime": 1774000000000, "peakSeverity": 0.94 },
    { "zoneId": "Z-0148", "onsetEventTime": 1774000003200, "peakSeverity": 0.91 }
    // ...
  ]
}
```

The run id must embed the seed so any result can be reproduced exactly.

**As built (WP6a).** The run id is `20260115T120000Z-regional-anomaly-seed42` — the *simulated*
start epoch, the scenario, and the seed — not the wall-clock form illustrated above. The id is
embedded in every record, so a wall-clock stamp would make two runs of the same configuration
differ byte for byte, which is the exact property `CLAUDE.md` rule 3 exists to protect; `:` is
also not a legal Windows filename character. Same configuration now means same id means same
file, which is correct, because same configuration also means the same ground truth. `RUN_ID`
overrides it when several runs of one configuration need keeping side by side. Reasoning in
`docs/adr/ADR-006-ground-truth-by-construction.md`.

A sidecar `<run-id>.meta.json` is written alongside, carrying the run configuration — zone
count, simulated hours, seed, the labelling threshold. It is deliberately **not** in the JSONL,
which stays exactly the schema above. The scorer needs it for the metrics that are rates rather
than set comparisons: false-incident rate is per simulated hour, which is not derivable from the
anomalies alone.

### 2.0 How the labels are produced

One severity function, `anomaly.severityAt(spec, zone, t)`, is called by both the event
generator and the label deriver, on the same tick grid, at the same instants the events are
stamped with. The labels and the stream are not two implementations of one idea — they are one
implementation read twice, so they cannot disagree.

Two thresholds, doing two different jobs:

| Constant | Value | Question |
|---|---|---|
| `MIN_AFFECTED_SEVERITY` | 0.85 | Did this anomaly take this zone over? → membership |
| `ONSET_SEVERITY` | ≈ 0.714 | From when was it showing? → `affectedZones[].onsetEventTime` |

They were one threshold until a consistency check caught the consequence: severity climbs
through a 120-second ramp, so a zone's load crosses the degradation threshold about twelve
seconds before severity reaches 0.85. Measuring TTD from the later instant would have reported
every time-to-detect twelve seconds faster than it was. `ONSET_SEVERITY` is pinned to the
earliest instant the load *could* have crossed, given the sensor's bounded jitter, so any
residual error is conservative rather than flattering.

The deriver **throws** rather than emit a label whose peak severity falls between the two
thresholds, because such a zone degrades on some ticks and not others and would cap the
membership precision of every measurement taken afterwards.

### 2.1 Required scenarios

The eval suite must contain all four. The last two exist to catch the two ways this system can
lie to you, and running only the first two would be exactly the kind of self-deception the
methodology is designed to prevent.

| Scenario | What it tests | The failure it catches |
|---|---|---|
| `regional-anomaly` | Basic correlation: one region degrades, one incident should result. | Under-grouping — fragmenting one event into many incidents. |
| `propagating-anomaly` | A front moves across the map at known bearing/speed. | Propagation-vector accuracy; also grow/merge behaviour under continuous change. |
| `multi-anomaly` | Two *disjoint* regional anomalies simultaneously. | **Over-grouping** — merging unrelated events into one incident. |
| `noise` | Scattered independent single-zone degradations, no regional structure at all. | **Hallucinated incidents** — manufacturing structure out of noise. This is the one that keeps you honest. |

**As built (WP6a).** All four exist in `sensor-simulator`, selected with `SCENARIO`. The
reference configuration is `NUM_ZONES=400`, `SEED=42`, four simulated hours, which at
`SPEED_MULTIPLIER=3600` completes in about four real minutes. What each injects at that
configuration:

| Scenario | Anomalies | Zones labelled | Notes |
|---|---|---|---|
| `regional-anomaly` | 1 stationary, r = 95 km | 62 | Onsets within ~20 s of each other across the disc. |
| `propagating-anomaly` | 1 front, r = 62.5 km, 129.7° at 32.6 km/h | 57 | Onsets spread over ~195 simulated minutes as the front sweeps. |
| `multi-anomaly` | 2 disjoint, r = 56.3 km, staggered in time | 43 (22 + 21) | ≥ 100 km of clear ground between the discs; no zone in both. |
| `noise` | 16 single-zone bursts | 16 | ≥ 80 km apart; correct incident count is **zero**. |

Reference label files for seed 42 are committed under `evals/groundtruth/`. They are fully
regenerable — `PLAN_ONLY=1` writes them in milliseconds without producing any events.

Two design points that the suite depends on and that are asserted rather than assumed:

- The `multi-anomaly` builder **throws** if a parameter change ever lets its two discs approach
  each other. A silently-overlapping pair would stop testing over-grouping while still passing.
- Each `noise` burst's radius is derived from the distance to its zone's nearest neighbour, so a
  burst provably cannot touch a second zone however the field is jittered. Two adjacent noise
  zones would be a small real incident, and the scenario would stop testing what it is for.

**Zone density is a precondition, not a detail.** The original zone layout spread zones over the
whole planet, which put the closest pair 160 km apart at 5000 zones and left every H3 neighbour
ring empty — see D9 in `01-ARCHITECTURE.md` §3.3. Any eval run over a field that sparse reports
a collapse ratio of zero no matter how good the correlation engine is. The anomaly scenarios
therefore default to the `regional-grid` layout, and the simulator warns at startup when the
field it is given is still too thin.

A parameter sweep over `CORRELATION_WINDOW_MS`, `H3_RESOLUTION`, and `NEIGHBOUR_RING_SIZE` should
be run across all four to produce a tuning curve. That curve is a great interview artefact: it
shows the trade-off between grouping aggressively (fewer pages, more risk of merging unrelated
events) and conservatively, and lets you say *"I chose this operating point, here's the curve, and
here's why that point"* rather than "I picked 120 seconds."

---

## 3. Metric definitions

Precise definitions matter — an interviewer may well ask exactly how you computed these.

### 3.1 Collapse ratio — *the headline number*

```
collapse_ratio = 1 - (incidents_opened / degradation_events_emitted)
```

Counted over one eval run. `degradation_events_emitted` is the number of zone-level state
transitions the old system would have paged on; `incidents_opened` is what the new system pages on.

> Report as: "collapsed 12,400 raw alerts into 740 incidents — a 94% reduction in pages."
> Always give both absolute numbers, not only the percentage. A bare percentage reads as inflated;
> the absolute pair reads as measured.

### 3.2 Membership precision / recall / F1

For each detected incident, match it to the ground-truth anomaly with maximum Jaccard overlap of
zone sets (greedy one-to-one matching, highest overlap first).

```
precision = |detected ∩ truth| / |detected|     (did we include zones that don't belong?)
recall    = |detected ∩ truth| / |truth|        (did we miss zones that do belong?)
F1        = 2PR / (P + R)
```

Report macro-averaged across anomalies. Precision below 1.0 means over-grouping; recall below 1.0
means fragmentation.

### 3.3 Time-to-detect (TTD)

```
ttd = incident.openedAt - min(affectedZones[].onsetEventTime)
```

Event-time, not wall-clock. Report p50 and p95. Note honestly that TTD has a floor imposed by the
existing state machine's confirmation delays (60s for STRESSED, 20s for CRITICAL) — the
correlation layer cannot detect faster than its inputs. Being upfront about that floor is better
than quoting a number that looks impossibly fast.

### 3.4 Fragmentation index

```
fragmentation = detected_incidents_matched_to_this_anomaly / 1
```

1.0 is perfect. 3.0 means one real event produced three incidents. Report the mean, and
separately report how much of the fragmentation is attributable to coarse-cell partition
boundaries (§6 of the architecture doc) — that decomposition demonstrates you understand *why*
your system is imperfect, which is more impressive than a perfect score.

### 3.5 False-incident rate

On the `noise` scenario, where no regional structure exists:

```
false_incident_rate = incidents_opened / simulated_hour
```

Ideally near zero. This is the metric that proves you are not manufacturing incidents.

### 3.6 Propagation error

```
bearing_error_deg = angular_difference(detected.bearingDeg, truth.bearingDeg)
speed_error_pct   = |detected.speedKmh - truth.speedKmh| / truth.speedKmh
```

Only over incidents where `rSquared >= 0.7`. Separately report what fraction of propagating
anomalies produced a usable vector at all — a highly accurate vector that only appears 5% of the
time is not a useful feature, and reporting both numbers shows you know that.

### 3.7 Throughput and latency

- **Sustained throughput** — events/sec the full pipeline absorbs without consumer lag growing.
  Measure lag via `kafka-consumer-groups --describe`; the run is only valid if lag is flat.
- **Correlation latency** — `incidentEvent.emittedAt - degradation.eventTime`, p50/p95/p99.
- **Compaction cost** — `compaction_duration_ms` p99, at 1k / 10k / 50k zones. This is the metric
  that justifies ADR-002's design; if it grows badly with zone count, the local-rebuild strategy
  was the wrong call and you should know that.
- Always report the hardware and the configuration. "45K events/sec" with no context is a
  meaningless number and an interviewer will treat it as one.

---

## 4. Benchmark protocol

Non-negotiable rules, because sloppy benchmarking is worse than none:

1. **Warm up.** Discard the first 60 seconds. JIT, connection pools, and page cache all need to settle.
2. **Steady state only.** A throughput number is valid only while consumer lag is flat. If lag is
   growing you are measuring the producer, not the pipeline.
3. **Report the whole distribution.** p50, p95, p99. Never a bare mean — means hide the tail, and
   the tail is the interesting part.
4. **Fix the seed.** Every run records its seed; every reported number is reproducible.
5. **Commit raw output.** `benchmarks/results/<timestamp>-<seed>.json`, plus the environment
   (CPU, RAM, Docker version, Node version, partition count, zone count).
6. **Measure the baseline too.** Run the naive path (per-message, single partition, no batching)
   and the optimised path on the same hardware. A speedup figure is only meaningful against a
   baseline you actually measured, on the same box, on the same day.

---

## 5. Results table (fill as measured — `TBD` until then)

This table goes in the README. Leave `TBD` rather than guessing; a `TBD` costs nothing, an
invented number costs the interview.

| Metric | Scenario | Value | Source |
|---|---|---|---|
| Collapse ratio | regional-anomaly, 10k zones | TBD | `evals/results/` |
| Raw alerts → incidents (absolute) | regional-anomaly, 10k zones | TBD | `evals/results/` |
| Membership precision (macro) | all scenarios | TBD | `evals/results/` |
| Membership recall (macro) | all scenarios | TBD | `evals/results/` |
| Fragmentation index (mean) | regional + propagating | TBD | `evals/results/` |
| False-incident rate | noise | TBD | `evals/results/` |
| Time-to-detect p50 / p95 | regional-anomaly | TBD | `evals/results/` |
| Bearing error (mean abs) | propagating-anomaly | TBD | `evals/results/` |
| Propagation vector availability | propagating-anomaly | TBD | `evals/results/` |
| Sustained throughput | 10k zones | TBD | `benchmarks/results/` |
| Correlation latency p99 | 10k zones | TBD | `benchmarks/results/` |
| Compaction p99 | 1k / 10k / 50k zones | TBD | `benchmarks/results/` |
| Neighbour lookup vs naive scan | 1k / 10k / 100k zones | TBD | `benchmarks/results/` |

---

## 6. Honesty rules

These exist because the entire value of this project rests on the numbers being real.

- **Never round in your favour.** 91.3% is 91%, not "over 90%".
- **Never quote a metric whose scenario you'd be embarrassed to name.** If collapse ratio is 94%
  on `regional-anomaly` and 61% averaged across all four scenarios, and you quote 94%, be ready
  to say which scenario — and volunteer it before you're asked.
- **If a number is bad, that is data, not failure.** A poor false-incident rate that you found,
  explained, and then fixed by tuning the correlation window is a *better* interview story than a
  good number that arrived with no struggle. Interviewers are listening for how you think, and
  "here's what went wrong and how I diagnosed it" demonstrates far more than a clean result.
- **When asked "how do you know?", the answer is a file path.** That is the whole point of the
  committed-results rule.
