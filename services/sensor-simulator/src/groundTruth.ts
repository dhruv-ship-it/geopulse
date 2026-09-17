import * as fs from 'fs';
import * as path from 'path';
import {
  AnomalySpec,
  GroundTruthRecord,
  GroundTruthZone,
  ScenarioType,
  ZoneConfig
} from './types';
import { MIN_AFFECTED_SEVERITY, ONSET_SEVERITY, severityAt, centreAt } from './anomaly';
import { haversineKm, LatLon } from './geo';
import { LoadGenerator } from './loadGenerator';

/**
 * Derives the labels for a run, and writes them to evals/groundtruth/<run-id>.jsonl in the
 * schema fixed by docs/03-MEASUREMENT.md §2.
 *
 * The labels are *derived*, not observed and not hand-written. For every zone, on the same tick
 * grid the generator emits on, at the same instant the generator evaluates load at, we call the
 * same `severityAt` the generator calls. A zone is affected by an anomaly when that anomaly
 * drove its severity past MIN_AFFECTED_SEVERITY at some point; its onset is the first event
 * timestamp at which the zone's load could already have been degrading (ONSET_SEVERITY), which
 * is earlier and is the instant time-to-detect should be measured from.
 *
 * This is the property the whole measurement rests on, so it is worth stating plainly: the
 * ground truth cannot disagree with the event stream, because it is computed from the same
 * function over the same grid. There is no second implementation to drift.
 *
 * Labels are written before the first event is produced. If a run dies half way, what exists on
 * disk still describes what was supposed to happen — and the scorer can tell a partial run from
 * a complete one by comparing against the sidecar manifest.
 */

export interface GroundTruthOptions {
  runId: string;
  scenario: ScenarioType;
  seed: number;
  zones: readonly ZoneConfig[];
  anomalies: readonly AnomalySpec[];
  startEpochMs: number;
  stepMs: number;
  runDurationMs: number;
}

/**
 * A deterministic run id, which is a deliberate deviation from the illustrative
 * `2026-09-20T14:02:11Z-seed42` in the measurement doc.
 *
 * Two reasons. A wall-clock stamp would make two runs of the same configuration differ byte for
 * byte, which is exactly the property the hard determinism rule exists to protect — the run id
 * is embedded in every record, so a non-deterministic id makes every record non-deterministic.
 * And ':' is not a legal character in a Windows filename, so the literal ISO form cannot be a
 * path here at all.
 *
 * What replaces it keeps everything the id was for: the simulated start instant, the scenario,
 * and the seed. Same configuration means same id means same file — which is correct, because
 * same configuration also means the same ground truth. Set RUN_ID to override when you want
 * several runs of one configuration kept side by side.
 */
