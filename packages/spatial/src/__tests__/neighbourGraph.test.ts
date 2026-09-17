import { cellToLatLng, getPentagons, getResolution, gridDistance, latLngToCell } from 'h3-js';
import { NeighbourGraph, ZoneLocation } from '../neighbourGraph';
import { haversineKm } from '../geo';

const RES = 5;

/**
 * Two bounds on what a one-ring res-5 neighbourhood means in kilometres, both measured rather
 * than assumed — `benchmarks/results/wp1-neighbour-graph.txt` reports them for the field it
 * builds, and this file re-derives them for its own field.
 *
 * They are deliberately loose against the measured values (35.8 km and 11.5 km): the point of
 * the assertions below is that cell adjacency *brackets* a distance threshold, not that it
 * equals one. It cannot equal one — a hexagon is not a circle, so there is a band in which two
 * zones may or may not be neighbours depending on where the cell boundary happens to fall. Any
 * test that pretended otherwise would be asserting something false.
 */
const NEIGHBOURS_ARE_WITHIN_KM = 40;
const CLOSER_THAN_THIS_IS_ALWAYS_A_NEIGHBOUR_KM = 10;

function zone(zoneId: string, latitude: number, longitude: number): ZoneLocation {
  return { zoneId, latitude, longitude };
}

/** A tiny deterministic PRNG — Math.random() is banned repo-wide (CLAUDE.md rule 3). */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z ^= z >>> 16;
    z = Math.imul(z, 0x21f0aaad);
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97);
    z ^= z >>> 15;
    return (z >>> 0) / 0x100000000;
  };
}

describe('NeighbourGraph — cell occupancy', () => {
  it('reports no neighbours for a zone alone in its cell and alone in the region', () => {
    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build([zone('Z-1', 28.6, 77.2)]);

    expect(graph.neighboursOf('Z-1')).toEqual([]);
    expect(graph.stats()).toMatchObject({ zones: 1, occupiedCells: 1 });
  });

  it('groups several zones in one cell and excludes the zone itself', () => {
    // Three coordinates a few hundred metres apart: same cell at res 5 by construction, and
    // asserted, so the test fails loudly rather than silently testing something else if the
    // resolution default ever moves.
    const zones = [zone('Z-1', 28.6, 77.2), zone('Z-2', 28.602, 77.202), zone('Z-3', 28.598, 77.198)];
    const cells = zones.map((z) => latLngToCell(z.latitude, z.longitude, RES));
    expect(new Set(cells).size).toBe(1);

    const graph = new NeighbourGraph({ resolution: RES, ringSize: 0 });
    graph.build(zones);

    expect(graph.neighboursOf('Z-1').sort()).toEqual(['Z-2', 'Z-3']);
    expect(graph.neighboursOf('Z-2').sort()).toEqual(['Z-1', 'Z-3']);
    expect(graph.neighboursOf('Z-3').sort()).toEqual(['Z-1', 'Z-2']);
    expect(graph.stats().occupiedCells).toBe(1);
  });

  it('returns an empty list for a zone it has never been told about', () => {
    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build([zone('Z-1', 28.6, 77.2)]);

    // Not a throw: the correlation engine learns about zones and about degradations from two
    // different streams, so a degradation can legitimately arrive first.
    expect(graph.neighboursOf('Z-unknown')).toEqual([]);
    expect(graph.has('Z-unknown')).toBe(false);
  });
});

describe('NeighbourGraph — ring size', () => {
  // A line of zones stepping away from an origin, one cell at a time, built from H3 itself so
  // the grid distances are exact rather than eyeballed from kilometres.
  function laddered(): { zones: ZoneLocation[]; distances: number[] } {
    const origin = latLngToCell(28.6, 77.2, RES);
    const zones: ZoneLocation[] = [zone('Z-0', 28.6, 77.2)];
    const distances = [0];

    for (let step = 1; step <= 3; step++) {
      // Walk east in ~17 km strides — roughly one res-5 cell per step — and record where each
      // one actually landed on the grid.
      const latitude = 28.6;
      const longitude = 77.2 + step * 0.18;
      const cell = latLngToCell(latitude, longitude, RES);
      zones.push(zone(`Z-${step}`, latitude, longitude));
      distances.push(gridDistance(origin, cell));
    }
    return { zones, distances };
  }

  it('ring 0 sees only the same cell; ring k sees exactly the cells within k', () => {
    const { zones, distances } = laddered();
    expect(distances).toEqual([0, 1, 2, 3]);

    for (const ringSize of [0, 1, 2, 3]) {
      const graph = new NeighbourGraph({ resolution: RES, ringSize });
      graph.build(zones);

      const expected = zones
        .filter((z, i) => z.zoneId !== 'Z-0' && distances[i] <= ringSize)
        .map((z) => z.zoneId);

      expect(graph.neighboursOf('Z-0').sort()).toEqual(expected.sort());
    }
  });

  it('a one-ring neighbourhood is 7 cells and a two-ring one is 19', () => {
    // 1 + 3k(k+1). This is the constant that makes neighboursOf independent of zone count.
    const cell = latLngToCell(28.6, 77.2, RES);
    expect(new NeighbourGraph({ resolution: RES, ringSize: 1 }).neighbourCellsOf(cell)).toHaveLength(7);
    expect(new NeighbourGraph({ resolution: RES, ringSize: 2 }).neighbourCellsOf(cell)).toHaveLength(19);
  });
});

