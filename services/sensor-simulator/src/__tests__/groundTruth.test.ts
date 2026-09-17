import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ZoneGenerator } from '../zoneGenerator';
import { LoadGenerator } from '../loadGenerator';
import { haversineKm } from '../geo';
import {
  MIN_AFFECTED_SEVERITY,
  ONSET_SEVERITY,
  DEGRADING_LOAD,
  severityAt,
  temporalFactor,
  spatialFactor
} from '../anomaly';
import {
  buildAnomalies,
  MIN_DISJOINT_SEPARATION_KM,
  NOISE_MIN_SEPARATION_KM
} from '../scenarios';
import { deriveGroundTruth, deriveRunId, serialiseGroundTruth, writeGroundTruth } from '../groundTruth';
import { AnomalySpec, GroundTruthRecord, ScenarioType, ZoneConfig } from '../types';

/**
 * What the ground truth claims must be true of the events that were actually emitted.
 *
 * The labels and the stream are computed from one severity function, so they cannot drift — but
 * "cannot drift" is an argument about the code, and the measurement is too important to rest on
 * an argument. These tests check the claim against the stream itself: every zone the labels say
 * was affected really does sustain a degrading load, and no zone the labels leave out ever gets
 * near one.
 *
 * The state machine (stream-processor/src/stateMachine.ts) calls STRESSED at a five-minute
 * average of 0.75 held for 60 seconds. Asserting on the instantaneous load against the same
 * 0.75 is the simulator's side of that contract: it says the injector drove the zone into
 * degradation, without this service re-implementing the consumer's windowing to prove it.
 */

const SEED = 42;
const START = Date.UTC(2026, 0, 15, 12, 0, 0);
const STEP_MS = 1000;
const ZONE_COUNT = 200;
const RUN_DURATION_MS = 2 * 60 * 60 * 1000;

/** The simulator's copy of stateMachine.THRESHOLD_STRESSED. */
const STRESSED_LOAD = DEGRADING_LOAD;

/** Mirrors stateMachine.CONFIRMATION_STRESSED_MS. */
const CONFIRMATION_MS = 60_000;

const ZONES = ZoneGenerator.generate({ count: ZONE_COUNT, layout: 'regional-grid', seed: SEED });

function plan(scenario: ScenarioType): AnomalySpec[] {
  return buildAnomalies(scenario, {
    zones: ZONES,
    seed: SEED,
    startEventTime: START,
    runDurationMs: RUN_DURATION_MS
  });
}

function labels(scenario: ScenarioType, anomalies: AnomalySpec[]): GroundTruthRecord[] {
  return deriveGroundTruth({
    runId: deriveRunId(scenario, SEED, START),
    scenario,
    seed: SEED,
    zones: ZONES,
    anomalies,
    startEpochMs: START,
    stepMs: STEP_MS,
    runDurationMs: RUN_DURATION_MS
  });
}

interface ZoneTrace {
  peakLoad: number;
  longestDegradedMs: number;
  firstDegradedAt: number;
}

/** Replay the whole run and record, per zone, what the emitted load actually did. */
function traceRun(scenario: ScenarioType, anomalies: AnomalySpec[]): Map<string, ZoneTrace> {
  const traces = new Map<string, ZoneTrace>();
  const currentRun = new Map<string, number>();

  for (const zone of ZONES) {
    traces.set(zone.zoneId, { peakLoad: 0, longestDegradedMs: 0, firstDegradedAt: -1 });
    currentRun.set(zone.zoneId, 0);
  }

  // Exactly the instants and timestamps generateEvent would stamp, without paying for the
  // UUID on every one of the couple of million ticks this replays.
  const lags = new Map(ZONES.map((zone) => [zone.zoneId, LoadGenerator.sensorLagMs(zone.zoneId)]));

  const ticks = Math.floor(RUN_DURATION_MS / STEP_MS);
  for (let tick = 0; tick <= ticks; tick++) {
    const simNow = START + tick * STEP_MS;
    for (const zone of ZONES) {
      const eventTimestamp = simNow - lags.get(zone.zoneId)!;
      const load = LoadGenerator.loadAt(zone, scenario, eventTimestamp, anomalies);
      const trace = traces.get(zone.zoneId)!;

      if (load > trace.peakLoad) {
        trace.peakLoad = load;
      }

      if (load >= STRESSED_LOAD) {
        const run = currentRun.get(zone.zoneId)! + STEP_MS;
        currentRun.set(zone.zoneId, run);
        if (run > trace.longestDegradedMs) {
          trace.longestDegradedMs = run;
        }
        if (trace.firstDegradedAt < 0) {
          trace.firstDegradedAt = eventTimestamp;
        }
      } else {
        currentRun.set(zone.zoneId, 0);
      }
    }
  }

  return traces;
}

