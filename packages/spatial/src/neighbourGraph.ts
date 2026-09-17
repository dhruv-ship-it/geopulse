import { getResolution, gridDisk, isValidCell } from 'h3-js';
import { H3_RESOLUTION, cellsFor } from './cells';

/**
 * Size of the neighbourhood, in H3 rings. 1 means "this cell and the six cells touching it",
 * which at resolution 5 reaches roughly 25 km.
 *
 * This is the second half of the adjacency definition — the first half is H3_RESOLUTION — and
 * like the resolution it has to be identical in every process that reasons about incidents.
 */
export const NEIGHBOUR_RING_SIZE = parseInt(process.env.NEIGHBOUR_RING_SIZE || '1', 10);

/**
 * The minimum a zone has to supply to be placed in the graph. `ZoneRegistryEntry` from the
 * Redis registry satisfies it structurally, which is the point: the graph is built straight
 * from `zones:registry` without a translation layer in between.
 */
export interface ZoneLocation {
  zoneId: string;
  latitude: number;
  longitude: number;
  /** Optional: the cell `stream-processor` already computed and stored at registration. */
  h3Cell?: string;
}

export interface NeighbourGraphOptions {
  /** Detection resolution. Defaults to H3_RESOLUTION. */
  resolution?: number;
  /** Neighbourhood radius in rings. Defaults to NEIGHBOUR_RING_SIZE. 0 means same-cell only. */
  ringSize?: number;
}

export interface NeighbourGraphStats {
  zones: number;
  occupiedCells: number;
  /** Cells whose neighbourhood has been computed and cached. */
  cachedDisks: number;
  /**
   * Zones whose stored `h3Cell` was ignored and recomputed from the coordinate, because it was
   * malformed or at the wrong resolution. Non-zero means some producer disagrees with this
   * process about the geometry — see `addZone`.
   */
  recomputedCells: number;
}

const NO_ZONES: readonly string[] = Object.freeze([]);

/**
 * Which zones are close enough to each other to be part of the same incident.
 *
 * The whole of Phase 1 rests on this being cheap. The correlation engine asks "who is adjacent
 * to the zone that just degraded?" once per degradation event, on the hot path, and the answer
 * must not get more expensive as the deployment grows — a fleet of 100k zones has no more
 * neighbours around any one of them than a fleet of 1k spread over the same ground.
 *
 * So adjacency is precomputed into the *address* rather than measured at query time. A zone's
 * H3 cell is a function of its coordinate alone; the cells around that cell are a function of
 * that cell alone. Neither depends on the other zones. What is left at query time is a handful
 * of hash lookups:
 *
 *     neighboursOf(z)  =  concat( occupants(c) for c in disk(cell(z), k) )  minus  z
 *
 * `disk(cell, k)` has 1 + 3k(k+1) members — 7 cells at k=1, 19 at k=2 — fixed, whatever the
 * zone count. The cost is therefore O(cells in the disk + neighbours returned), and the second
 * term is the size of the answer, which no implementation can avoid paying. Compare the naive
 * alternative, a haversine scan over every zone: O(n) per lookup, where n is exactly the number
 * this system is supposed to scale in. `benchmarks/neighbour-graph.ts` measures both.
 *
 * Rationale for H3 over geohash, k-d/R-trees and a raw distance scan, and for hexagons over
 * squares, is in `docs/adr/ADR-001-h3-vs-alternatives.md`.
 *
 * Deterministic by construction (CLAUDE.md rule 3): no clock, no randomness, and a fixed
 * iteration order, so the same registry always yields the same neighbour list in the same
 * order. The correlation engine builds connected components by walking these lists, and a
 * replay that visited neighbours in a different order could merge them in a different order.
 */
export class NeighbourGraph {
  private readonly resolution: number;
  private readonly ringSize: number;

  /** cell -> zones in it, in insertion order. The occupancy index. */
  private readonly occupancy = new Map<string, string[]>();

  /** zone -> its cell. Lets neighboursOf start from a zone id without a coordinate. */
  private readonly zoneCell = new Map<string, string>();

  /**
   * cell -> the cells within `ringSize` of it, including itself.
   *
   * Safe to cache and never invalidate: it is pure geometry. Which cells surround a cell does
   * not depend on which zones exist, so adding a zone can never make a cached disk wrong —
   * only the occupancy it is read against changes. Bounded by the number of *occupied* cells,
   * since a disk is only ever computed for a cell that holds a zone.
   */
  private readonly diskCache = new Map<string, string[]>();

  private recomputedCells = 0;

  constructor(options: NeighbourGraphOptions = {}) {
    const resolution = options.resolution ?? H3_RESOLUTION;
    const ringSize = options.ringSize ?? NEIGHBOUR_RING_SIZE;

    if (!Number.isInteger(resolution) || resolution < 0 || resolution > 15) {
      throw new Error(`resolution must be an integer in [0, 15], got ${resolution}`);
    }
    if (!Number.isInteger(ringSize) || ringSize < 0) {
      throw new Error(`ringSize must be a non-negative integer, got ${ringSize}`);
    }

    this.resolution = resolution;
    this.ringSize = ringSize;
  }