describe('NeighbourGraph — antimeridian', () => {
  it('puts two zones a few km apart across lon ±180 in the same cell', () => {
    const west = zone('Z-west', 0, 179.98);
    const east = zone('Z-east', 0, -179.98);

    // 4.4 km apart on the ground; 359.96 degrees apart if you subtract longitudes, which is
    // what makes this the case worth testing. Any scheme that bucketed on raw longitude, or
    // any neighbour search that filtered on a longitude delta before measuring, splits them.
    expect(haversineKm(west, east)).toBeLessThan(5);
    expect(Math.abs(west.longitude - east.longitude)).toBeGreaterThan(359);

    const graph = new NeighbourGraph({ resolution: RES, ringSize: 0 });
    graph.build([west, east]);

    expect(graph.cellOf('Z-west')).toBe(graph.cellOf('Z-east'));
    expect(graph.neighboursOf('Z-west')).toEqual(['Z-east']);
    expect(graph.neighboursOf('Z-east')).toEqual(['Z-west']);
  });

  it('makes two zones in adjacent cells across lon ±180 mutual neighbours at ring 1', () => {
    const west = zone('Z-west', 0, 179.95);
    const east = zone('Z-east', 0, -179.95);
    expect(haversineKm(west, east)).toBeLessThan(12);

    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build([west, east]);

    expect(graph.cellOf('Z-west')).not.toBe(graph.cellOf('Z-east'));
    expect(graph.neighboursOf('Z-west')).toEqual(['Z-east']);
    expect(graph.neighboursOf('Z-east')).toEqual(['Z-west']);
  });

  it('does not join zones that are merely on both sides of the line but far apart', () => {
    // The mirror of the test above, and the one that would pass trivially if the graph simply
    // ignored longitude: 179.0 and -179.0 are 222 km apart, which is not adjacency.
    const west = zone('Z-west', 0, 179.0);
    const east = zone('Z-east', 0, -179.0);
    expect(haversineKm(west, east)).toBeGreaterThan(200);

    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build([west, east]);

    expect(graph.neighboursOf('Z-west')).toEqual([]);
    expect(graph.neighboursOf('Z-east')).toEqual([]);
  });
});