const SCENARIOS: ScenarioType[] = [
  'regional-anomaly',
  'propagating-anomaly',
  'multi-anomaly',
  'noise'
];

describe.each(SCENARIOS)('%s labels match the emitted stream', (scenario) => {
  const anomalies = plan(scenario);
  const records = labels(scenario, anomalies);
  const traces = traceRun(scenario, anomalies);
  const affected = new Set(records.flatMap((r) => r.affectedZones.map((z) => z.zoneId)));

  it('injects at least one anomaly that reaches at least one zone', () => {
    expect(records.length).toBeGreaterThan(0);
    expect(affected.size).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.affectedZones.length).toBeGreaterThan(0);
    }
  });

  it('drives every labelled zone into a sustained degrading load', () => {
    for (const zoneId of affected) {
      const trace = traces.get(zoneId)!;
      expect(trace.peakLoad).toBeGreaterThanOrEqual(STRESSED_LOAD);
      // Comfortably past the confirmation window, not marginally: a zone that only just
      // qualifies is a zone whose detection depends on rounding.
      expect(trace.longestDegradedMs).toBeGreaterThan(CONFIRMATION_MS * 2);
    }
  });

  it('never lets an unlabelled zone degrade', () => {
    // The precision ceiling. If a zone degrades without a label, the correlation engine is
    // right to include it and gets marked wrong for doing so — and no amount of tuning could
    // ever recover the lost precision, because the fault is in the labels.
    const strays = ZONES.filter(
      (zone) => !affected.has(zone.zoneId) && traces.get(zone.zoneId)!.peakLoad >= STRESSED_LOAD
    );
    expect(strays.map((z) => z.zoneId)).toEqual([]);
  });

  it('puts each labelled onset at or before the zone first degrades', () => {
    // Time-to-detect is measured from the labelled onset, so an onset later than the stream's
    // own first degradation would quietly make every TTD look better than it was.
    for (const record of records) {
      for (const { zoneId, onsetEventTime } of record.affectedZones) {
        const trace = traces.get(zoneId)!;
        expect(trace.firstDegradedAt).toBeGreaterThanOrEqual(0);
        expect(onsetEventTime).toBeLessThanOrEqual(trace.firstDegradedAt);
      }
    }
  });

  it('separates the onset threshold from the membership cut, and applies each to its own job', () => {
    for (const record of records) {
      const spec = anomalies.find((a) => a.anomalyId === record.anomalyId)!;
      for (const { zoneId, onsetEventTime, peakSeverity } of record.affectedZones) {
        const zone = ZONES.find((z) => z.zoneId === zoneId)!;

        // Membership: the anomaly took this zone over at some point.
        expect(peakSeverity).toBeGreaterThanOrEqual(MIN_AFFECTED_SEVERITY);
        expect(peakSeverity).toBeLessThanOrEqual(1);

        // Onset: the first tick from which the zone's load could already have been degrading,
        // and not one tick earlier than that.
        expect(severityAt(spec, zone, onsetEventTime)).toBeGreaterThanOrEqual(ONSET_SEVERITY);
        expect(severityAt(spec, zone, onsetEventTime - STEP_MS)).toBeLessThan(ONSET_SEVERITY);
      }
    }
  });

  it('leaves no zone labelled ambiguously between the two thresholds', () => {
    // The deriver throws rather than emit such a label, so reaching this assertion at all means
    // the severity floor did its job. Asserted here too, because the guard is only as good as
    // the scenarios that exercise it.
    for (const record of records) {
      for (const { peakSeverity } of record.affectedZones) {
        expect(peakSeverity).not.toBeLessThan(MIN_AFFECTED_SEVERITY);
      }
    }
  });

  it('keeps every onset inside the anomaly window', () => {
    for (const record of records) {
      for (const { onsetEventTime } of record.affectedZones) {
        expect(onsetEventTime).toBeGreaterThanOrEqual(record.onsetEventTime);
        expect(onsetEventTime).toBeLessThan(record.endEventTime);
      }
    }
  });

  it('emits the §2 schema, with the documented keys in the documented order', () => {
    for (const record of records) {
      expect(Object.keys(record)).toEqual([
        'anomalyId',
        'runId',
        'kind',
        'seed',
        'onsetEventTime',
        'endEventTime',
        'origin',
        'radiusKm',
        'propagation',
        'affectedZones'
      ]);
      expect(record.seed).toBe(SEED);
      expect(record.kind).toBe(scenario);
      expect(record.runId).toBe(deriveRunId(scenario, SEED, START));
      expect(Object.keys(record.origin)).toEqual(['latitude', 'longitude']);
      for (const zone of record.affectedZones) {
        expect(Object.keys(zone)).toEqual(['zoneId', 'onsetEventTime', 'peakSeverity']);
      }
    }
  });

  it('serialises as one LF-terminated JSON object per line', () => {
    const serialised = serialiseGroundTruth(records);
    const lines = serialised.split('\n').filter((line) => line.length > 0);

    expect(serialised).not.toContain('\r');
    expect(serialised.endsWith('\n')).toBe(true);
    expect(lines).toHaveLength(records.length);
    expect(lines.map((line) => JSON.parse(line))).toEqual(records);
  });
});

