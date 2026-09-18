import { LatLon, haversineKm } from '@geopulse/spatial';

import { IncidentFootprint } from './types';

export interface ZonePosition extends LatLon {
  zoneId: string;
  h3Cell: string;
}

/**
 * Where an incident is, and how big it is.
 *
 * ## Centroid: a mean of unit vectors, not a mean of coordinates
 *
 * Averaging latitude and longitude componentwise is wrong near the antimeridian and wrong at the
 * poles, and it is wrong in the worst way — it produces a plausible number. Two zones at +179.9°
 * and -179.9° are 22 km apart; the componentwise mean puts their centre at 0° longitude, in the
 * Gulf of Guinea, about 20,000 km from either of them. `packages/spatial` already tests
 * adjacency across the antimeridian and at the twelve pentagons, so an incident genuinely can
 * straddle the line, and a footprint that lands in the wrong hemisphere would then be drawn on
 * the map and believed.
 *
 * So each member is converted to a unit vector on the sphere, the vectors are averaged, and the
 * result is converted back. The seam disappears because the representation has no seam. This is
 * the standard construction for a spherical mean and it costs three multiplies per member.
 *
 * It has one genuine degeneracy: members spread evenly enough that the vector sum is near zero
 * — antipodal pairs, or a ring around the globe — have no meaningful centre. That cannot arise
 * for an incident, whose members are by construction within one H3 ring of each other, but it is
 * guarded rather than assumed, and the guard falls back to the first member's position so the
 * footprint is still *somewhere real*.
 *
 * ## Radius: the maximum, not the mean
 *
 * `radiusKm` is the distance from the centroid to the furthest member. A footprint is a claim
 * about what is affected, so it has to contain all of it; a mean or a 95th percentile would draw
 * a circle that visibly excludes zones the same event lists as members, which reads as a bug
 * whether or not it is one. The consequence is that one distant member inflates the radius, and
 * that is the correct signal: an incident whose radius jumps is an incident that has reached
 * somewhere new.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export function centroidOf(positions: readonly LatLon[]): LatLon {
  if (positions.length === 0) {
    throw new Error('centroidOf requires at least one position');
  }
  if (positions.length === 1) {
    return { latitude: positions[0].latitude, longitude: positions[0].longitude };
  }

  let x = 0;
  let y = 0;
  let z = 0;

  for (const position of positions) {
    const lat = position.latitude * DEG;
    const lon = position.longitude * DEG;
    const cosLat = Math.cos(lat);
    x += cosLat * Math.cos(lon);
    y += cosLat * Math.sin(lon);
    z += Math.sin(lat);
  }

  x /= positions.length;
  y /= positions.length;
  z /= positions.length;

  // Degenerate: the vectors cancelled. No centre exists; say so by falling back rather than
  // returning atan2(0, 0), which is 0 and looks like a real answer off the coast of Africa.
  const norm = Math.sqrt(x * x + y * y + z * z);
  if (norm < 1e-12) {
    return { latitude: positions[0].latitude, longitude: positions[0].longitude };
  }

  return {
    latitude: Math.atan2(z, Math.sqrt(x * x + y * y)) * RAD,
    longitude: Math.atan2(y, x) * RAD
  };
}

/** Distance from the centroid to the furthest member. Zero for a single member. */
export function radiusKm(centroid: LatLon, positions: readonly LatLon[]): number {
  let furthest = 0;
  for (const position of positions) {
    const distance = haversineKm(centroid, position);
    if (distance > furthest) {
      furthest = distance;
    }
  }
  return furthest;
}

/**
 * The full footprint. `h3Cells` is deduplicated and sorted — several zones routinely share a
 * cell, and a consumer drawing hexes wants each one once. Sorted because every artefact this
 * project emits has to be replay-stable (CLAUDE.md rule 3); an incident's footprint rendered in
 * Map insertion order would make two identical runs produce different bytes.
 */
export function footprintOf(positions: readonly ZonePosition[]): IncidentFootprint {
  if (positions.length === 0) {
    return {
      h3Cells: [],
      centroid: { latitude: 0, longitude: 0 },
      radiusKm: 0
    };
  }

  const centroid = centroidOf(positions);
  const cells = new Set<string>();
  for (const position of positions) {
    if (position.h3Cell) {
      cells.add(position.h3Cell);
    }
  }

  return {
    h3Cells: [...cells].sort(),
    centroid,
    radiusKm: radiusKm(centroid, positions)
  };
}

/** Round-trip-safe rendering for Redis, which stores strings. */
export function roundCoordinate(value: number): number {
  // Six decimal places is about 11 cm at the equator, far finer than any sensor's position is
  // known to, and it keeps the value short enough to read in redis-cli.
  return Math.round(value * 1e6) / 1e6;
}
