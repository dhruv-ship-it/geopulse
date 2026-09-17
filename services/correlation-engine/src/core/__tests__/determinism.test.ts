import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { describePartition } from '../connectivity';
import { NaiveConnectivity } from '../naiveConnectivity';
import { TimeAwareConnectivity } from '../timeAwareConnectivity';
import { BASE_EVENT_TIME, FuzzEvent, driveBoth } from './support/driver';
import { grid, zoneId } from './support/graphs';

const CORE_DIR = join(__dirname, '..');

describe('determinism guards', () => {
  it('has no wall-clock or randomness anywhere in the correlation core', () => {
    // CLAUDE.md rule 3. This is a grep with teeth: a future change that reaches for Date.now()
    // or Math.random() on a hot path fails the suite instead of quietly making replays
    // irreproducible, which is the kind of defect that only shows up as two benchmark runs
    // disagreeing by a few percent and being blamed on the machine.
    const sources = readdirSync(CORE_DIR).filter((name) => name.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(0);

    for (const name of sources) {
      const source = readFileSync(join(CORE_DIR, name), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(code).not.toMatch(/Date\.now/);
      expect(code).not.toMatch(/Math\.random/);
      expect(code).not.toMatch(/new Date\b/);
      expect(code).not.toMatch(/process\.hrtime/);
    }
  });

  it('replays an event sequence to a byte-identical trace', () => {
    const events: FuzzEvent[] = [
      { kind: 'degrade', zone: 0, dt: 0 },
      { kind: 'degrade', zone: 1, dt: 800 },
      { kind: 'degrade', zone: 4, dt: 1200 },
      { kind: 'tick', dt: 6000 },
      { kind: 'degrade', zone: 3, dt: -400 },
      { kind: 'degrade', zone: 7, dt: 2500 },
      { kind: 'recover', zone: 4, dt: 1000 },
      { kind: 'tick', dt: 30000 },
      { kind: 'degrade', zone: 8, dt: 500 },
      { kind: 'tick', dt: 60000 },
      { kind: 'degrade', zone: 5, dt: 100 },
      { kind: 'tick', dt: 120000 }
    ];

    const run = () =>
      driveBoth(grid(3, 3), events, zoneId, { windowMs: 60000, compactionIntervalMs: 5000 });

    const first = run();
    const second = run();

    expect(first.divergence).toBeNull();
    expect(second.finalPartition).toBe(first.finalPartition);
    expect(second.splits).toBe(first.splits);
    expect(second.expired).toBe(first.expired);
    expect(second.maxComponentSize).toBe(first.maxComponentSize);
  });

  it('emits components in the same canonical order from both implementations', () => {
    // WP2b will derive incident ids from these member lists, so the order has to be a function
    // of the members and nothing else — not of which structure produced them.
    const adjacency = grid(4, 3);
    const optimised = new TimeAwareConnectivity(adjacency);
    const naive = new NaiveConnectivity(adjacency);

    for (const index of [11, 0, 7, 3, 4, 8, 1]) {
      optimised.activate(zoneId(index));
      naive.activate(zoneId(index));
    }
    optimised.compact([zoneId(4)]);
    naive.compact([zoneId(4)]);

    expect(describePartition(optimised.components())).toBe(describePartition(naive.components()));
    expect(optimised.components()).toEqual(naive.components());
  });

  it('pins the event-time epoch the fuzz and the simulator share', () => {
    // 2026-01-15T12:00:00Z, SIM_START_EPOCH_MS from ADR-005. Hard-coded on purpose: a wall-clock
    // base would make every committed fuzz trace unreproducible tomorrow.
    expect(BASE_EVENT_TIME).toBe(1768478400000);
    expect(new Date(BASE_EVENT_TIME).toISOString()).toBe('2026-01-15T12:00:00.000Z');
  });
});
