import { TimeAwareConnectivity } from '../timeAwareConnectivity';
import { runConnectivityContract } from './support/contract';
import { StaticAdjacency, grid, path, ring, star, zoneId, zoneIds } from './support/graphs';

runConnectivityContract(
  'TimeAwareConnectivity',
  (adjacency) => new TimeAwareConnectivity(adjacency)
);

describe('TimeAwareConnectivity — union-find on the hot path', () => {
  it('bounds tree height with union by rank, even on a 500-long chain', () => {
    // A chain activated end to end is the shape that makes a naive union-find degenerate into a
    // linked list, one element deep per union. Rank is the height bound, so it is the thing to
    // assert: it must stay near log2(n), not near n.
    const size = 500;
    const c = new TimeAwareConnectivity(path(size));
    for (const id of zoneIds(size)) {
      c.activate(id);
    }

    expect(c.components()).toEqual([zoneIds(size)]);
    expect(c.stats().maxRank).toBeLessThanOrEqual(Math.floor(Math.log2(size)));
  });

  it('flattens a deep tree on first traversal and then has nothing left to rewrite', () => {
    // Depth only appears when two trees of equal rank meet, which needs two components that
    // already have one each. Four pairs plus a hub that bridges them is the smallest shape that
    // forces it: the hub's second union merges two rank-1 trees and pushes one of them to
    // depth 2.
    const adjacency = new StaticAdjacency([
      [zoneId(1), zoneId(2)],
      [zoneId(3), zoneId(4)],
      [zoneId(5), zoneId(6)],
      [zoneId(7), zoneId(8)],
      [zoneId(0), zoneId(1)],
      [zoneId(0), zoneId(3)],
      [zoneId(0), zoneId(5)],
      [zoneId(0), zoneId(7)]
    ]);
    const c = new TimeAwareConnectivity(adjacency);
    for (const id of zoneIds(9).slice(1)) {
      c.activate(id);
    }
    c.activate(zoneId(0));
    expect(c.stats().maxRank).toBe(2);

    const beforeFirst = c.stats().compressions;
    for (const id of zoneIds(9)) {
      c.connected(zoneId(0), id);
    }
    const rewritten = c.stats().compressions - beforeFirst;
    expect(rewritten).toBeGreaterThan(0);

    // Every node now points straight at the root, so a thousand more lookups rewrite nothing.
    const beforeRepeats = c.stats().compressions;
    for (let i = 0; i < 1000; i++) {
      for (const id of zoneIds(9)) {
        c.connected(zoneId(0), id);
      }
    }
    expect(c.stats().compressions - beforeRepeats).toBe(0);
    expect(c.components()).toEqual([zoneIds(9)]);
  });

  it('counts a union that changes nothing as a non-merge', () => {
    const c = new TimeAwareConnectivity(path(3));
    c.activate(zoneId(0));
    c.activate(zoneId(1));
    expect(c.stats().merges).toBe(1);

    c.activate(zoneId(0)); // re-degradation: the union is already in place
    c.activate(zoneId(1));
    expect(c.stats()).toMatchObject({ merges: 1, activations: 2, reactivations: 2 });
  });

  it('agrees with itself about component count', () => {
    const c = new TimeAwareConnectivity(grid(4, 4));
    for (const id of zoneIds(16)) {
      c.activate(id);
    }
    c.compact([zoneId(4), zoneId(5), zoneId(6), zoneId(7)]); // cut the lattice in half

    expect(c.components()).toHaveLength(2);
    expect(c.stats().components).toBe(2);
  });
});

