# evals — ground truth and scoring

This directory holds the labels for eval runs, and (from WP6b) the scorer that consumes them.

```
evals/
  groundtruth/<run-id>.jsonl        one JSON object per injected anomaly (schema: docs/03-MEASUREMENT.md §2)
  groundtruth/<run-id>.meta.json    the run's configuration — what the scorer needs that the labels do not carry
  results/                          [WP6b] scored output, one file per run
  score.ts                          [WP6b] ground truth + emitted incidents -> the metric set
```

## Producing ground truth

The simulator writes the labels for a run **before it produces a single event**, so a run that
dies half way still leaves a complete description of what was supposed to happen.

```bash
cd services/sensor-simulator

# Plan only: write the labels in milliseconds, produce no events, need no broker.
PLAN_ONLY=1 NUM_ZONES=400 SCENARIO=regional-anomaly SEED=42 npx ts-node src/index.ts

# A full run: four simulated hours in about four real minutes, stops itself at the end.
NUM_ZONES=400 SCENARIO=regional-anomaly SEED=42 SPEED_MULTIPLIER=3600 npx ts-node src/index.ts
```

`SCENARIO` is one of `regional-anomaly`, `propagating-anomaly`, `multi-anomaly`, `noise`. The
first two measure whether correlation works; the last two measure whether it lies — `multi-anomaly`
catches over-grouping, `noise` catches incidents invented out of nothing. A suite without them
would report excellent numbers for a system that merged the whole map into one incident.

## Why these files are committed

They are fully regenerable from the seed, and they are committed anyway, for two reasons.

A result is only defensible if the labels it was scored against can be inspected — `CLAUDE.md`
rule 1, and the point of the whole measurement discipline. And a committed reference set turns a
change in the injector from an invisible drift into a visible diff: if a refactor quietly moves
which zones an anomaly covers, every number taken before it silently stops being comparable to
every number taken after. A diff against these files says so immediately.

The set here is seed 42 at the reference configuration (400 zones, four simulated hours). Runs
at other seeds and configurations are not committed — regenerate them.

## The run id

`20260115T120000Z-regional-anomaly-seed42` — the *simulated* start epoch, the scenario, and the
seed. Deliberately not a wall-clock stamp: the id is embedded in every record, so a wall-clock id
would make two runs of the same configuration differ byte for byte. Same configuration means
same id means same file, which is correct, because same configuration also means the same ground
truth. Set `RUN_ID` to keep several runs of one configuration side by side.

## Reading a record

```jsonc
{
  "anomalyId": "A-001",
  "runId": "20260115T120000Z-regional-anomaly-seed42",
  "kind": "regional-anomaly",
  "seed": 42,
  "onsetEventTime": 1768480560000,   // the anomaly's window, in simulated event time
  "endEventTime": 1768489200000,
  "origin": { "latitude": 51.959695, "longitude": 13.08766 },
  "radiusKm": 95,                    // the geometric parameter; affectedZones is the claim
  "propagation": null,               // { bearingDeg, speedKmh } when the fault moves
  "affectedZones": [
    { "zoneId": "Z-89", "onsetEventTime": 1768480660993, "peakSeverity": 0.85 }
    // ... one entry per zone the anomaly drove into degradation
  ]
}
```

Every timestamp is simulated event time (ADR-005), never wall clock. `peakSeverity` varies across
the disc — 0.97 at the core down to 0.85 at the rim — because the severity field has an interior
gradient; that gradient is what makes per-zone onset times vary as a front sweeps, which is the
signal WP4's propagation-vector estimation works from.

`affectedZones` is the set to score membership against, not everything inside `radiusKm`. How
the two thresholds behind that set are chosen, and why there are two, is in
`docs/adr/ADR-006-ground-truth-by-construction.md`.
