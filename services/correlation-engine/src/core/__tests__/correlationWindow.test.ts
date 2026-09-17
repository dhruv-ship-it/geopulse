import { CorrelationWindow } from '../correlationWindow';

const T0 = 1768478400000; // the simulator's fixed epoch (ADR-005), so times look like real ones

/** A window with no tick gate, so `tick` and `sweep` behave identically and tests stay direct. */
function windowOf(windowMs: number, compactionIntervalMs = 0): CorrelationWindow {
  return new CorrelationWindow({ windowMs, compactionIntervalMs });
}

describe('CorrelationWindow — admission', () => {
  it('admits an unknown zone and reports it as newly active', () => {
    const w = windowOf(60000);
    expect(w.admit('Z-1', T0)).toBe(true);
    expect(w.isActive('Z-1')).toBe(true);
    expect(w.size).toBe(1);
  });

  it('reports a repeat degradation as a refresh, not an admission', () => {
    const w = windowOf(60000);
    w.admit('Z-1', T0);
    expect(w.admit('Z-1', T0 + 1000)).toBe(false);
    expect(w.stats()).toMatchObject({ admissions: 1, refreshes: 1, members: 1 });
  });

  it('slides the deadline forward on every degradation', () => {
    const w = windowOf(60000);
    w.admit('Z-1', T0);
    expect(w.memberOf('Z-1')!.expiresAt).toBe(T0 + 60000);

    w.admit('Z-1', T0 + 30000);
    expect(w.memberOf('Z-1')!.expiresAt).toBe(T0 + 90000);

    // Still active at T0+70000, which is past the deadline the first degradation set.
    expect(w.sweep(T0 + 70000)).toEqual([]);
    expect(w.isActive('Z-1')).toBe(true);
  });

  it('keeps the opening and most recent stamps apart', () => {
    const w = windowOf(60000);
    w.admit('Z-1', T0);
    w.admit('Z-1', T0 + 5000);
    w.admit('Z-1', T0 + 9000);

    expect(w.memberOf('Z-1')).toMatchObject({
      firstDegradedAt: T0,
      lastDegradedAt: T0 + 9000,
      degradations: 3
    });
  });

  it('rejects an eventTime that is not a finite number', () => {
    // A NaN event time would silently poison every comparison it touches: NaN <= x is false, so
    // the member would simply never expire. Loud beats quiet.
    const w = windowOf(60000);
    expect(() => w.admit('Z-1', Number.NaN)).toThrow(/finite/);
    expect(() => w.admit('Z-1', Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => w.release('Z-1', Number.NaN)).toThrow(/finite/);
    expect(() => w.tick(Number.NaN)).toThrow(/finite/);
    expect(() => w.sweep(Number.NaN)).toThrow(/finite/);
  });
});

describe('CorrelationWindow — out-of-order arrival', () => {
  it('does not shorten a window when an older degradation arrives late', () => {
    const w = windowOf(60000);
    w.admit('Z-1', T0 + 30000); // expires T0+90000
    w.admit('Z-1', T0 + 10000); // overtaken in the pipeline; would expire T0+70000

    expect(w.memberOf('Z-1')).toMatchObject({
      lastDegradedAt: T0 + 30000,
      expiresAt: T0 + 90000,
      firstDegradedAt: T0 + 10000
    });
    expect(w.sweep(T0 + 80000)).toEqual([]);
  });

  it('never moves the watermark backwards', () => {
    const w = windowOf(60000);
    w.admit('Z-1', T0 + 50000);
    w.admit('Z-2', T0 + 1000);
    expect(w.watermark).toBe(T0 + 50000);
  });

  it('refuses a degradation whose whole window is already behind the watermark', () => {
    const w = windowOf(60000);
    w.admit('Z-1', T0 + 200000);

    // Z-2 degraded at T0; that window closed at T0+60000, long before the watermark.
    expect(w.admit('Z-2', T0)).toBe(false);
    expect(w.isActive('Z-2')).toBe(false);
    expect(w.stats().staleAdmissions).toBe(1);
  });

  it('admits a late degradation whose window is still open', () => {
    const w = windowOf(60000);
    w.admit('Z-1', T0 + 50000);

    expect(w.admit('Z-2', T0 + 10000)).toBe(true); // expires T0+70000, past the watermark
    expect(w.isActive('Z-2')).toBe(true);
    expect(w.stats().staleAdmissions).toBe(0);
  });

  it('does not apply the staleness rule to a zone that is already a member', () => {
    const w = windowOf(60000);
    w.admit('Z-1', T0);
    w.admit('Z-2', T0 + 200000); // drags the watermark far forward

    // A stale refresh for Z-1 changes nothing, but must not evict it either.
    expect(w.admit('Z-1', T0 + 1000)).toBe(false);
    expect(w.isActive('Z-1')).toBe(true);
    expect(w.stats().staleAdmissions).toBe(0);
  });
});

describe('CorrelationWindow — expiry', () => {
  it('evicts a member once event time passes its deadline', () => {
    const w = windowOf(60000);
    w.admit('Z-1', T0);

    expect(w.sweep(T0 + 59999)).toEqual([]);
    expect(w.sweep(T0 + 60000)).toEqual(['Z-1']);
    expect(w.isActive('Z-1')).toBe(false);
  });

  it('returns the eviction batch sorted, whatever order members were admitted in', () => {
    const w = windowOf(60000);
    for (const zoneId of ['Z-9', 'Z-3', 'Z-7', 'Z-1']) {
      w.admit(zoneId, T0);
    }
    expect(w.sweep(T0 + 60000)).toEqual(['Z-1', 'Z-3', 'Z-7', 'Z-9']);
  });

  it('evicts only the members that are actually past their deadline', () => {
    const w = windowOf(60000);
    w.admit('Z-1', T0);
    w.admit('Z-2', T0 + 30000);

    expect(w.sweep(T0 + 60000)).toEqual(['Z-1']);
    expect(w.activeMembers()).toEqual(['Z-2']);
    expect(w.sweep(T0 + 90000)).toEqual(['Z-2']);
    expect(w.size).toBe(0);
  });

  it('counts expirations and sweeps', () => {
    const w = windowOf(60000);
    w.admit('Z-1', T0);
    w.admit('Z-2', T0);
    w.sweep(T0 + 1000);
    w.sweep(T0 + 60000);

    expect(w.stats()).toMatchObject({ sweeps: 2, expirations: 2, members: 0 });
  });
});

describe('CorrelationWindow — recovery', () => {
  it('drops a member immediately rather than waiting for the deadline', () => {
    const w = windowOf(120000);
    w.admit('Z-1', T0);

    expect(w.release('Z-1', T0 + 1000)).toBe(true);
    expect(w.isActive('Z-1')).toBe(false);
    expect(w.stats()).toMatchObject({ releases: 1, expirations: 0 });
  });

  it('reports false for a zone that was not a member', () => {
    const w = windowOf(120000);
    expect(w.release('Z-1')).toBe(false);
    expect(w.stats().releases).toBe(0);
  });

  it('honours a recovery that arrived late', () => {
    const w = windowOf(120000);
    w.admit('Z-1', T0 + 90000);

    // The recovery is stamped earlier than the degradation we already processed. It is still a
    // statement that the zone is healthy, so it still removes the member.
    expect(w.release('Z-1', T0 + 10000)).toBe(true);
    expect(w.isActive('Z-1')).toBe(false);
    expect(w.watermark).toBe(T0 + 90000);
  });

  it('lets a released zone be admitted again as a fresh spell', () => {
    const w = windowOf(60000);
    w.admit('Z-1', T0);
    w.release('Z-1');

    expect(w.admit('Z-1', T0 + 10000)).toBe(true);
    expect(w.memberOf('Z-1')).toMatchObject({ firstDegradedAt: T0 + 10000, degradations: 1 });
  });
});

describe('CorrelationWindow — compaction cadence', () => {
  it('sweeps only once per compaction interval of event time', () => {
    const w = new CorrelationWindow({ windowMs: 60000, compactionIntervalMs: 5000 });
    w.admit('Z-1', T0);

    w.tick(T0 + 1000); // first tick always sweeps: lastSweepAt starts at 0
    expect(w.stats().sweeps).toBe(1);

    w.tick(T0 + 2000);
    w.tick(T0 + 3000);
    expect(w.stats().sweeps).toBe(1);

    w.tick(T0 + 6000);
    expect(w.stats().sweeps).toBe(2);
  });

  it('can leave a member alive for up to one compaction interval past its deadline', () => {
    const w = new CorrelationWindow({ windowMs: 60000, compactionIntervalMs: 5000 });
    w.admit('Z-1', T0);
    w.tick(T0); // consume the startup sweep

    expect(w.tick(T0 + 60001)).toEqual(['Z-1']);

    // Now the same member, with the last sweep landing just before its deadline.
    const lagging = new CorrelationWindow({ windowMs: 60000, compactionIntervalMs: 5000 });
    lagging.admit('Z-2', T0); // deadline T0+60000
    lagging.tick(T0); // startup sweep
    expect(lagging.tick(T0 + 59000)).toEqual([]); // due, but not expired yet
    expect(lagging.tick(T0 + 61000)).toEqual([]); // expired, but the next tick is not due
    expect(lagging.isActive('Z-2')).toBe(true);
    expect(lagging.tick(T0 + 64001)).toEqual(['Z-2']); // one interval after the last sweep
  });

  it('advances the watermark even on a tick that does not sweep', () => {
    const w = new CorrelationWindow({ windowMs: 60000, compactionIntervalMs: 5000 });
    w.tick(T0);
    w.tick(T0 + 1000);
    expect(w.watermark).toBe(T0 + 1000);
  });
});

describe('CorrelationWindow — configuration and determinism', () => {
  it('rejects a non-positive window', () => {
    expect(() => new CorrelationWindow({ windowMs: 0 })).toThrow(/positive/);
    expect(() => new CorrelationWindow({ windowMs: -1 })).toThrow(/positive/);
  });

  it('rejects a negative compaction interval', () => {
    expect(() => new CorrelationWindow({ compactionIntervalMs: -1 })).toThrow(/non-negative/);
  });

  it('falls back to the documented CORRELATION_WINDOW_MS / COMPACTION_INTERVAL_MS defaults', () => {
    // 01-ARCHITECTURE.md section 7. The service passes these from env; the defaults are what a
    // bare construction gets, and they must stay in step with the doc.
    expect(new CorrelationWindow().geometry).toEqual({
      windowMs: 120000,
      compactionIntervalMs: 5000
    });
  });

  it('exposes the geometry it is working to', () => {
    const w = new CorrelationWindow({ windowMs: 1000, compactionIntervalMs: 250 });
    expect(w.geometry).toEqual({ windowMs: 1000, compactionIntervalMs: 250 });
  });

  it('produces identical membership for the same sequence replayed at a different pace', () => {
    // The point of event time: the wall clock between calls is irrelevant. Two replays of the
    // same stamped events agree exactly, whatever their real-time spacing.
    const script: Array<['admit' | 'release' | 'tick', string, number]> = [
      ['admit', 'Z-1', T0],
      ['admit', 'Z-2', T0 + 1000],
      ['tick', '', T0 + 6000],
      ['admit', 'Z-1', T0 + 40000],
      ['release', 'Z-2', T0 + 41000],
      ['admit', 'Z-3', T0 + 42000],
      ['tick', '', T0 + 70000],
      ['tick', '', T0 + 120000]
    ];

    const run = (): string => {
      const w = new CorrelationWindow({ windowMs: 60000, compactionIntervalMs: 5000 });
      const trace: string[] = [];
      for (const [op, zoneId, t] of script) {
        if (op === 'admit') trace.push(`admit ${zoneId} ${w.admit(zoneId, t)}`);
        else if (op === 'release') trace.push(`release ${zoneId} ${w.release(zoneId, t)}`);
        else trace.push(`tick ${w.tick(t).join(',')}`);
        trace.push(`  members=${w.activeMembers().join(',')}`);
      }
      return trace.join('\n');
    };

    expect(run()).toBe(run());
  });
});
