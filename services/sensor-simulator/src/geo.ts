/**
 * Spherical geometry, in the small amount this simulator needs.
 *
 * Anomalies are defined in physical units — "a fault covering 80 km around this point, moving
 * north-east at 40 km/h" — because that is the language the correlation engine will eventually
 * have to be judged in, and because degrees of longitude are not a distance. The eval would be
 * meaningless if an 80 km anomaly at the equator covered a different set of zones than the same
 * anomaly at 60°N.
 *
 * A sphere, not WGS84. The error against a true ellipsoid is about 0.3%, which is far below
 * anything the correlation window or the H3 cell size is sensitive to, and a spherical model is
 * exactly reproducible in a few lines rather than depending on a geodesy library's version.
 * That trade is recorded in docs/adr/ADR-006-ground-truth-by-construction.md.
 */

export const EARTH_RADIUS_KM = 6371.0088;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

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

/**
 * The point `distanceKm` along the great circle from `origin` on the given compass bearing
 * (0 = north, 90 = east). This is what moves a propagating anomaly's centre: a front travelling
 * at a constant bearing and speed follows a great circle, so stepping it this way keeps its
 * speed constant in kilometres per hour rather than in degrees per hour.
 */
export function destinationPoint(origin: LatLon, bearingDeg: number, distanceKm: number): LatLon {
  const angular = distanceKm / EARTH_RADIUS_KM;
  const bearing = bearingDeg * DEG;
  const lat1 = origin.latitude * DEG;
  const lon1 = origin.longitude * DEG;

  const sinLat2 =
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing);
  const lat2 = Math.asin(Math.min(1, Math.max(-1, sinLat2)));

  const y = Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1);
  const x = Math.cos(angular) - Math.sin(lat1) * sinLat2;
  const lon2 = lon1 + Math.atan2(y, x);

  return {
    latitude: lat2 * RAD,
    longitude: normaliseLongitude(lon2 * RAD)
  };
}

/** Fold a longitude back into [-180, 180). Anomalies are allowed to cross the antimeridian. */
export function normaliseLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
