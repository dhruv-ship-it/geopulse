import { AnomalySpec, ZoneConfig, SENSOR_NOISE_FACTOR } from './types';
import { haversineKm, destinationPoint, LatLon } from './geo';

/**
 * The injected-fault model: how much an anomaly is stressing a given zone at a given instant
 * of simulated time.
 *
 * There is exactly one severity function, and both the event generator and the ground-truth
 * deriver call it. That is the whole design. The alternative — generate events one way, then
 * write labels describing what we believe we generated — is how eval harnesses quietly start
 * measuring the gap between two implementations of the same idea instead of measuring the
 * detector. Here a label and an event literally cannot disagree, because there is nothing for
 * them to disagree about.
 *
 * Severity is dimensionless, in [0, 1], and separates cleanly into two factors:
 *
 *     severity(zone, t) = spatialFactor(distance to centre at t) * temporalFactor(t) * peak
 *
 * which is what makes the scenarios explainable in one sentence each, and what makes a zone's
 * onset time something you can reason about rather than something you have to observe.
 */

/**
 * Fraction of the radius that sits at full strength before the edge starts to fall away.
 *
 * A pure linear falloff from the centre would leave most in-radius zones at low severity, so
 * "affected" would be dominated by zones that were barely nudged — and recall would then be
 * measuring the injector's soft edge rather than the detector's fragmentation. A plateau with a
 * short skirt keeps the affected set unambiguous while still giving the edge a gradient, which
 * is what a real regional fault looks like.
 */
export const CORE_FRACTION = 0.85;

/**
 * The severity below which a zone is not called affected.
 *
 * This is a labelling threshold, not a physical one, and where it sits is the difference
 * between labels that mean something and labels that do not. Severity maps straight onto load,
 * the state machine calls STRESSED at a 5-minute average of 0.75, and the sensor noise is +/-5%
 * — so a cut at 0.85 puts the weakest labelled zone at a load of about 0.81 even on an unlucky
 * sample, comfortably degrading. A cut below 0.79 would start labelling zones that never cross
 * the threshold at all, and recall would then be measuring the injector's soft edge rather than
 * the detector.
 *
 * With the profile above that makes the labelled disc about 0.87 of radiusKm: the outermost
 * sliver of the skirt is nudged but not degraded, and is deliberately left unlabelled. The
 * record still carries radiusKm as the geometric parameter; affectedZones is the claim.
 *
 * None of this is assumed — groundTruth.test.ts asserts against the emitted stream that every
 * labelled zone sustains a degrading load and no unlabelled zone does.
 */
export const MIN_AFFECTED_SEVERITY = 0.85;

/**
 * The load at which a zone counts as degrading. Mirrors `THRESHOLD_STRESSED` in
 * stream-processor/src/stateMachine.ts; if that moves, this moves with it.
 */
export const DEGRADING_LOAD = 0.75;

/**
 * The severity at which a zone's *onset* is recorded — a separate job from deciding membership,
 * and the two need separate thresholds.
 *
 * Membership asks "did this anomaly take the zone over", and MIN_AFFECTED_SEVERITY answers it.
 * Onset asks "from when was it showing", and answering that with the membership cut is wrong in
 * a way that matters: severity climbs through the ramp, so a zone's load crosses the degradation
 * threshold roughly twelve seconds before severity reaches 0.85. Labelling the later instant
 * would shorten every measured time-to-detect by that much — a bias in the flattering
 * direction, in the one metric this project has least room to be generous about.
 *
 * So onset is pinned to the earliest instant the zone's load *could* have crossed DEGRADING_LOAD,
 * which given the sensor's bounded jitter is a severity of DEGRADING_LOAD / (1 + noise/2). Any
 * error is then in the conservative direction: the label can be a tick or two early, never late.
 */
export const ONSET_SEVERITY = DEGRADING_LOAD / (1 + SENSOR_NOISE_FACTOR / 2);

/** Where the anomaly's centre is at simulated time `t`. Stationary unless it propagates. */
export function centreAt(spec: AnomalySpec, t: number): LatLon {
  if (!spec.propagation) {
    return spec.origin;
  }
  const elapsedHours = Math.max(0, t - spec.onsetEventTime) / 3_600_000;
  const travelledKm = spec.propagation.speedKmh * elapsedHours;
  if (travelledKm === 0) {
    return spec.origin;
  }
  return destinationPoint(spec.origin, spec.propagation.bearingDeg, travelledKm);
}