describe('NeighbourGraph — high latitude and pentagons', () => {
  it('finds neighbours across wildly different longitudes near the pole', () => {
    // At 89.9°N, a quarter turn of longitude is 15.7 km — these three zones are neighbours in
    // every physical sense, and 90 degrees apart in the coordinate that a rectangular grid
    // buckets on.
    const zones = [zone('Z-0', 89.9, 0), zone('Z-90', 89.9, 90), zone('Z-180', 89.9, 180)];
    expect(haversineKm(zones[0], zones[1])).toBeLessThan(20);
    expect(haversineKm(zones[0], zones[2])).toBeLessThan(25);

    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build(zones);

    expect(graph.neighboursOf('Z-0').sort()).toEqual(['Z-180', 'Z-90']);
    expect(graph.neighboursOf('Z-90')).toContain('Z-0');
    expect(graph.neighboursOf('Z-180')).toContain('Z-0');
  });

  it('handles the south pole the same way', () => {
    const zones = [zone('Z-a', -89.95, 0), zone('Z-b', -89.95, 120), zone('Z-c', -89.95, -120)];
    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build(zones);

    for (const z of zones) {
      expect(graph.neighboursOf(z.zoneId).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('serves a zone sitting in one of the twelve pentagons without throwing', () => {
    // H3 tiles an icosahedron, and an icosahedron cannot be tiled by hexagons alone: twelve
    // cells per resolution are pentagons, with five neighbours rather than six. They are a
    // real place a zone can be, so gridDisk (which tolerates them) is used rather than the
    // gridRing*Unsafe variants (which throw).
    const pentagon = getPentagons(RES)[0];
    const [lat, lon] = cellToLatLng(pentagon);

    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build([zone('Z-pent', lat, lon)]);

    expect(graph.cellOf('Z-pent')).toBe(pentagon);
    // 6, not 7: the pentagon plus its five neighbours.
    expect(graph.neighbourCellsOf(pentagon)).toHaveLength(6);

    // And a zone in each surrounding cell is found from the pentagon, and finds it back.
    const around = graph
      .neighbourCellsOf(pentagon)
      .filter((c) => c !== pentagon)
      .map((c, i) => {
        const [nlat, nlon] = cellToLatLng(c);
        return zone(`Z-around-${i}`, nlat, nlon);
      });
    graph.build([zone('Z-pent', lat, lon), ...around]);

    expect(graph.neighboursOf('Z-pent')).toHaveLength(around.length);
    for (const a of around) {
      expect(graph.neighboursOf(a.zoneId)).toContain('Z-pent');
    }
  });
});

describe('NeighbourGraph — agreement with physical distance', () => {
  // A dense field of zones over roughly 200 km of ground, checked against a haversine oracle
  // that shares no code with the implementation.
  function field(count: number): ZoneLocation[] {
    const next = prng(42);
    const zones: ZoneLocation[] = [];
    for (let i = 0; i < count; i++) {
      zones.push(zone(`Z-${i}`, 28.6 + (next() - 0.5) * 1.8, 77.2 + (next() - 0.5) * 2.0));
    }
    return zones;
  }

  it('never calls two distant zones neighbours, and never misses two very close ones', () => {
    const zones = field(600);
    const byId = new Map(zones.map((z) => [z.zoneId, z]));
    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build(zones);

    for (const z of zones) {
      const reported = new Set(graph.neighboursOf(z.zoneId));

      for (const other of zones) {
        if (other.zoneId === z.zoneId) {
          continue;
        }
        const km = haversineKm(byId.get(z.zoneId)!, other);

        if (reported.has(other.zoneId)) {
          expect(km).toBeLessThan(NEIGHBOURS_ARE_WITHIN_KM);
        }
        if (km < CLOSER_THAN_THIS_IS_ALWAYS_A_NEIGHBOUR_KM) {
          expect(reported.has(other.zoneId)).toBe(true);
        }
      }
    }
  });

  it('is symmetric: if a sees b then b sees a', () => {
    const zones = field(400);
    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build(zones);

    for (const z of zones) {
      for (const neighbour of graph.neighboursOf(z.zoneId)) {
        expect(graph.neighboursOf(neighbour)).toContain(z.zoneId);
      }
    }
  });

  it('matches an independent grid-distance definition exactly', () => {
    // Same answer, computed the other way round: recompute each cell from the coordinate and
    // ask H3 for the grid distance, instead of asking for a disk and intersecting occupancy.
    // This is what catches an occupancy-index bug — a stale cell, a zone left in two cells.
    const zones = field(300);
    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build(zones);

    const cells = new Map(zones.map((z) => [z.zoneId, latLngToCell(z.latitude, z.longitude, RES)]));

    for (const z of zones) {
      const expected = zones
        .filter((o) => o.zoneId !== z.zoneId && gridDistance(cells.get(z.zoneId)!, cells.get(o.zoneId)!) <= 1)
        .map((o) => o.zoneId)
        .sort();

      expect(graph.neighboursOf(z.zoneId).sort()).toEqual(expected);
    }
  });
});

describe('NeighbourGraph — incremental discovery and rebuilds', () => {
  it('addZone makes a new zone visible to its neighbours immediately', () => {
    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build([zone('Z-1', 28.6, 77.2)]);
    expect(graph.neighboursOf('Z-1')).toEqual([]);

    graph.addZone(zone('Z-2', 28.61, 77.21));

    expect(graph.neighboursOf('Z-1')).toEqual(['Z-2']);
    expect(graph.neighboursOf('Z-2')).toEqual(['Z-1']);
  });

  it('addZone is idempotent for a zone that re-registers unchanged', () => {
    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    const z = zone('Z-1', 28.6, 77.2);

    graph.addZone(z);
    graph.addZone(z);
    graph.addZone(z);

    // Re-registration happens whenever a zone reappears after its in-memory state was evicted,
    // so duplicating it in the occupancy index would make a zone its own neighbour.
    expect(graph.stats().zones).toBe(1);
    expect(graph.zonesInCell(graph.cellOf('Z-1')!)).toEqual(['Z-1']);
    expect(graph.neighboursOf('Z-1')).toEqual([]);
  });

  it('moves a zone that re-registers at a different coordinate, leaving no trace behind', () => {
    const graph = new NeighbourGraph({ resolution: RES, ringSize: 0 });
    graph.addZone(zone('Z-moving', 28.6, 77.2));
    graph.addZone(zone('Z-anchor', 28.6, 77.2));
    const origin = graph.cellOf('Z-anchor')!;

    graph.addZone(zone('Z-moving', 40.0, -74.0));

    expect(graph.zonesInCell(origin)).toEqual(['Z-anchor']);
    expect(graph.neighboursOf('Z-anchor')).toEqual([]);
    expect(graph.cellOf('Z-moving')).toBe(latLngToCell(40.0, -74.0, RES));
    expect(graph.stats().zones).toBe(2);
  });

  it('build replaces the previous contents', () => {
    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build([zone('Z-1', 28.6, 77.2), zone('Z-2', 28.61, 77.21)]);
    graph.build([zone('Z-3', 28.6, 77.2)]);

    expect(graph.stats().zones).toBe(1);
    expect(graph.has('Z-1')).toBe(false);
    expect(graph.neighboursOf('Z-3')).toEqual([]);
  });

  it('is order-deterministic: the same registry yields the same lists, element for element', () => {
    const zones = Array.from({ length: 50 }, (_, i) =>
      zone(`Z-${i}`, 28.6 + (i % 7) * 0.05, 77.2 + Math.floor(i / 7) * 0.05)
    );

    const first = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    const second = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    first.build(zones);
    second.build(zones);

    for (const z of zones) {
      // toEqual, not a sorted comparison: the correlation engine merges components in the
      // order it walks them, so a replay that reordered this could reorder merges too.
      expect(first.neighboursOf(z.zoneId)).toEqual(second.neighboursOf(z.zoneId));
    }
  });
});

describe('NeighbourGraph — the stored cell from the registry', () => {
  it('uses a stored cell that is valid and at the right resolution', () => {
    const cell = latLngToCell(28.6, 77.2, RES);
    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build([{ zoneId: 'Z-1', latitude: 28.6, longitude: 77.2, h3Cell: cell }]);

    expect(graph.cellOf('Z-1')).toBe(cell);
    expect(graph.stats().recomputedCells).toBe(0);
  });

  it('recomputes, and counts, a stored cell at the wrong resolution', () => {
    // The failure this guards against is silent, not loud: a res-6 id is a perfectly valid H3
    // index, so it would sit in the occupancy map looking fine while every ring-1 lookup
    // around it returned nothing, and every incident containing it collapsed to a singleton.
    const wrongResolution = latLngToCell(28.6, 77.2, 6);
    expect(getResolution(wrongResolution)).toBe(6);

    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build([
      { zoneId: 'Z-1', latitude: 28.6, longitude: 77.2, h3Cell: wrongResolution },
      { zoneId: 'Z-2', latitude: 28.61, longitude: 77.21 }
    ]);

    expect(graph.cellOf('Z-1')).toBe(latLngToCell(28.6, 77.2, RES));
    expect(graph.stats().recomputedCells).toBe(1);
    expect(graph.neighboursOf('Z-1')).toEqual(['Z-2']);
  });

  it('recomputes a malformed stored cell rather than trusting it', () => {
    const graph = new NeighbourGraph({ resolution: RES, ringSize: 1 });
    graph.build([{ zoneId: 'Z-1', latitude: 28.6, longitude: 77.2, h3Cell: 'not-an-h3-index' }]);

    expect(graph.cellOf('Z-1')).toBe(latLngToCell(28.6, 77.2, RES));
    expect(graph.stats().recomputedCells).toBe(1);
  });
});

describe('NeighbourGraph — configuration', () => {
  it('rejects a resolution or ring size that H3 cannot honour', () => {
    expect(() => new NeighbourGraph({ resolution: 16 })).toThrow(/resolution/);
    expect(() => new NeighbourGraph({ resolution: -1 })).toThrow(/resolution/);
    expect(() => new NeighbourGraph({ ringSize: -1 })).toThrow(/ringSize/);
    expect(() => new NeighbourGraph({ ringSize: 1.5 })).toThrow(/ringSize/);
  });

  it('reports the geometry it is working to', () => {
    expect(new NeighbourGraph({ resolution: 7, ringSize: 2 }).geometry).toEqual({
      resolution: 7,
      ringSize: 2
    });
  });
});
