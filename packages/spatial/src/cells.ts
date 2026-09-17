import { latLngToCell } from 'h3-js';

/**
 * H3 resolutions.
 *
 * H3_RESOLUTION is the detection resolution — it defines what "adjacent" means to the
 * correlation engine. Res 5 cells have an average edge length of roughly 8 km, so a one-ring
 * neighbourhood reaches about 25 km.
 *
 * H3_COARSE_RESOLUTION is the partition-key resolution. Res 3 cells (~60 km edge) are much
 * larger than a plausible incident radius, so nearly every incident stays inside one coarse
 * cell and therefore inside one Kafka partition. See docs/01-ARCHITECTURE.md §6.
 *
 * These are read once, at module load, from the environment. Every process in the pipeline
 * must agree on them: `stream-processor` computes a zone's cells at registration and the
 * correlation engine builds adjacency from those cells, so a process that disagrees about the
 * resolution does not fail — it silently correlates over a geometry nobody indexed for.
 * That is the whole reason this module lives in a shared package (see ./index.ts).
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
