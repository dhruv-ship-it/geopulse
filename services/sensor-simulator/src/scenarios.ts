import { AnomalySpec, ScenarioType, ZoneConfig } from './types';
import { Prng } from './prng';
import { haversineKm, destinationPoint, LatLon } from './geo';

/**
 * The four eval scenarios required by docs/03-MEASUREMENT.md §2.1.
 *
 * Each builder is a pure function of (zones, seed, start, duration) and returns a list of
 * AnomalySpec. Nothing here reads the wall clock or Math.random; every arbitrary choice comes
 * from a named PRNG sub-stream, so a seed fixes the run completely and two seeds give genuinely
 * different geometry rather than the same anomaly nudged.
 *
 * Timings are expressed as fractions of the run rather than absolute milliseconds, so the same
 * scenario is meaningful whether you run four simulated hours or forty.
 *
 * Why the peak sits at 0.97 and the labelling cut at 0.85: severity maps straight onto load
 * (see loadGenerator), and the state machine calls STRESSED at a 5-minute average of 0.75 and
 * CRITICAL at a 1-minute average of 0.90. A 0.97 core therefore drives the middle of an anomaly
 * to CRITICAL and its edge to STRESSED, which is the shape a real regional fault has, and the
 * 0.85 cut sits far enough above 0.75 that the labelled set and the set that actually degrades
 * are the same set even after the load noise is applied.
 */

/** Severity at the centre of an injected anomaly, once ramped. */
export const DEFAULT_PEAK_SEVERITY = 0.97;

/** Simulated ms a full eval run covers by default: four simulated hours. */
export const DEFAULT_RUN_DURATION_MS = 4 * 60 * 60 * 1000;

/**
 * Two anomalies are only a valid over-grouping test if nothing could legitimately join them.
 * Their discs must be separated by at least this much clear ground — comfortably more than any
 * plausible H3 neighbour ring, so a correct engine has no excuse to merge them and an incorrect
 * one has nowhere to hide.
 */
export const MIN_DISJOINT_SEPARATION_KM = 100;

/** Noise zones must be at least this far apart, for the same reason. */
export const NOISE_MIN_SEPARATION_KM = 80;

/** Upper bound on a noise burst's radius. Kept small so a burst covers exactly one zone. */
export const NOISE_MAX_RADIUS_KM = 6;

export interface ScenarioContext {
  zones: readonly ZoneConfig[];
  seed: number;
  startEventTime: number;
  runDurationMs: number;
}

export function buildAnomalies(scenario: ScenarioType, ctx: ScenarioContext): AnomalySpec[] {
  switch (scenario) {
    case 'regional-anomaly':
      return buildRegional(ctx);
    case 'propagating-anomaly':
      return buildPropagating(ctx);
    case 'multi-anomaly':
      return buildMulti(ctx);
    case 'noise':
      return buildNoise(ctx);
    default:
      // normal / spike / drop are load profiles, not fault injections. No anomalies, and so no
      // ground truth — an eval run against them would have nothing to score.
      return [];
  }
}

// ------------------------------------------------------------------ regional

/**
 * One stationary regional fault. The baseline case: a single coherent event that the engine
 * must collapse into exactly one incident. The failure mode it catches is fragmentation.
 */
function buildRegional(ctx: ScenarioContext): AnomalySpec[] {
  const prng = Prng.forStream(ctx.seed, 'regional');
  const centre = fieldCentre(ctx.zones);
  const origin = jitterAround(prng, centre, 60);

  return [
    {
      anomalyId: 'A-001',
      kind: 'regional-anomaly',
      origin,
      radiusKm: round(prng.nextInRange(70, 95), 1),
      peakSeverity: DEFAULT_PEAK_SEVERITY,
      onsetEventTime: at(ctx, 0.15),
      endEventTime: at(ctx, 0.75),
      rampMs: 120_000,
      decayMs: 180_000,
      propagation: null
    }
  ];
}

// ------------------------------------------------------------------ propagating

/**
 * A front crossing the field at a known bearing and speed.
 *
 * The bearing is drawn rather than fixed because a vector estimator that only ever sees one
 * direction can be right by accident. Speed is in the range of a real weather front; the run is
 * long enough (four simulated hours by default) that the front actually traverses a meaningful
 * fraction of the field rather than wobbling in place — at 40 km/h that is 160 km across a
 * 400 km region, which is a genuine sweep.
 */
