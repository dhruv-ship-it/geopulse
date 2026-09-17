import { ScenarioType, SimulatorConfig, ZoneLayout, isAnomalyScenario } from './types';
import {
  DEFAULT_SIM_START_EPOCH_MS,
  DEFAULT_SIM_STEP_MS,
  DEFAULT_SPEED_MULTIPLIER
} from './virtualClock';
import { DEFAULT_RUN_DURATION_MS } from './scenarios';
import { ZoneGenerator } from './zoneGenerator';

export const DEFAULT_SEED = 42;

export const DEFAULT_CONFIG: SimulatorConfig = {
  numberOfZones: 10,
  scenario: 'normal',
  logEveryNEvents: 100,
  startEpochMs: DEFAULT_SIM_START_EPOCH_MS,
  stepMs: DEFAULT_SIM_STEP_MS,
  speedMultiplier: DEFAULT_SPEED_MULTIPLIER,
  seed: DEFAULT_SEED,
  zoneLayout: 'global-spiral',
  regionCentreLat: ZoneGenerator.DEFAULT_REGION_CENTRE_LAT,
  regionCentreLon: ZoneGenerator.DEFAULT_REGION_CENTRE_LON,
  regionExtentKm: ZoneGenerator.DEFAULT_REGION_EXTENT_KM,
  runDurationMs: DEFAULT_RUN_DURATION_MS,
  groundTruthDir: 'evals/groundtruth',
  runIdOverride: null,
  planOnly: false
};

const SCENARIOS: readonly ScenarioType[] = [
  'normal',
  'spike',
  'drop',
  'regional-anomaly',
  'propagating-anomaly',
  'multi-anomaly',
  'noise'
];

const ZONE_LAYOUTS: readonly ZoneLayout[] = ['global-spiral', 'regional-grid'];

/**
 * `EVENTS_PER_SECOND` is deliberately gone. It used to mean "timer firings per real second",
 * which conflated two independent things: how densely a zone is sampled in simulated time
 * (SIM_STEP_MS) and how fast simulated time runs (SPEED_MULTIPLIER). The real event rate is now
 * a derived quantity:
 *
 *   events per real second = NUM_ZONES * (1000 / SIM_STEP_MS) * SPEED_MULTIPLIER
 */
export function loadConfig(): SimulatorConfig {
  const scenario = parseEnum('SCENARIO', process.env.SCENARIO, SCENARIOS, 'normal');

  return {
    numberOfZones: parseInt(process.env.NUM_ZONES || '10', 10),
    scenario,
    logEveryNEvents: parseInt(process.env.LOG_EVERY_N || '100', 10),
    startEpochMs: parseInt(
      process.env.SIM_START_EPOCH_MS || String(DEFAULT_SIM_START_EPOCH_MS),
      10
    ),
    stepMs: parseInt(process.env.SIM_STEP_MS || String(DEFAULT_SIM_STEP_MS), 10),
    speedMultiplier: parseFloat(
      process.env.SPEED_MULTIPLIER || String(DEFAULT_SPEED_MULTIPLIER)
    ),
    seed: parseInt(process.env.SEED || String(DEFAULT_SEED), 10),
    zoneLayout: parseEnum(
      'ZONE_LAYOUT',
      process.env.ZONE_LAYOUT,
      ZONE_LAYOUTS,
      defaultLayoutFor(scenario)
    ),
    regionCentreLat: parseFloat(
      process.env.ZONE_REGION_CENTRE_LAT || String(ZoneGenerator.DEFAULT_REGION_CENTRE_LAT)
    ),
    regionCentreLon: parseFloat(
      process.env.ZONE_REGION_CENTRE_LON || String(ZoneGenerator.DEFAULT_REGION_CENTRE_LON)
    ),
    regionExtentKm: parseFloat(
      process.env.ZONE_REGION_EXTENT_KM || String(ZoneGenerator.DEFAULT_REGION_EXTENT_KM)
    ),
    runDurationMs: parseInt(
      process.env.RUN_DURATION_MS || String(DEFAULT_RUN_DURATION_MS),
      10
    ),
    groundTruthDir: process.env.GROUNDTRUTH_DIR || 'evals/groundtruth',
    runIdOverride: process.env.RUN_ID || null,
    planOnly: process.env.PLAN_ONLY === '1' || process.env.PLAN_ONLY === 'true'
  };
}

/**
 * An eval scenario defaults to the regional layout, because it cannot work without it.
 *
 * On the global spiral the closest pair of zones is 180 km apart even at 5000 zones (defect D9,
 * `benchmarks/results/d9-zone-spacing.txt`), so an 84 km anomaly covers one zone and there is
 * no correlation to measure. Defaulting by scenario means `SCENARIO=regional-anomaly` does the
 * right thing with no other configuration, while `normal` / `spike` / `drop` keep the layout
 * they have always had. An explicit ZONE_LAYOUT still wins over both.
 */
function defaultLayoutFor(scenario: ScenarioType): ZoneLayout {
  return isAnomalyScenario(scenario) ? 'regional-grid' : 'global-spiral';
}

/**
 * Fail on an unrecognised value rather than silently falling back. A typo in SCENARIO used to
 * cast straight to the union type and quietly run `normal`, which would have produced an eval
 * run with no anomalies in it and a ground-truth file with no records — a result that looks
 * like a detector scoring zero rather than like a misconfiguration.
 */
function parseEnum<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T
): T {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!allowed.includes(raw as T)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}; got '${raw}'`);
  }
  return raw as T;
}