/** Radial profile: 1 inside the core, falling linearly towards the radius, 0 beyond it. */
export function spatialFactor(distanceKm: number, radiusKm: number): number {
  if (distanceKm >= radiusKm) {
    return 0;
  }
  const coreKm = radiusKm * CORE_FRACTION;
  if (distanceKm <= coreKm) {
    return 1;
  }
  return (radiusKm - distanceKm) / (radiusKm - coreKm);
}

/**
 * The severity a zone settles at once the anomaly has fully ramped — the radial gradient, but
 * floored so it never lands between "clearly degrading" and "clearly untouched".
 *
 * This floor is the fix for a genuine problem, and it is worth being explicit about because it
 * is the one place the injector is deliberately less realistic than nature.
 *
 * A pure gradient falling to zero at the radius necessarily passes through the band where a
 * zone's load hovers around the STRESSED threshold. Zones in that band degrade on some ticks
 * and not others; whichever side of the label cut they are put, they are wrong roughly half the
 * time. Measured on a 400-zone field, that annulus held 2-3 of ~50 zones per anomaly — a
 * 5% ceiling on membership precision that belongs to the fault injector, not to the detector,
 * and that no amount of tuning the correlation engine could ever recover.
 *
 * Flooring the plateau at MIN_AFFECTED_SEVERITY removes the band entirely: inside the radius a
 * zone is at 0.85 or above and degrades, outside it is at exactly zero and does not. The cost
 * is that the anomaly has a hard edge, where a real regional fault has a fuzzy one. That is the
 * right trade here: the fuzzy edge buys realism the correlation engine cannot benefit from, and
 * sells label precision the measurement depends on. The interior gradient — 0.97 at the core
 * falling to 0.85 at the rim — is kept, so the severity field still has structure.
 */
export function plateauSeverity(spec: AnomalySpec, distanceKm: number): number {
  const spatial = spatialFactor(distanceKm, spec.radiusKm);
  if (spatial === 0) {
    return 0;
  }
  return Math.max(MIN_AFFECTED_SEVERITY, spec.peakSeverity * spatial);
}

/** Envelope in time: ramp up, hold, decay. Zero outside [onset, end). */
export function temporalFactor(spec: AnomalySpec, t: number): number {
  if (t < spec.onsetEventTime || t >= spec.endEventTime) {
    return 0;
  }

  const sinceOnset = t - spec.onsetEventTime;
  const untilEnd = spec.endEventTime - t;

  const rising = spec.rampMs > 0 ? Math.min(1, sinceOnset / spec.rampMs) : 1;
  const falling = spec.decayMs > 0 ? Math.min(1, untilEnd / spec.decayMs) : 1;

  return Math.max(0, Math.min(rising, falling));
}

/** Severity this anomaly imposes on this zone at this instant, in [0, 1]. */
export function severityAt(spec: AnomalySpec, zone: ZoneConfig, t: number): number {
  const temporal = temporalFactor(spec, t);
  if (temporal === 0) {
    return 0;
  }
  const plateau = plateauSeverity(spec, haversineKm(zone, centreAt(spec, t)));
  if (plateau === 0) {
    return 0;
  }
  return plateau * temporal;
}

/**
 * Combined severity across every active anomaly, as a maximum rather than a sum.
 *
 * Summing would let two anomalies that merely happen to overlap produce a *more* severe zone
 * than either alone, which then reads as evidence of a single larger event — the system would
 * be handed the over-grouping conclusion in its input rather than being tested on it. A maximum
 * says "whichever fault is hurting this zone most is what you observe", keeps severity in
 * [0, 1] without renormalising, and keeps each anomaly's contribution attributable.
 */
export function combinedSeverity(
  specs: readonly AnomalySpec[],
  zone: ZoneConfig,
  t: number
): number {
  let worst = 0;
  for (const spec of specs) {
    const severity = severityAt(spec, zone, t);
    if (severity > worst) {
      worst = severity;
    }
  }
  return worst;
}