function buildPropagating(ctx: ScenarioContext): AnomalySpec[] {
  const prng = Prng.forStream(ctx.seed, 'propagating');
  const centre = fieldCentre(ctx.zones);

  const bearingDeg = round(prng.nextInRange(0, 360), 1);
  const speedKmh = round(prng.nextInRange(30, 55), 1);

  const onsetEventTime = at(ctx, 0.1);
  const endEventTime = at(ctx, 0.95);
  const travelKm = (speedKmh * (endEventTime - onsetEventTime)) / 3_600_000;

  // Enter from the upwind edge so the whole traverse happens over populated ground: start half
  // the journey back along the reciprocal bearing, and the front passes through the middle.
  const origin = destinationPoint(centre, (bearingDeg + 180) % 360, travelKm / 2);

  return [
    {
      anomalyId: 'A-001',
      kind: 'propagating-anomaly',
      origin: { latitude: round(origin.latitude, 6), longitude: round(origin.longitude, 6) },
      radiusKm: round(prng.nextInRange(55, 75), 1),
      peakSeverity: DEFAULT_PEAK_SEVERITY,
      onsetEventTime,
      endEventTime,
      rampMs: 120_000,
      decayMs: 180_000,
      propagation: { bearingDeg, speedKmh }
    }
  ];
}

// ------------------------------------------------------------------ multi

/**
 * Two disjoint regional faults, overlapping in time.
 *
 * This is the over-grouping test, and it is the reason the suite cannot be just the first two
 * scenarios: an engine that merges everything within a partition scores perfectly on
 * regional-anomaly and fails only here. The separation is asserted, not assumed — a future
 * tweak to the radii that let the two discs approach each other would destroy the test's
 * meaning silently, so it throws instead.
 */
function buildMulti(ctx: ScenarioContext): AnomalySpec[] {
  const prng = Prng.forStream(ctx.seed, 'multi');
  const centre = fieldCentre(ctx.zones);
  const extentKm = fieldExtentKm(ctx.zones);

  const axisBearing = round(prng.nextInRange(0, 360), 1);
  const offsetKm = Math.max(140, extentKm * 0.32);
  const radiusKm = round(prng.nextInRange(50, 65), 1);

  const originA = destinationPoint(centre, axisBearing, offsetKm);
  const originB = destinationPoint(centre, (axisBearing + 180) % 360, offsetKm);

  const clearanceKm = haversineKm(originA, originB) - 2 * radiusKm;
  if (clearanceKm < MIN_DISJOINT_SEPARATION_KM) {
    throw new Error(
      'multi-anomaly origins are only ' +
        clearanceKm.toFixed(1) +
        ' km of clear ground apart (need >= ' +
        MIN_DISJOINT_SEPARATION_KM +
        '); the scenario would stop testing over-grouping'
    );
  }

  const shared = {
    kind: 'multi-anomaly' as const,
    radiusKm,
    peakSeverity: DEFAULT_PEAK_SEVERITY,
    rampMs: 120_000,
    decayMs: 180_000,
    propagation: null
  };

  return [
    {
      ...shared,
      anomalyId: 'A-001',
      origin: { latitude: round(originA.latitude, 6), longitude: round(originA.longitude, 6) },
      onsetEventTime: at(ctx, 0.15),
      endEventTime: at(ctx, 0.6)
    },
    {
      // Deliberately staggered rather than simultaneous. Identical windows would let an engine
      // separate them on timing alone; offsetting them means the overlap is real but partial,
      // which is the harder and more realistic case.
      ...shared,
      anomalyId: 'A-002',
      origin: { latitude: round(originB.latitude, 6), longitude: round(originB.longitude, 6) },
      onsetEventTime: at(ctx, 0.3),
      endEventTime: at(ctx, 0.8)
    }
  ];
}

// ------------------------------------------------------------------ noise

