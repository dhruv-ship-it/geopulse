import { AdjacencyProvider, Connectivity } from '../../connectivity';
import { grid, isolated, path, ring, star, zoneId, zoneIds } from './graphs';

/**
 * The behaviour every `Connectivity` implementation must show, run against both of them.
 *
 * The differential fuzz test proves the two agree; this proves that what they agree *on* is
 * connected components. Two implementations can be identical and identically wrong, and a fuzz
 * test alone would call that a pass. So the shared contract states the semantics in cases a
 * human chose, and the fuzz explores the state space neither of us thought of.
 */
export function runConnectivityContract(
  name: string,
  make: (adjacency: AdjacencyProvider) => Connectivity
): void {
  describe(`${name} — connectivity contract`, () => {
    it('starts empty', () => {
      const c = make(isolated());
      expect(c.components()).toEqual([]);
      expect(c.size).toBe(0);
      expect(c.isMember(zoneId(0))).toBe(false);
    });

    it('treats a lone member as its own component', () => {
      const c = make(path(3));
      c.activate(zoneId(1));
      expect(c.components()).toEqual([[zoneId(1)]]);
      expect(c.componentOf(zoneId(1))).toEqual([zoneId(1)]);
    });

    it('does not link members that are not adjacent', () => {
      const c = make(path(3)); // 0—1—2, so 0 and 2 are not adjacent
      c.activate(zoneId(0));
      c.activate(zoneId(2));
      expect(c.components()).toEqual([[zoneId(0)], [zoneId(2)]]);
      expect(c.connected(zoneId(0), zoneId(2))).toBe(false);
    });

    it('links two adjacent members', () => {
      const c = make(path(2));
      c.activate(zoneId(0));
      c.activate(zoneId(1));
      expect(c.components()).toEqual([[zoneId(0), zoneId(1)]]);
      expect(c.connected(zoneId(0), zoneId(1))).toBe(true);
    });

    it('ignores an adjacent zone that is not an active member', () => {
      const c = make(path(2));
      c.activate(zoneId(0));
      expect(c.components()).toEqual([[zoneId(0)]]);
      expect(c.connected(zoneId(0), zoneId(1))).toBe(false);
    });

    it('joins a whole path transitively', () => {
      const c = make(path(5));
      for (const id of zoneIds(5)) {
        c.activate(id);
      }
      expect(c.components()).toEqual([zoneIds(5)]);
      expect(c.connected(zoneId(0), zoneId(4))).toBe(true);
    });

    it('merges two components when a bridging member joins', () => {
      const c = make(path(5));
      c.activate(zoneId(0));
      c.activate(zoneId(1));
      c.activate(zoneId(3));
      c.activate(zoneId(4));
      expect(c.components()).toEqual([
        [zoneId(0), zoneId(1)],
        [zoneId(3), zoneId(4)]
      ]);

      c.activate(zoneId(2)); // the bridge
      expect(c.components()).toEqual([zoneIds(5)]);
    });

    it('is order-independent: the partition depends on the member set, not the arrival order', () => {
      const members = zoneIds(6);
      const forward = make(grid(3, 2));
      for (const id of members) {
        forward.activate(id);
      }
      const backward = make(grid(3, 2));
      for (const id of [...members].reverse()) {
        backward.activate(id);
      }
      expect(backward.components()).toEqual(forward.components());
    });

    it('treats a repeated activation as a no-op', () => {
      const c = make(path(3));
      c.activate(zoneId(0));
      c.activate(zoneId(1));
      c.activate(zoneId(0));
      c.activate(zoneId(1));
      expect(c.size).toBe(2);
      expect(c.components()).toEqual([[zoneId(0), zoneId(1)]]);
    });

    describe('removal', () => {
      it('splits a path when the bridging member leaves', () => {
        const c = make(path(5));
        for (const id of zoneIds(5)) {
          c.activate(id);
        }
        c.deactivate(zoneId(2));

        expect(c.components()).toEqual([
          [zoneId(0), zoneId(1)],
          [zoneId(3), zoneId(4)]
        ]);
        expect(c.connected(zoneId(1), zoneId(3))).toBe(false);
        expect(c.isMember(zoneId(2))).toBe(false);
        expect(c.componentOf(zoneId(2))).toBeUndefined();
      });

      it('keeps a ring in one piece when a member leaves', () => {
        const c = make(ring(5));
        for (const id of zoneIds(5)) {
          c.activate(id);
        }
        c.deactivate(zoneId(0));

        expect(c.components()).toEqual([[zoneId(1), zoneId(2), zoneId(3), zoneId(4)]]);
      });

      it('shatters a star when the hub leaves', () => {
        const c = make(star(5));
        for (const id of zoneIds(5)) {
          c.activate(id);
        }
        c.deactivate(zoneId(0));

        expect(c.components()).toEqual([[zoneId(1)], [zoneId(2)], [zoneId(3)], [zoneId(4)]]);
      });

      it('removes a batch at a compaction tick', () => {
        const c = make(path(5));
        for (const id of zoneIds(5)) {
          c.activate(id);
        }
        c.compact([zoneId(1), zoneId(3)]);

        expect(c.components()).toEqual([[zoneId(0)], [zoneId(2)], [zoneId(4)]]);
        expect(c.size).toBe(3);
      });

      it('removes a whole component at once', () => {
        const c = make(path(4));
        for (const id of zoneIds(4)) {
          c.activate(id);
        }
        c.compact(zoneIds(4));

        expect(c.components()).toEqual([]);
        expect(c.size).toBe(0);
      });

      it('leaves untouched components alone', () => {
        const c = make(path(5)); // 0—1—2—3—4
        c.activate(zoneId(0));
        c.activate(zoneId(1));
        c.activate(zoneId(3));
        c.activate(zoneId(4));
        c.deactivate(zoneId(4));

        expect(c.components()).toEqual([[zoneId(0), zoneId(1)], [zoneId(3)]]);
      });

      it('ignores removal of a zone that is not a member', () => {
        const c = make(path(3));
        c.activate(zoneId(0));
        c.deactivate(zoneId(2));
        c.compact([zoneId(1), 'Z-unknown']);

        expect(c.components()).toEqual([[zoneId(0)]]);
      });

      it('ignores an empty compaction batch', () => {
        const c = make(path(2));
        c.activate(zoneId(0));
        c.activate(zoneId(1));
        c.compact([]);

        expect(c.components()).toEqual([[zoneId(0), zoneId(1)]]);
      });

      it('tolerates a zone listed twice in one batch', () => {
        const c = make(path(3));
        for (const id of zoneIds(3)) {
          c.activate(id);
        }
        c.compact([zoneId(1), zoneId(1)]);

        expect(c.components()).toEqual([[zoneId(0)], [zoneId(2)]]);
        expect(c.size).toBe(2);
      });

      it('lets a removed member rejoin and re-bridge', () => {
        const c = make(path(3));
        for (const id of zoneIds(3)) {
          c.activate(id);
        }
        c.deactivate(zoneId(1));
        expect(c.components()).toEqual([[zoneId(0)], [zoneId(2)]]);

        c.activate(zoneId(1));
        expect(c.components()).toEqual([zoneIds(3)]);
      });
    });

    describe('queries', () => {
      it('reports a member as connected to itself', () => {
        const c = make(isolated());
        c.activate(zoneId(0));
        expect(c.connected(zoneId(0), zoneId(0))).toBe(true);
      });

      it('reports a non-member as connected to nothing, including itself', () => {
        const c = make(path(2));
        c.activate(zoneId(0));
        expect(c.connected(zoneId(1), zoneId(1))).toBe(false);
        expect(c.connected(zoneId(0), zoneId(1))).toBe(false);
        expect(c.componentOf(zoneId(1))).toBeUndefined();
      });

      it('returns every member of a component from any of its members', () => {
        const c = make(grid(3, 3));
        for (const id of zoneIds(9)) {
          c.activate(id);
        }
        for (const id of zoneIds(9)) {
          expect(c.componentOf(id)).toEqual(zoneIds(9));
        }
      });

      it('partitions the active set exactly once', () => {
        const c = make(grid(4, 4));
        for (const id of zoneIds(16)) {
          c.activate(id);
        }
        c.compact([zoneId(5), zoneId(6), zoneId(9), zoneId(10)]); // punch out the middle

        const components = c.components();
        const flattened = components.flat();

        // Every active member appears in exactly one component, and nothing else appears.
        expect(flattened.length).toBe(c.size);
        expect(new Set(flattened).size).toBe(c.size);

        // Canonical form: each component sorted, components ordered by their first member.
        for (const component of components) {
          expect(component).toEqual([...component].sort());
        }
        const heads = components.map((component) => component[0]);
        expect(heads).toEqual([...heads].sort());
      });
    });
  });
}