describe('scenario shapes', () => {
  it('regional-anomaly injects exactly one stationary fault', () => {
    const [spec, ...rest] = plan('regional-anomaly');
    expect(rest).toEqual([]);
    expect(spec.propagation).toBeNull();
    expect(spec.radiusKm).toBeGreaterThan(0);
  });

  it('propagating-anomaly moves its centre a real distance across the field', () => {
    const [spec] = plan('propagating-anomaly');
    expect(spec.propagation).not.toBeNull();

    const records = labels('propagating-anomaly', [spec]);
    const onsets = records[0].affectedZones.map((z) => z.onsetEventTime);
    const spreadMs = Math.max(...onsets) - Math.min(...onsets);

    // A front that arrives everywhere at once is a regional anomaly wearing a bearing. The
    // onset spread is the only thing that makes propagation-vector estimation possible at all,
    // so it has to be a large fraction of the run rather than a rounding artefact.
    expect(spreadMs).toBeGreaterThan(RUN_DURATION_MS * 0.25);
  });

  it('multi-anomaly injects two faults that overlap in time and not in space', () => {
    const specs = plan('multi-anomaly');
    expect(specs).toHaveLength(2);

    const [a, b] = specs;
    const clearanceKm = haversineKm(a.origin, b.origin) - a.radiusKm - b.radiusKm;
    expect(clearanceKm).toBeGreaterThanOrEqual(MIN_DISJOINT_SEPARATION_KM);

    // Overlapping windows, because an engine could otherwise separate them on timing alone.
    expect(a.onsetEventTime).toBeLessThan(b.endEventTime);
    expect(b.onsetEventTime).toBeLessThan(a.endEventTime);
    expect(a.onsetEventTime).not.toBe(b.onsetEventTime);

    // And no zone belongs to both, or "did we merge unrelated events" becomes unanswerable.
    const records = labels('multi-anomaly', specs);
    const first = new Set(records[0].affectedZones.map((z) => z.zoneId));
    const second = records[1].affectedZones.map((z) => z.zoneId);
    expect(second.filter((zoneId) => first.has(zoneId))).toEqual([]);
  });

  it('noise injects isolated single-zone degradations with no regional structure', () => {
    const specs = plan('noise');
    const records = labels('noise', specs);

    expect(records.length).toBeGreaterThanOrEqual(4);

    for (const record of records) {
      // Exactly one zone each. Two adjacent noise zones would be a small real incident, and the
      // scenario would stop being a test of whether we manufacture structure from nothing.
      expect(record.affectedZones).toHaveLength(1);
      expect(record.propagation).toBeNull();
    }

    const zoneIds = records.map((r) => r.affectedZones[0].zoneId);
    expect(new Set(zoneIds).size).toBe(zoneIds.length);

    for (let i = 0; i < zoneIds.length; i++) {
      for (let j = i + 1; j < zoneIds.length; j++) {
        const left = ZONES.find((z) => z.zoneId === zoneIds[i])!;
        const right = ZONES.find((z) => z.zoneId === zoneIds[j])!;
        expect(haversineKm(left, right)).toBeGreaterThanOrEqual(NOISE_MIN_SEPARATION_KM);
      }
    }
  });

  it('gives the load-profile scenarios no anomalies, and so no ground truth to score', () => {
    for (const scenario of ['normal', 'spike', 'drop'] as ScenarioType[]) {
      expect(plan(scenario)).toEqual([]);
    }
  });
});

