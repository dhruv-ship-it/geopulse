import { ZoneStateStore } from '../zoneStateStore';
import { TimeWindowManager } from '../timeWindowManager';
import { ZoneStateData } from '../types';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

const newState = (): ZoneStateData => ({
  currentState: 'NORMAL',
  window1m: TimeWindowManager.createWindow(),
  window5m: TimeWindowManager.createWindow(),
  stressedSince: null,
  criticalSince: null,
  lastAlertTimestamp: null
});

function store(idleTtlMs = 15 * MINUTE, sweepIntervalMs = MINUTE) {
  return new ZoneStateStore({ idleTtlMs, sweepIntervalMs });
}

const observe = (s: ZoneStateStore, zoneId: string, at: number) =>
  s.observe(zoneId, 10, 20, at, newState);

describe('ZoneStateStore', () => {
  it('creates state on first sight and reuses it afterwards', () => {
    const s = store();
    const first = observe(s, 'Z-1', T0);
    first.state.currentState = 'STRESSED';

    const second = observe(s, 'Z-1', T0 + 1000);

    expect(second).toBe(first);
    expect(second.state.currentState).toBe('STRESSED');
    expect(s.size).toBe(1);
  });

  it('evicts a zone once the watermark passes its last event by the idle TTL', () => {
    const s = store(15 * MINUTE, MINUTE);
    observe(s, 'Z-quiet', T0);
    observe(s, 'Z-busy', T0);

    // Advance the watermark past the TTL using the busy zone only.
    observe(s, 'Z-busy', T0 + 16 * MINUTE);
    const evicted = s.sweep();

    expect(evicted).toEqual(['Z-quiet']);
    expect(s.size).toBe(1);
    expect(s.has('Z-busy')).toBe(true);
    expect(s.evicted).toBe(1);
  });

  it('does not sweep before the sweep interval has elapsed in event time', () => {
    const s = store(MINUTE, 5 * MINUTE);
    observe(s, 'Z-quiet', T0);
    observe(s, 'Z-busy', T0 + 2 * MINUTE); // past the TTL, but not past the sweep interval

    expect(s.sweep()).toEqual([]);
    expect(s.size).toBe(2);

    observe(s, 'Z-busy', T0 + 6 * MINUTE);
    expect(s.sweep()).toEqual(['Z-quiet']);
  });

  it('keeps a zone alive for exactly the TTL and evicts it one millisecond later', () => {
    const atBoundary = store(10 * MINUTE, 0);
    observe(atBoundary, 'Z-1', T0);
    observe(atBoundary, 'Z-2', T0 + 10 * MINUTE);
    expect(atBoundary.sweep()).toEqual([]);

    const pastBoundary = store(10 * MINUTE, 0);
    observe(pastBoundary, 'Z-1', T0);
    observe(pastBoundary, 'Z-2', T0 + 10 * MINUTE + 1);
    expect(pastBoundary.sweep()).toEqual(['Z-1']);
  });

  it('never moves the watermark backwards, so an out-of-order event cannot trigger a sweep', () => {
    const s = store(10 * MINUTE, MINUTE);
    observe(s, 'Z-1', T0 + 30 * MINUTE);
    expect(s.currentWatermark).toBe(T0 + 30 * MINUTE);

    observe(s, 'Z-2', T0); // very late event
    expect(s.currentWatermark).toBe(T0 + 30 * MINUTE);
  });

  it('does not make a zone look staler when a late event for it arrives', () => {
    const s = store(10 * MINUTE, 0);
    observe(s, 'Z-1', T0 + 9 * MINUTE);
    observe(s, 'Z-1', T0); // out of order, older
    observe(s, 'Z-2', T0 + 18 * MINUTE);

    // Z-1's newest event is T0+9m, and 18m - 9m = 9m < 10m TTL, so it survives.
    expect(s.sweep()).toEqual([]);
  });

  it('uses event time, not wall clock: a fast replay evicts exactly as a real-time run would', () => {
    const replay = store(10 * MINUTE, MINUTE);
    const realtime = store(10 * MINUTE, MINUTE);

    const sequence = [
      ['Z-a', T0],
      ['Z-b', T0 + MINUTE],
      ['Z-a', T0 + 2 * MINUTE],
      ['Z-c', T0 + 20 * MINUTE]
    ] as const;

    const runEvictions: string[][] = [];
    for (const [zoneId, at] of sequence) {
      observe(replay, zoneId, at);
      runEvictions.push(replay.sweep());
    }

    // Same sequence, same result, regardless of how much wall-clock time elapsed between them.
    const otherEvictions: string[][] = [];
    for (const [zoneId, at] of sequence) {
      observe(realtime, zoneId, at);
      otherEvictions.push(realtime.sweep());
    }

    expect(runEvictions).toEqual(otherEvictions);
    expect(runEvictions.flat()).toEqual(['Z-a', 'Z-b']);
  });

  it('bounds memory under continuous zone churn', () => {
    const s = store(5 * MINUTE, MINUTE);
    let peak = 0;

    // 500 zones, each reporting once, one minute apart. Without eviction the map would hold
    // all 500; with a 5m TTL it should hold roughly six at a time.
    for (let i = 0; i < 500; i++) {
      observe(s, `Z-${i}`, T0 + i * MINUTE);
      s.sweep();
      peak = Math.max(peak, s.size);
    }

    expect(peak).toBeLessThanOrEqual(7);
    expect(s.evicted).toBeGreaterThan(490);
  });

  it('starts a zone unregistered so the first event triggers a registry write', () => {
    const s = store();
    expect(observe(s, 'Z-1', T0).registered).toBe(false);
  });
});
