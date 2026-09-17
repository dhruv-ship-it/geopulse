import { NaiveConnectivity } from '../naiveConnectivity';
import { canonicalise, describePartition } from '../connectivity';
import { runConnectivityContract } from './support/contract';
import { StaticAdjacency, grid, path, zoneId, zoneIds } from './support/graphs';

runConnectivityContract('NaiveConnectivity', (adjacency) => new NaiveConnectivity(adjacency));

describe('NaiveConnectivity — the oracle itself', () => {
  it('holds no state beyond the member set, so the partition is a pure function of it', () => {
    const adjacency = path(5);

    // Reached by two completely different histories: built up, versus built up and torn down.
    const built = new NaiveConnectivity(adjacency);
    for (const id of [zoneId(0), zoneId(1), zoneId(2)]) {
      built.activate(id);
    }

    const churned = new NaiveConnectivity(adjacency);
    for (const id of zoneIds(5)) {
      churned.activate(id);
    }
    churned.compact([zoneId(3), zoneId(4)]);

    expect(churned.components()).toEqual(built.components());
  });

  it('sees an edge the moment the graph learns it, with no re-activation needed', () => {
    // This is the property that makes it the oracle rather than a second implementation of the
    // same design: it never caches an edge, so it cannot cache a stale one.
    const adjacency = new StaticAdjacency();
    const c = new NaiveConnectivity(adjacency);
    c.activate(zoneId(0));
    c.activate(zoneId(1));
    expect(c.components()).toEqual([[zoneId(0)], [zoneId(1)]]);

    adjacency.addEdge(zoneId(0), zoneId(1));
    expect(c.components()).toEqual([[zoneId(0), zoneId(1)]]);
  });

  it('is unaffected by the order members were added in', () => {
    const adjacency = grid(3, 3);
    const orders = [zoneIds(9), [...zoneIds(9)].reverse(), [4, 0, 8, 2, 6, 1, 7, 3, 5].map(zoneId)];

    const partitions = orders.map((order) => {
      const c = new NaiveConnectivity(adjacency);
      for (const id of order) {
        c.activate(id);
      }
      c.compact([zoneId(4)]);
      return describePartition(c.components());
    });

    expect(new Set(partitions).size).toBe(1);
  });
});

describe('canonicalise', () => {
  it('sorts within components and orders components by their first member', () => {
    expect(canonicalise([['Z-9', 'Z-2'], ['Z-5'], ['Z-1', 'Z-8']])).toEqual([
      ['Z-1', 'Z-8'],
      ['Z-2', 'Z-9'],
      ['Z-5']
    ]);
  });

  it('does not mutate its input', () => {
    const input = [['Z-9', 'Z-2']];
    canonicalise(input);
    expect(input).toEqual([['Z-9', 'Z-2']]);
  });

  it('renders a partition as a stable string', () => {
    expect(describePartition([['Z-3', 'Z-1'], ['Z-2']])).toBe('Z-1+Z-3 | Z-2');
    expect(describePartition([])).toBe('');
  });
});