  /**
   * Replace the graph's contents with `zones`.
   *
   * Used at startup, after reading the registry. The disk cache survives, because it describes
   * geometry rather than contents.
   */
  build(zones: readonly ZoneLocation[]): void {
    this.occupancy.clear();
    this.zoneCell.clear();
    this.recomputedCells = 0;
    for (const zone of zones) {
      this.addZone(zone);
    }
  }

  /**
   * Add a zone, or move one that is already known. Returns the cell it landed in.
   *
   * Incremental because zones appear at runtime: `stream-processor` registers a zone the first
   * time it sees an event from it, and the correlation engine finds out by reading that. A
   * graph that could only be built in one shot would either miss those zones until the next
   * restart, or force a full rebuild per discovery.
   *
   * The zone's stored `h3Cell` is used when it is valid *and at this graph's resolution*, and
   * recomputed from the coordinate otherwise. Trusting it blindly would let a producer running
   * a different H3_RESOLUTION poison adjacency with no error anywhere: res-6 cell ids are
   * perfectly valid H3 indices, they are simply in a different tiling, so every lookup against
   * them would return an empty neighbour list and every incident would collapse to a singleton.
   * Recomputing is cheap, and `stats().recomputedCells` makes the disagreement visible instead
   * of silent.
   */
  addZone(zone: ZoneLocation): string {
    const cell = this.cellFor(zone);

    const previous = this.zoneCell.get(zone.zoneId);
    if (previous === cell) {
      return cell;
    }
    if (previous !== undefined) {
      this.removeFromCell(previous, zone.zoneId);
    }

    const occupants = this.occupancy.get(cell);
    if (occupants === undefined) {
      this.occupancy.set(cell, [zone.zoneId]);
    } else {
      occupants.push(zone.zoneId);
    }
    this.zoneCell.set(zone.zoneId, cell);

    return cell;
  }

  /**
   * The zones adjacent to `zoneId` — same cell, or within `ringSize` cells of it. Never
   * includes the zone itself.
   *
   * An unknown zone returns empty rather than throwing. The correlation engine learns about
   * zones and about degradations from two different streams, so it can legitimately see a
   * degradation for a zone it has not been told about yet; "no known neighbours" is the
   * truthful answer at that moment, and it changes as soon as the registration arrives.
   */
  neighboursOf(zoneId: string): string[] {
    const cell = this.zoneCell.get(zoneId);
    if (cell === undefined) {
      return [];
    }

    const neighbours: string[] = [];
    for (const nearbyCell of this.diskOf(cell)) {
      const occupants = this.occupancy.get(nearbyCell);
      if (occupants === undefined) {
        continue;
      }
      for (const occupant of occupants) {
        if (occupant !== zoneId) {
          neighbours.push(occupant);
        }
      }
    }
    return neighbours;
  }

  /** Whether the graph knows this zone. */
  has(zoneId: string): boolean {
    return this.zoneCell.has(zoneId);
  }

  /** The cell a known zone occupies, or undefined. */
  cellOf(zoneId: string): string | undefined {
    return this.zoneCell.get(zoneId);
  }

  /** The zones in one cell, in insertion order. Empty for an unoccupied cell. */
  zonesInCell(cell: string): readonly string[] {
    return this.occupancy.get(cell) ?? NO_ZONES;
  }

  /** The cells within `ringSize` of `cell`, including `cell` itself. */
  neighbourCellsOf(cell: string): readonly string[] {
    return this.diskOf(cell);
  }

  stats(): NeighbourGraphStats {
    return {
      zones: this.zoneCell.size,
      occupiedCells: this.occupancy.size,
      cachedDisks: this.diskCache.size,
      recomputedCells: this.recomputedCells
    };
  }

  /** The adjacency definition this instance is working to. */
  get geometry(): { resolution: number; ringSize: number } {
    return { resolution: this.resolution, ringSize: this.ringSize };
  }

  private cellFor(zone: ZoneLocation): string {
    const stored = zone.h3Cell;
    if (stored !== undefined) {
      if (isValidCell(stored) && getResolution(stored) === this.resolution) {
        return stored;
      }
      this.recomputedCells++;
    }
    return cellsFor(zone.latitude, zone.longitude, this.resolution).h3Cell;
  }

  private diskOf(cell: string): string[] {
    let disk = this.diskCache.get(cell);
    if (disk === undefined) {
      // gridDisk, not gridRingUnsafe: the unsafe variants throw when the traversal meets one of
      // the twelve pentagons, and a pentagon is a place a zone is allowed to be.
      disk = gridDisk(cell, this.ringSize);
      this.diskCache.set(cell, disk);
    }
    return disk;
  }

  private removeFromCell(cell: string, zoneId: string): void {
    const occupants = this.occupancy.get(cell);
    if (occupants === undefined) {
      return;
    }
    const index = occupants.indexOf(zoneId);
    if (index >= 0) {
      occupants.splice(index, 1);
    }
    if (occupants.length === 0) {
      this.occupancy.delete(cell);
    }
  }
}
