export interface SensorEvent {
  eventId: string;
  zoneId: string;
  latitude: number;
  longitude: number;
  load: number;
  eventTimestamp: number;
  producedAt: number;
}

/**
 * Peak-to-peak sensor jitter, as a fraction of the reported load: a value is drawn from
 * +/- SENSOR_NOISE_FACTOR/2 around the true level.
 *
 * It lives here rather than inside LoadGenerator because two modules need it and neither may
 * import the other: the generator applies it, and the ground-truth deriver has to know its
 * bound to decide the earliest instant a zone's load could have crossed a threshold. Copying
 * the number into both would be a silent-drift hazard in exactly the code whose whole job is
 * not to drift.
 */
export const SENSOR_NOISE_FACTOR = 0.1;

export interface ZoneConfig {
  zoneId: string;
  latitude: number;
  longitude: number;
  baseLoad: number;
}

/** How zones are placed on the map. See zoneGenerator.ts, and defect D9. */
export type ZoneLayout = 'global-spiral' | 'regional-grid';

export interface ZoneLayoutOptions {
  count: number;
  layout?: ZoneLayout;
  /** Seeds jitter and base loads for `regional-grid`. Unused by `global-spiral`. */
  seed?: number;
  regionCentreLat?: number;
  regionCentreLon?: number;
  regionExtentKm?: number;
}

/**
 * The three original load scenarios, plus the four eval scenarios required by
 * docs/03-MEASUREMENT.md §2.1. The last two are not optional garnish: `multi-anomaly` is the
 * only thing that catches over-grouping and `noise` is the only thing that catches hallucinated
 * incidents, and a suite without them would report excellent numbers for a system that merged
 * the whole map into one incident.
 */
export type ScenarioType =
  | 'normal'
  | 'spike'
  | 'drop'
  | 'regional-anomaly'
  | 'propagating-anomaly'
  | 'multi-anomaly'
  | 'noise';

export const ANOMALY_SCENARIOS: readonly ScenarioType[] = [
  'regional-anomaly',
  'propagating-anomaly',
  'multi-anomaly',
  'noise'
] as const;

export function isAnomalyScenario(scenario: ScenarioType): boolean {
  return ANOMALY_SCENARIOS.includes(scenario);
}

/** Straight-line movement of an anomaly's centre. Absent for a stationary anomaly. */
export interface PropagationSpec {
  bearingDeg: number;
  speedKmh: number;
}

/**
 * One injected fault, fully specified in physical and event-time units.
 *
 * Everything the generator and the ground-truth deriver need is here, and both read the same
 * struct through the same severity function — so the labels cannot drift from the stream.
 */
export interface AnomalySpec {
  anomalyId: string;
  kind: ScenarioType;
  origin: { latitude: number; longitude: number };
  radiusKm: number;
  /** Severity at the centre, once the ramp has completed. */
  peakSeverity: number;
  onsetEventTime: number;
  endEventTime: number;
  /** Simulated ms from onset to full severity. */
  rampMs: number;
  /** Simulated ms of fade before endEventTime. */
  decayMs: number;
  propagation: PropagationSpec | null;
}

export interface GroundTruthZone {
  zoneId: string;
  onsetEventTime: number;
  peakSeverity: number;
}

/** One JSONL line in evals/groundtruth/<run-id>.jsonl. Schema: docs/03-MEASUREMENT.md §2. */
export interface GroundTruthRecord {
  anomalyId: string;
  runId: string;
  kind: ScenarioType;
  seed: number;
  onsetEventTime: number;
  endEventTime: number;
  origin: { latitude: number; longitude: number };
  radiusKm: number;
  propagation: PropagationSpec | null;
  affectedZones: GroundTruthZone[];
}

export interface SimulatorConfig {
  numberOfZones: number;
  scenario: ScenarioType;
  logEveryNEvents: number;
  /** Simulated epoch the run starts at. Fixed by default so runs are comparable. */
  startEpochMs: number;
  /** Simulated milliseconds per tick; one event per zone per tick. */
  stepMs: number;
  /** Simulated milliseconds per real millisecond. 60 = a simulated minute per real second. */
  speedMultiplier: number;
  /** Seeds every arbitrary choice in the run. Embedded in the run id. */
  seed: number;
  zoneLayout: ZoneLayout;
  regionCentreLat: number;
  regionCentreLon: number;
  regionExtentKm: number;
  /** Simulated milliseconds the eval scenarios are planned over. */
  runDurationMs: number;
  /** Where ground truth is written. Relative paths resolve against the repo root. */
  groundTruthDir: string;
  /** Overrides the derived run id. Leave unset for a reproducible run id. */
  runIdOverride: string | null;
}