/**
 * Scattered single-zone degradations with no regional structure at all.
 *
 * The honesty test. Every zone here degrades on its own, far from any other degrading zone, so
 * the correct number of incidents is zero. Each burst gets its own ground-truth record with a
 * single affected zone, which lets the scorer compute a false-incident rate directly.
 *
 * Each burst's radius is set from the distance to its zone's nearest neighbour, so a burst
 * provably cannot touch a second zone however the field happens to be jittered.
 */
function buildNoise(ctx: ScenarioContext): AnomalySpec[] {
  const prng = Prng.forStream(ctx.seed, 'noise');
  const target = Math.min(25, Math.max(4, Math.round(ctx.zones.length * 0.04)));

  const chosen: ZoneConfig[] = [];
  for (const zone of prng.shuffled(ctx.zones)) {
    if (chosen.length >= target) {
      break;
    }
    if (chosen.every((c) => haversineKm(c, zone) >= NOISE_MIN_SEPARATION_KM)) {
      chosen.push(zone);
    }
  }

  return chosen.map((zone, i) => {
    const nearestKm = nearestNeighbourKm(zone, ctx.zones);
    const radiusKm = round(Math.max(0.5, Math.min(NOISE_MAX_RADIUS_KM, nearestKm * 0.45)), 2);

    // Bursts start at scattered times and each lasts long enough that the zone really does
    // degrade — a burst too short to cross the state machine's confirmation window would be a
    // false-incident test the engine passes by never seeing anything.
    const onsetFraction = prng.nextInRange(0.1, 0.65);
    const durationFraction = prng.nextInRange(0.12, 0.2);

    return {
      anomalyId: 'N-' + String(i + 1).padStart(3, '0'),
      kind: 'noise' as const,
      origin: { latitude: zone.latitude, longitude: zone.longitude },
      radiusKm,
      peakSeverity: DEFAULT_PEAK_SEVERITY,
      onsetEventTime: at(ctx, onsetFraction),
      endEventTime: at(ctx, onsetFraction + durationFraction),
      rampMs: 60_000,
      decayMs: 60_000,
      propagation: null
    };
  });
}

// ------------------------------------------------------------------ helpers

/** Simulated instant at `fraction` through the run. */
function at(ctx: ScenarioContext, fraction: number): number {
  return ctx.startEventTime + Math.round(ctx.runDurationMs * Math.min(1, Math.max(0, fraction)));
}

/** Centroid of the zone field, so scenarios adapt to whatever layout is configured. */
export function fieldCentre(zones: readonly ZoneConfig[]): LatLon {
  if (zones.length === 0) {
    throw new Error('cannot build a scenario over an empty zone field');
  }
  // Mean of unit vectors, so a field spanning the antimeridian does not average to the
  // opposite side of the planet.
  const deg = Math.PI / 180;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const zone of zones) {
    const lat = zone.latitude * deg;
    const lon = zone.longitude * deg;
    x += Math.cos(lat) * Math.cos(lon);
    y += Math.cos(lat) * Math.sin(lon);
    z += Math.sin(lat);
  }
  x /= zones.length;
  y /= zones.length;
  z /= zones.length;

  return {
    latitude: (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI,
    longitude: (Math.atan2(y, x) * 180) / Math.PI
  };
}

/** Rough diameter of the field, as a multiple of the mean distance from its centre. */
function fieldExtentKm(zones: readonly ZoneConfig[]): number {
  const centre = fieldCentre(zones);
  const mean = zones.reduce((sum, z) => sum + haversineKm(z, centre), 0) / zones.length;
  return mean * 2.4;
}

function nearestNeighbourKm(zone: ZoneConfig, zones: readonly ZoneConfig[]): number {
  let best = Infinity;
  for (const other of zones) {
    if (other.zoneId === zone.zoneId) {
      continue;
    }
    const d = haversineKm(zone, other);
    if (d < best) {
      best = d;
    }
  }
  return Number.isFinite(best) ? best : NOISE_MAX_RADIUS_KM * 2;
}

function jitterAround(prng: Prng, centre: LatLon, maxKm: number): LatLon {
  const bearing = prng.nextInRange(0, 360);
  const distance = prng.nextInRange(0, maxKm);
  const moved = destinationPoint(centre, bearing, distance);
  return { latitude: round(moved.latitude, 6), longitude: round(moved.longitude, 6) };
}

function round(value: number, places: number): number {
  return parseFloat(value.toFixed(places));
}
