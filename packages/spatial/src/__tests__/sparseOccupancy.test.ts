import { NEIGHBOUR_RING_SIZE, NeighbourGraph, ZoneLocation } from '../neighbourGraph';
import { H3_RESOLUTION } from '../cells';
import { haversineKm } from '../geo';

/**
 * The regression guard for the failure the first end-to-end run found.
 *
 * All 62 zones the `regional-anomaly` ground truth labels degraded and reached the correlation
 * window — detection was exact — and the engine still reported seven components and three
 * incidents for one fault. The correlation algorithm was not at fault; the adjacency reach was
 * too short for the fleet's cell occupancy.
 *
 * The property that was violated, stated so it does not depend on a ground-truth file or a seed:
 *
 *   **A contiguous patch of zones spaced at the fleet's typical inter-zone distance must be one
 *   connected component**, even when almost every zone sits alone in its own cell.
 *
 * That last clause is the part that bites. Sixty-two zones occupied sixty-one distinct res-5
 * cells, so the occupied cells were a sparse scattered subset of the cells the fault covered, and
 * ring-1 adjacency over a sparse subset fragments even though the points are contiguous on the
 * ground. `benchmarks/anomaly-connectivity.ts` measures it against the real labelled sets; this
 * pins it in the test suite, where a change to the ring size or the resolution has to face it.
 */

/** Reference fleet density: the regional-grid layout's median nearest-neighbour distance. */
const ZONE_PITCH_KM = 15.7;

const ORIGIN = { latitude: 51.96, longitude: 13.09 };
const KM_PER_DEGREE_LAT = 110.574;

/**
 * A square patch of zones on a regular pitch. Deliberately a lattice with no jitter: jitter would
 * make the result depend on a seed, and the point here is the pitch.
 */
function patch(side: number, pitchKm: number): ZoneLocation[] {
  const zones: ZoneLocation[] = [];
  const dLat = pitchKm / KM_PER_DEGREE_LAT;
  const dLon = pitchKm / (KM_PER_DEGREE_LAT * Math.cos((ORIGIN.latitude * Math.PI) / 180));

  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      zones.push({
        zoneId: `Z-${row}-${col}`,
        latitude: ORIGIN.latitude + row * dLat,
        longitude: ORIGIN.longitude + col * dLon
      });
    }
  }
  return zones;
}

function componentCount(zones: readonly ZoneLocation[], ringSize: number): number {
  const graph = new NeighbourGraph({ ringSize });
  graph.build(zones);

  const seen = new Set<string>();
  let components = 0;

  for (const zone of zones) {
    if (seen.has(zone.zoneId)) continue;
    components++;
    const stack = [zone.zoneId];
    seen.add(zone.zoneId);
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const neighbour of graph.neighboursOf(current)) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          stack.push(neighbour);
        }
      }
    }
  }

  return components;
}

describe('sparse cell occupancy', () => {
  it('has a pitch comparable to the res-5 cell spacing, which is what makes this hard', () => {
    const zones = patch(8, ZONE_PITCH_KM);
    const first = zones[0];
    const rightNeighbour = zones.find((z) => z.zoneId === 'Z-0-1') as ZoneLocation;

    expect(haversineKm(first, rightNeighbour)).toBeCloseTo(ZONE_PITCH_KM, 0);

    // Roughly one zone per cell: the sparse-occupancy condition, not a dense one.
    const graph = new NeighbourGraph();
    graph.build(zones);
    const stats = graph.stats();
    expect(stats.occupiedCells).toBeGreaterThan(zones.length * 0.6);
  });

  it('keeps a contiguous patch as ONE component at the shipped ring size', () => {
    // 64 zones, close to the 62 the reference regional anomaly covers.
    expect(componentCount(patch(8, ZONE_PITCH_KM), NEIGHBOUR_RING_SIZE)).toBe(1);
  });

  /**
   * The bug, pinned. Not an aspiration — this is what the shipped configuration did, and the
   * assertion exists so that anyone tempted to put the ring size back to 1 finds out here
   * rather than from a benchmark six work packages later.
   */
  it('fragments the same patch at ring 1, which is the defect this replaces', () => {
    expect(componentCount(patch(8, ZONE_PITCH_KM), 1)).toBeGreaterThan(1);
  });

  it('gets worse at a finer resolution, which is the tell that reach is the wrong knob', () => {
    const zones = patch(8, ZONE_PITCH_KM);
    const finer = new NeighbourGraph({ resolution: H3_RESOLUTION + 1, ringSize: 1 });
    finer.build(zones);

    // Every zone alone in its own cell, no cell touching another: 64 singletons. `neighboursOf`
    // excludes the zone itself, so an isolated zone answers with an empty list.
    let isolated = 0;
    for (const zone of zones) {
      if (finer.neighboursOf(zone.zoneId).length === 0) isolated++;
    }
    expect(isolated).toBe(zones.length);
  });

  it('still separates patches that are genuinely far apart', () => {
    // The over-grouping side of the trade. `multi-anomaly` places its anomalies at least 100 km
    // apart precisely so a correct engine has no excuse to merge them; a reach that connects one
    // fault by joining two is not a fix.
    const near = patch(6, ZONE_PITCH_KM);
    const farOffsetDeg = 200 / KM_PER_DEGREE_LAT;
    const far = patch(6, ZONE_PITCH_KM).map((z) => ({
      ...z,
      zoneId: `far-${z.zoneId}`,
      latitude: z.latitude + farOffsetDeg
    }));

    expect(componentCount([...near, ...far], NEIGHBOUR_RING_SIZE)).toBe(2);
  });

  it('ships ring 2 by default', () => {
    // The value is load-bearing and is asserted rather than assumed, because every process that
    // reasons about incidents has to agree on it and a disagreement fails silently.
    expect(NEIGHBOUR_RING_SIZE).toBe(2);
  });
});