export function deriveRunId(scenario: ScenarioType, seed: number, startEpochMs: number): string {
  const stamp = new Date(startEpochMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `${stamp}-${scenario}-seed${seed}`;
}

/** Build one ground-truth record per injected anomaly. */
export function deriveGroundTruth(options: GroundTruthOptions): GroundTruthRecord[] {
  const { anomalies, zones, startEpochMs, stepMs, runDurationMs, runId, seed } = options;
  const totalTicks = Math.floor(runDurationMs / stepMs);

  return anomalies.map((spec) => {
    const affectedZones: GroundTruthZone[] = [];

    for (const zone of candidateZones(spec, zones, stepMs)) {
      // The sensor samples on the shared tick grid but stamps the event with its own bounded
      // lag, and the load is computed from that stamped instant — so the label has to be
      // evaluated there too, not at the tick. Twenty milliseconds does not change which zones
      // are affected, but "the labels are evaluated at exactly the instants the events carry"
      // is either true or it is not.
      const lagMs = LoadGenerator.sensorLagMs(zone.zoneId);

      const firstTick = Math.max(
        0,
        Math.ceil((spec.onsetEventTime + lagMs - startEpochMs) / stepMs)
      );
      const lastTick = Math.min(
        totalTicks,
        Math.floor((spec.endEventTime + lagMs - startEpochMs) / stepMs)
      );

      let onsetEventTime = -1;
      let peakSeverity = 0;

      for (let tick = firstTick; tick <= lastTick; tick++) {
        const eventTime = startEpochMs + tick * stepMs - lagMs;
        const severity = severityAt(spec, zone, eventTime);

        if (severity > peakSeverity) {
          peakSeverity = severity;
        }
        if (onsetEventTime < 0 && severity >= ONSET_SEVERITY) {
          onsetEventTime = eventTime;
        }
      }

      // A zone whose severity peaked between the two thresholds is neither clearly taken over
      // nor clearly untouched: it would degrade on some ticks and not others, and whichever way
      // it were labelled it would be wrong about half the time. The severity floor in
      // anomaly.ts is designed so this cannot happen, so reaching it means a scenario parameter
      // has moved somewhere it should not have. Refuse to emit ambiguous labels rather than
      // quietly cap the precision every later measurement can reach.
      if (peakSeverity >= ONSET_SEVERITY && peakSeverity < MIN_AFFECTED_SEVERITY) {
        throw new Error(
          `${spec.anomalyId} leaves ${zone.zoneId} at peak severity ` +
            `${peakSeverity.toFixed(4)}, between the onset threshold ` +
            `${ONSET_SEVERITY.toFixed(4)} and the membership cut ${MIN_AFFECTED_SEVERITY}; ` +
            'the labels for this run would be ambiguous'
        );
      }

      if (peakSeverity >= MIN_AFFECTED_SEVERITY) {
        affectedZones.push({
          zoneId: zone.zoneId,
          onsetEventTime,
          peakSeverity: round(peakSeverity, 4)
        });
      }
    }

    // Sorted by zone id, not by discovery order. The scorer compares sets, but a stable order
    // is what makes two runs byte-comparable and a diff of two ground-truth files readable.
    affectedZones.sort((a, b) => compareZoneIds(a.zoneId, b.zoneId));

    // Key order here is the schema in docs/03-MEASUREMENT.md §2, and it is load-bearing:
    // JSON.stringify emits keys in insertion order, so this is what makes the file stable.
    return {
      anomalyId: spec.anomalyId,
      runId,
      kind: spec.kind,
      seed,
      onsetEventTime: spec.onsetEventTime,
      endEventTime: spec.endEventTime,
      origin: spec.origin,
      radiusKm: spec.radiusKm,
      propagation: spec.propagation,
      affectedZones
    };
  });
}

/** JSONL, LF-terminated. Explicitly not os.EOL — the bytes must match across platforms. */
export function serialiseGroundTruth(records: readonly GroundTruthRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}

export interface WrittenGroundTruth {
  groundTruthPath: string;
  manifestPath: string;
  recordCount: number;
  affectedZoneCount: number;
}

/**
 * Write the labels plus a sidecar manifest.
 *
 * The manifest is not part of the §2 schema and does not go in the JSONL — it is the run's
 * configuration, which the scorer needs for the metrics that are rates rather than set
 * comparisons. False-incident rate is per simulated hour, so the scorer has to know how many
 * simulated hours the run covered; it cannot infer that from the anomalies alone.
 */
export function writeGroundTruth(
  directory: string,
  options: GroundTruthOptions
): WrittenGroundTruth {
  const records = deriveGroundTruth(options);

  fs.mkdirSync(directory, { recursive: true });

  const groundTruthPath = path.join(directory, `${options.runId}.jsonl`);
  fs.writeFileSync(groundTruthPath, serialiseGroundTruth(records), 'utf8');

  const manifestPath = path.join(directory, `${options.runId}.meta.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(buildManifest(options, records), null, 2) + '\n', 'utf8');

  return {
    groundTruthPath,
    manifestPath,
    recordCount: records.length,
    affectedZoneCount: new Set(
      records.flatMap((record) => record.affectedZones.map((zone) => zone.zoneId))
    ).size
  };
}

function buildManifest(options: GroundTruthOptions, records: readonly GroundTruthRecord[]) {
  return {
    runId: options.runId,
    scenario: options.scenario,
    seed: options.seed,
    zoneCount: options.zones.length,
    startEventTime: options.startEpochMs,
    endEventTime: options.startEpochMs + options.runDurationMs,
    stepMs: options.stepMs,
    simulatedHours: round(options.runDurationMs / 3_600_000, 6),
    anomalyCount: records.length,
    affectedZoneCount: new Set(
      records.flatMap((record) => record.affectedZones.map((zone) => zone.zoneId))
    ).size,
    minAffectedSeverity: MIN_AFFECTED_SEVERITY,
    schema: 'docs/03-MEASUREMENT.md#2'
  };
}

/**
 * Zones an anomaly could plausibly reach, so the tick scan does not run over the whole field.
 *
 * For a stationary anomaly this is just the disc. For a propagating one the centre sweeps a
 * path, so the centre is sampled along it and a zone is a candidate if it comes within the
 * radius of any sample — plus half the distance between samples, so a zone the front passes
 * between two samples cannot be missed. The filter is allowed to be generous; it is only
 * allowed to be generous. A false positive here costs a few wasted ticks, a false negative
 * silently drops a zone from the labels.
 */
function candidateZones(
  spec: AnomalySpec,
  zones: readonly ZoneConfig[],
  stepMs: number
): ZoneConfig[] {
  if (!spec.propagation) {
    return zones.filter((zone) => haversineKm(zone, spec.origin) < spec.radiusKm);
  }

  const durationMs = Math.max(0, spec.endEventTime - spec.onsetEventTime);
  const sampleCount = Math.min(512, Math.max(2, Math.ceil(durationMs / Math.max(stepMs, 1))));
  const centres: LatLon[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    centres.push(centreAt(spec, spec.onsetEventTime + (durationMs * i) / sampleCount));
  }

  const travelKm = (spec.propagation.speedKmh * durationMs) / 3_600_000;
  const margin = spec.radiusKm + travelKm / sampleCount;

  return zones.filter((zone) => centres.some((centre) => haversineKm(zone, centre) < margin));
}

/** `Z-2` before `Z-10`: numeric where the ids are numeric, lexicographic otherwise. */
function compareZoneIds(a: string, b: string): number {
  const na = Number(a.replace(/^Z-/, ''));
  const nb = Number(b.replace(/^Z-/, ''));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
    return na - nb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function round(value: number, places: number): number {
  return parseFloat(value.toFixed(places));
}