describe('TimeAwareConnectivity — local rebuild on expiry', () => {
  /** Two disjoint 3-paths: 0—1—2 and 5—6—7, with 3 and 4 never adjacent to either. */
  function twoIslands(): StaticAdjacency {
    return new StaticAdjacency([
      [zoneId(0), zoneId(1)],
      [zoneId(1), zoneId(2)],
      [zoneId(5), zoneId(6)],
      [zoneId(6), zoneId(7)]
    ]);
  }

  it('rebuilds only the component that lost a member', () => {
    const c = new TimeAwareConnectivity(twoIslands());
    for (const id of [0, 1, 2, 5, 6, 7].map(zoneId)) {
      c.activate(id);
    }

    c.deactivate(zoneId(1));

    // One rebuild, over the two survivors of the island that lost a member. The other island was
    // not walked at all — which is the entire point of the design.
    expect(c.stats()).toMatchObject({ rebuilds: 1, rebuiltMembers: 2, removals: 1 });
    expect(c.components()).toEqual([
      [zoneId(0)],
      [zoneId(2)],
      [zoneId(5), zoneId(6), zoneId(7)]
    ]);
  });

  it('rebuilds each affected component once when a batch spans several', () => {
    const c = new TimeAwareConnectivity(twoIslands());
    for (const id of [0, 1, 2, 5, 6, 7].map(zoneId)) {
      c.activate(id);
    }

    c.compact([zoneId(1), zoneId(6)]);
    expect(c.stats()).toMatchObject({ rebuilds: 2, rebuiltMembers: 4, removals: 2 });
  });

  it('rebuilds a component once when it loses several members at the same tick', () => {
    const c = new TimeAwareConnectivity(path(5));
    for (const id of zoneIds(5)) {
      c.activate(id);
    }

    c.compact([zoneId(1), zoneId(3)]);
    expect(c.stats()).toMatchObject({ rebuilds: 1, rebuiltMembers: 3 });
    expect(c.components()).toEqual([[zoneId(0)], [zoneId(2)], [zoneId(4)]]);
  });

  it('does no work at all when the removal batch contains no members', () => {
    const c = new TimeAwareConnectivity(path(3));
    c.activate(zoneId(0));
    const before = c.stats();

    c.compact([zoneId(1), zoneId(2), 'Z-unknown']);

    expect(c.stats()).toMatchObject({
      rebuilds: before.rebuilds,
      removals: before.removals,
      finds: before.finds
    });
  });

  it('discards a component entirely when nothing survives', () => {
    const c = new TimeAwareConnectivity(path(3));
    for (const id of zoneIds(3)) {
      c.activate(id);
    }

    c.compact(zoneIds(3));
    expect(c.stats()).toMatchObject({ rebuilds: 1, rebuiltMembers: 0 });
    expect(c.size).toBe(0);
    expect(c.components()).toEqual([]);
  });

  it('produces a rebuilt component indistinguishable from one built fresh', () => {
    // The survivors of a torn-down ring, versus the same zones activated from nothing.
    const adjacency = ring(6);

    const rebuilt = new TimeAwareConnectivity(adjacency);
    for (const id of zoneIds(6)) {
      rebuilt.activate(id);
    }
    rebuilt.compact([zoneId(0), zoneId(3)]);

    const fresh = new TimeAwareConnectivity(adjacency);
    for (const id of [1, 2, 4, 5].map(zoneId)) {
      fresh.activate(id);
    }

    expect(rebuilt.components()).toEqual(fresh.components());
    expect(rebuilt.components()).toEqual([
      [zoneId(1), zoneId(2)],
      [zoneId(4), zoneId(5)]
    ]);
  });

  it('survives repeated tear-down and regrowth of the same component', () => {
    const c = new TimeAwareConnectivity(star(6));
    for (let round = 0; round < 25; round++) {
      for (const id of zoneIds(6)) {
        c.activate(id);
      }
      expect(c.components()).toEqual([zoneIds(6)]);

      c.deactivate(zoneId(0)); // remove the hub; five singletons remain
      expect(c.components()).toEqual([[zoneId(1)], [zoneId(2)], [zoneId(3)], [zoneId(4)], [zoneId(5)]]);

      c.compact(zoneIds(6));
      expect(c.size).toBe(0);
    }
  });
});

describe('TimeAwareConnectivity — the documented caveats', () => {
  it('does not see an edge learned after both endpoints joined, until one re-degrades', () => {
    // Zones are discovered at runtime, so the neighbour graph grows. An edge added after both of
    // its endpoints became members is not consulted again until something makes the structure
    // look. This can only ever miss a merge, never invent one.
    const adjacency = new StaticAdjacency();
    const c = new TimeAwareConnectivity(adjacency);
    c.activate(zoneId(0));
    c.activate(zoneId(1));
    expect(c.components()).toEqual([[zoneId(0)], [zoneId(1)]]);

    adjacency.addEdge(zoneId(0), zoneId(1));
    expect(c.components()).toEqual([[zoneId(0)], [zoneId(1)]]); // not yet

    c.activate(zoneId(0)); // the next degradation for this zone repairs it
    expect(c.components()).toEqual([[zoneId(0), zoneId(1)]]);
  });

  it('reads current adjacency when it rebuilds, not the edges it merged on', () => {
    // 0—1—2, and then 0—2 is learned. Removing the bridging zone 1 would split the component if
    // the rebuild replayed history; it does not, because the BFS asks the graph as it stands.
    const adjacency = new StaticAdjacency([
      [zoneId(0), zoneId(1)],
      [zoneId(1), zoneId(2)]
    ]);
    const c = new TimeAwareConnectivity(adjacency);
    for (const id of zoneIds(3)) {
      c.activate(id);
    }
    adjacency.addEdge(zoneId(0), zoneId(2));

    c.compact([zoneId(1)]);
    expect(c.components()).toEqual([[zoneId(0), zoneId(2)]]);
  });

  it('exposes a representative that must not be used as an identity', () => {
    // 1 and 2 pair up first, so the root is Z-002 rather than the smallest member.
    const adjacency = new StaticAdjacency([
      [zoneId(0), zoneId(1)],
      [zoneId(1), zoneId(2)],
      [zoneId(0), zoneId(3)]
    ]);
    const c = new TimeAwareConnectivity(adjacency);
    for (const id of [1, 2, 0, 3].map(zoneId)) {
      c.activate(id);
    }
    const before = c.representativeOf(zoneId(2));
    expect(before).toBe(zoneId(2));

    c.deactivate(zoneId(3)); // rebuild re-roots the component at its smallest survivor
    const after = c.representativeOf(zoneId(2));

    // Zones 0, 1 and 2 are still exactly as connected as they were, and the representative
    // still moved. WP2b derives incident ids from the member set for this reason (ADR-003).
    expect(c.componentOf(zoneId(2))).toEqual([zoneId(0), zoneId(1), zoneId(2)]);
    expect(after).not.toBe(before);
    expect(c.representativeOf('Z-unknown')).toBeUndefined();
  });
});
