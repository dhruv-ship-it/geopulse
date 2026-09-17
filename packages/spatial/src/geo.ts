/**
 * Spherical geometry — the small amount the spatial layer needs, and the reference the
 * neighbour graph is measured against.
 *
 * A sphere, not WGS84: the error against a true ellipsoid is about 0.3%, far below anything an
 * 8 km H3 cell is sensitive to, and a spherical model is exactly reproducible in a few lines
 * rather than depending on a geodesy library's version.
 *
 * `services/sensor-simulator/src/geo.ts` carries the same formula. That duplication is
 * deliberate and it is only ever going to be these few lines: this package must not depend on
 * a service (the dependency runs the other way), and the oracle a test measures an
 * implementation against should not share code with it in any case — a shared bug would make
 * both agree and the test pass.
 */

export const EARTH_RADIUS_KM = 6371.0088;

const DEG = Math.PI / 180;

export interface LatLon {
  latitude: number;
  longitude: number;
}

/** Great-circle distance in kilometres, by the haversine formula. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = (b.latitude - a.latitude) * DEG;
  const dLon = (b.longitude - a.longitude) * DEG;
  const lat1 = a.latitude * DEG;
  const lat2 = b.latitude * DEG;

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