describe('the severity model', () => {
  const [spec] = plan('regional-anomaly');

  it('is zero outside the radius and at or above the cut inside it', () => {
    const settled = spec.onsetEventTime + spec.rampMs + 1000;
    for (const zone of ZONES) {
      const distanceKm = haversineKm(zone, spec.origin);
      const severity = severityAt(spec, zone, settled);

      if (distanceKm >= spec.radiusKm) {
        expect(severity).toBe(0);
      } else {
        expect(severity).toBeGreaterThanOrEqual(MIN_AFFECTED_SEVERITY);
      }
    }
  });

  it('keeps an interior gradient rather than flattening the whole disc', () => {
    const settled = spec.onsetEventTime + spec.rampMs + 1000;
    const inner = ZONES.filter((z) => haversineKm(z, spec.origin) < spec.radiusKm * 0.3);
    const outer = ZONES.filter((z) => {
      const d = haversineKm(z, spec.origin);
      return d > spec.radiusKm * 0.9 && d < spec.radiusKm;
    });

    expect(inner.length).toBeGreaterThan(0);
    expect(outer.length).toBeGreaterThan(0);
    expect(Math.min(...inner.map((z) => severityAt(spec, z, settled)))).toBeGreaterThan(
      Math.max(...outer.map((z) => severityAt(spec, z, settled)))
    );
  });

  it('ramps up, holds, and decays, and is zero outside its window', () => {
    expect(temporalFactor(spec, spec.onsetEventTime - 1)).toBe(0);
    expect(temporalFactor(spec, spec.onsetEventTime)).toBe(0);
    expect(temporalFactor(spec, spec.onsetEventTime + spec.rampMs / 2)).toBeCloseTo(0.5, 3);
    expect(temporalFactor(spec, spec.onsetEventTime + spec.rampMs)).toBe(1);
    expect(temporalFactor(spec, spec.endEventTime - spec.decayMs / 2)).toBeCloseTo(0.5, 3);
    expect(temporalFactor(spec, spec.endEventTime)).toBe(0);
    expect(temporalFactor(spec, spec.endEventTime + 1)).toBe(0);
  });

  it('has a radial profile that is flat in the core and falls to zero at the rim', () => {
    expect(spatialFactor(0, 100)).toBe(1);
    expect(spatialFactor(50, 100)).toBe(1);
    expect(spatialFactor(100, 100)).toBe(0);
    expect(spatialFactor(150, 100)).toBe(0);
    expect(spatialFactor(92.5, 100)).toBeGreaterThan(0);
    expect(spatialFactor(92.5, 100)).toBeLessThan(1);
  });
});

describe('writing the run to disk', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'geopulse-gt-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('writes the labels and a sidecar manifest, and rewrites identically', () => {
    const anomalies = plan('multi-anomaly');
    const options = {
      runId: deriveRunId('multi-anomaly', SEED, START),
      scenario: 'multi-anomaly' as ScenarioType,
      seed: SEED,
      zones: ZONES,
      anomalies,
      startEpochMs: START,
      stepMs: STEP_MS,
      runDurationMs: RUN_DURATION_MS
    };

    const written = writeGroundTruth(directory, options);
    const firstPass = fs.readFileSync(written.groundTruthPath);

    expect(written.recordCount).toBe(2);
    expect(written.affectedZoneCount).toBeGreaterThan(0);
    expect(written.groundTruthPath.endsWith('.jsonl')).toBe(true);

    writeGroundTruth(directory, options);
    expect(fs.readFileSync(written.groundTruthPath).equals(firstPass)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(written.manifestPath, 'utf8'));
    expect(manifest.seed).toBe(SEED);
    expect(manifest.zoneCount).toBe(ZONE_COUNT);
    expect(manifest.anomalyCount).toBe(2);
    // The scorer needs this: false-incident rate is per simulated hour, which is not derivable
    // from the anomalies alone.
    expect(manifest.simulatedHours).toBeCloseTo(RUN_DURATION_MS / 3_600_000, 6);
  });

  it('creates the ground-truth directory if it does not exist yet', () => {
    const nested = path.join(directory, 'evals', 'groundtruth');
    const written = writeGroundTruth(nested, {
      runId: deriveRunId('noise', SEED, START),
      scenario: 'noise',
      seed: SEED,
      zones: ZONES,
      anomalies: plan('noise'),
      startEpochMs: START,
      stepMs: STEP_MS,
      runDurationMs: RUN_DURATION_MS
    });

    expect(fs.existsSync(written.groundTruthPath)).toBe(true);
  });
});
