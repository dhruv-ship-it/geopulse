import { ZoneConfig, ZoneLayout, ZoneLayoutOptions } from './types';
import { Prng } from './prng';
import { destinationPoint } from './geo';

/**
 * Places the simulated zones on the map.
 *
 * Two layouts, because they answer two different questions.
 *
 * `global-spiral` — the original: a fibonacci spiral over the whole planet. Even coverage, no
 * clustering, and it was the right shape for a pipeline demo where geography was decorative.
 *
 * `regional-grid` — added for the eval scenarios, and for defect D9. Measured on the spiral
 * (`benchmarks/results/d9-zone-spacing.txt`), the closest pair of zones is 4330 km apart at 10
 * zones and still 180 km apart at 5000: *zero* pairs fall within 84 km at any scale we would
 * actually run. That makes spatial correlation unmeasurable rather than merely hard — an 84 km
 * regional anomaly would contain one zone, every H3 neighbour ring would come back empty, and
 * every connected component would be a singleton. The engine would score a perfect zero and we
 * would have learned nothing. Anomalies are regional phenomena, so the zone field has to be
 * regional too.
 *
 * Determinism: both layouts are pure functions of their inputs. The grid's jitter and base
 * loads are drawn from a named PRNG sub-stream seeded by the run seed, so the field is fixed
 * for a seed and genuinely different between seeds.
 */
export class ZoneGenerator {
  private static readonly WORLD_MIN_LAT = -85;
  private static readonly WORLD_MAX_LAT = 85;

  /** Default region centre: near Berlin, matching the worked example in docs/03-MEASUREMENT.md. */
  static readonly DEFAULT_REGION_CENTRE_LAT = 52.31;
  static readonly DEFAULT_REGION_CENTRE_LON = 13.04;

  /** Side of the square the regional layout fills, in kilometres. */
  static readonly DEFAULT_REGION_EXTENT_KM = 400;

  /**
   * Jitter as a fraction of the grid pitch. A perfect lattice is a bad test bed: zones land on
   * H3 cell boundaries in a repeating pattern, every cell ends up with identical occupancy, and
   * the neighbour graph looks far more regular than any real deployment. A little jitter breaks
   * that without making spacing unpredictable.
   */
  static readonly JITTER_FRACTION = 0.35;

  /** Back-compatible entry point: the original global spiral. */
  static generateZones(count: number): ZoneConfig[] {
    return this.generate({ count, layout: 'global-spiral' });
  }

  static generate(options: ZoneLayoutOptions): ZoneConfig[] {
    const layout: ZoneLayout = options.layout ?? 'global-spiral';
    return layout === 'regional-grid' ? this.regionalGrid(options) : this.globalSpiral(options.count);
  }

  // ---------------------------------------------------------------- global spiral

  private static globalSpiral(count: number): ZoneConfig[] {
    const zones: ZoneConfig[] = [];

    for (let i = 0; i < count; i++) {
      const lat = this.calculateLatitude(i, count);
      const lon = this.calculateLongitude(i);
      const baseLoad = this.calculateBaseLoad(i);

      zones.push({
        zoneId: `Z-${i + 1}`,
        latitude: parseFloat(lat.toFixed(6)),
        longitude: parseFloat(lon.toFixed(6)),
        baseLoad: parseFloat(baseLoad.toFixed(3))
      });
    }

    return zones;
  }

  /**
   * Calculate latitude using fibonacci spiral for even distribution
   */
  private static calculateLatitude(index: number, total: number): number {
    const y = total === 1 ? 0 : 1 - (index / (total - 1)) * 2; // y goes from 1 to -1
    const latDeg = (Math.asin(y) * 180) / Math.PI;

    return Math.max(this.WORLD_MIN_LAT, Math.min(this.WORLD_MAX_LAT, latDeg));
  }

  /**
   * Calculate longitude using fibonacci spiral
   */
  private static calculateLongitude(index: number): number {
    const phi = Math.PI * (3 - Math.sqrt(5)); // Golden angle
    const lonDeg = (phi * index * 180) / Math.PI;

    return ((lonDeg + 540) % 360) - 180;
  }

  /**
   * Calculate base load with deterministic variation
   * Creates realistic load patterns (urban vs rural, different regions)
   */
  private static calculateBaseLoad(index: number): number {
    const seed = (index * 137) % 1000;

    let baseLoad = 0.2 + (seed % 300) / 1000; // 0.2 to 0.5 base

    if (index % 7 === 0) baseLoad += 0.15; // Urban areas
    if (index % 11 === 0) baseLoad -= 0.1; // Rural areas
    if (index % 13 === 0) baseLoad += 0.25; // High activity zones

    return Math.max(0.05, Math.min(0.95, baseLoad));
  }

  // ---------------------------------------------------------------- regional grid

  /**
   * `count` zones on a jittered near-square grid filling an `extentKm` box around a centre.
   *
   * Positions are stepped with great-circle displacement rather than by adding degrees, so the
   * north-south and east-west pitch are both the stated number of kilometres at the region's
   * latitude. Adding degrees would have made the field 1.6x narrower in physical terms at 52°N
   * than at the equator, and every distance-parameterised anomaly would then cover a different
   * number of zones depending on where the region happened to be.
   */
  private static regionalGrid(options: ZoneLayoutOptions): ZoneConfig[] {
    const { count } = options;
    const centre = {
      latitude: options.regionCentreLat ?? this.DEFAULT_REGION_CENTRE_LAT,
      longitude: options.regionCentreLon ?? this.DEFAULT_REGION_CENTRE_LON
    };
    const extentKm = options.regionExtentKm ?? this.DEFAULT_REGION_EXTENT_KM;
    const prng = Prng.forStream(options.seed ?? 0, 'zone-layout');

    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const pitchX = cols > 1 ? extentKm / (cols - 1) : 0;
    const pitchY = rows > 1 ? extentKm / (rows - 1) : 0;

    const zones: ZoneConfig[] = [];

    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;

      // Offsets from the centre, in km, before jitter.
      const eastKm = cols > 1 ? col * pitchX - extentKm / 2 : 0;
      const northKm = rows > 1 ? row * pitchY - extentKm / 2 : 0;

      const jitterX = (prng.nextFloat() - 0.5) * 2 * this.JITTER_FRACTION * (pitchX || extentKm);
      const jitterY = (prng.nextFloat() - 0.5) * 2 * this.JITTER_FRACTION * (pitchY || extentKm);

      const movedNorth = this.offsetKm(centre, 0, northKm + jitterY);
      const position = this.offsetKm(movedNorth, 90, eastKm + jitterX);

      zones.push({
        zoneId: `Z-${i + 1}`,
        latitude: parseFloat(position.latitude.toFixed(6)),
        longitude: parseFloat(position.longitude.toFixed(6)),
        // i.i.d., not the index-modulo pattern the spiral uses. On a grid, `index % 7` lays
        // down diagonal stripes of high-baseline zones — spatially correlated baseline load,
        // which is precisely the structure the correlation engine is supposed to find only
        // when an anomaly put it there. Drawing independently keeps the null case null.
        baseLoad: parseFloat(prng.nextInRange(0.2, 0.5).toFixed(3))
      });
    }

    return zones;
  }

  /** Signed great-circle offset: negative distance means the reciprocal bearing. */
  private static offsetKm(from: { latitude: number; longitude: number }, bearingDeg: number, km: number) {
    if (km === 0) {
      return from;
    }
    return km > 0
      ? destinationPoint(from, bearingDeg, km)
      : destinationPoint(from, (bearingDeg + 180) % 360, -km);
  }
}
