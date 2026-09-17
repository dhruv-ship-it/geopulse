import { latLngToCell } from 'h3-js';

/**
 * H3 resolutions.
 *
 * H3_RESOLUTION is the detection resolution — it defines what "adjacent" means to the
 * correlation engine. Res 5 cells have an average edge length of roughly 8 km.
 *
 * H3_COARSE_RESOLUTION is the partition-key resolution. Res 3 cells (~60 km edge) are much
 * larger than a plausible incident radius, so nearly every incident stays inside one coarse
 * cell and therefore inside one Kafka partition. See docs/01-ARCHITECTURE.md §6.
 *
 * WP0 only computes and stores these. The neighbour graph that consumes them is WP1.
 */
export const H3_RESOLUTION = parseInt(process.env.H3_RESOLUTION || '5', 10);
export const H3_COARSE_RESOLUTION = parseInt(process.env.H3_COARSE_RESOLUTION || '3', 10);

export interface ZoneCells {
  h3Cell: string;
  h3CoarseCell: string;
}

/**
 * Map a coordinate to its detection and partition cells.
 *
 * Pure and deterministic: same lat/lon always yields the same pair, which is what makes
 * replays reproducible.
 */
export function cellsFor(
  latitude: number,
  longitude: number,
  resolution: number = H3_RESOLUTION,
  coarseResolution: number = H3_COARSE_RESOLUTION
): ZoneCells {
  return {
    h3Cell: latLngToCell(latitude, longitude, resolution),
    h3CoarseCell: latLngToCell(latitude, longitude, coarseResolution)
  };
}
