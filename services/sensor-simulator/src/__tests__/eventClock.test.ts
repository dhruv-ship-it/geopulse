import { LoadGenerator } from '../loadGenerator';
import { SimulationLoop } from '../simulationLoop';
import { VirtualClock, DEFAULT_SIM_START_EPOCH_MS } from '../virtualClock';
import { ZoneGenerator } from '../zoneGenerator';
import { SensorEvent } from '../types';

/**
 * Regression suite for D8 (docs/01-ARCHITECTURE.md §3.2).
 *
 * The defect: event time was a per-zone accumulator advanced by a constant per event, so it ran
 * at 0.5–10% of real time and every zone ran at a *different* rate — 20x spread within 60
 * seconds, growing without bound. Spatial correlation rests entirely on "these adjacent zones
 * degraded within the same window", so that spread made the premise of Phase 1 untestable.
 *
 * These tests pin the three properties that replace it: event time tracks real time at exactly
 * the configured multiplier, zones never diverge beyond the bounded sensor lag however long the
 * run, and the event stream is a pure function of the simulated span — identical at any speed.
 */

const ZONES = ZoneGenerator.generateZones(10);

/** Drive the clock directly for `steps` ticks, collecting every event. */
function streamFor(clock: VirtualClock, steps: number): SensorEvent[] {
  const events: SensorEvent[] = [];
  for (let i = 0; i < steps; i++) {
    const simNow = clock.tick();
    for (const zone of ZONES) {
      events.push(LoadGenerator.generateEvent(zone, 'spike', simNow));
    }
  }
  return events;
}

describe('VirtualClock', () => {
  it('advances by exactly stepMs per tick from a fixed epoch, with no wall-clock input', () => {
    const clock = new VirtualClock({ stepMs: 1000 });

    expect(clock.now()).toBe(DEFAULT_SIM_START_EPOCH_MS);
    expect(clock.tick()).toBe(DEFAULT_SIM_START_EPOCH_MS + 1000);
    expect(clock.tick()).toBe(DEFAULT_SIM_START_EPOCH_MS + 2000);
    expect(clock.advance(58)).toBe(DEFAULT_SIM_START_EPOCH_MS + 60_000);
    expect(clock.elapsedMs).toBe(60_000);
  });

  it('paces to exactly the requested simulated-per-real rate, at every speed', () => {
    for (const speedMultiplier of [0.5, 1, 10, 60, 600, 3600]) {
      const clock = new VirtualClock({ stepMs: 1000, speedMultiplier });
      expect(clock.simulatedMsPerRealMs).toBeCloseTo(speedMultiplier, 6);
    }
  });

  it('batches steps rather than asking for a timer interval no timer can honour', () => {
    // 1000x with a 1s step would want a firing every 1ms. Instead: fire every 5ms, five steps
    // at a time. The rate is unchanged; only the granularity of real-time pacing is.
    const clock = new VirtualClock({ stepMs: 1000, speedMultiplier: 1000, minRealIntervalMs: 5 });

    expect(clock.stepsPerRealTick).toBe(5);
    expect(clock.realTickIntervalMs).toBe(5);
    expect(clock.simulatedMsPerRealMs).toBeCloseTo(1000, 6);
  });

  it('rejects a configuration that cannot produce a coherent clock', () => {
    expect(() => new VirtualClock({ stepMs: 0 })).toThrow(/SIM_STEP_MS/);
    expect(() => new VirtualClock({ stepMs: 1.5 })).toThrow(/SIM_STEP_MS/);
    expect(() => new VirtualClock({ speedMultiplier: 0 })).toThrow(/SPEED_MULTIPLIER/);
    expect(() => new VirtualClock({ speedMultiplier: -1 })).toThrow(/SPEED_MULTIPLIER/);
  });
});

describe('per-zone sensor lag', () => {
  it('is a bounded offset, deterministic in the zone id', () => {
    for (const zone of ZoneGenerator.generateZones(500)) {
      const lag = LoadGenerator.sensorLagMs(zone.zoneId);
      expect(lag).toBeGreaterThanOrEqual(0);
      expect(lag).toBeLessThanOrEqual(LoadGenerator.MAX_SENSOR_LAG_MS);
      expect(LoadGenerator.sensorLagMs(zone.zoneId)).toBe(lag);
    }
  });

  it('still delivers out-of-order arrival across zones', () => {
    // The lag exists on purpose: the consumer should face events that do not arrive in event
    // order. A single lag value for every zone would quietly remove that.
    const lags = new Set(ZoneGenerator.generateZones(50).map((z) => LoadGenerator.sensorLagMs(z.zoneId)));
    expect(lags.size).toBeGreaterThan(5);
  });

  it('keeps every zone within the lag bound of every other, over a 24-hour simulated run', () => {
    // The D8 assertion. Under the old accumulator this spread grew without limit — 5.7 seconds
    // after one simulated minute, hours after a day. A long run is the point: a 60-second
    // window would have looked almost fine.
    const clock = new VirtualClock({ stepMs: 1000 });
    const zones = ZoneGenerator.generateZones(20);
    const firstEventTimes = new Map<string, number>();
    let lastEventTimes = new Map<string, number>();

    const simulatedHours = 24;
    const steps = simulatedHours * 60 * 60;

    for (let i = 0; i < steps; i++) {
      const simNow = clock.tick();
      if (i % 10 !== 0) {
        continue;
      }

      const eventTimes = new Map<string, number>();
      for (const zone of zones) {
        eventTimes.set(
          zone.zoneId,
          LoadGenerator.generateEvent(zone, 'normal', simNow).eventTimestamp
        );
      }

      const values = [...eventTimes.values()];
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(
        LoadGenerator.MAX_SENSOR_LAG_MS
      );

      for (const [zoneId, t] of eventTimes) {
        if (!firstEventTimes.has(zoneId)) {
          firstEventTimes.set(zoneId, t);
        }
      }
      lastEventTimes = eventTimes;
    }

    // Every zone advanced through event time by the same amount: the lag is an offset, not a
    // rate. Any per-zone difference here would be an accumulator creeping back in.
    const advances = new Set(
      zones.map((z) => lastEventTimes.get(z.zoneId)! - firstEventTimes.get(z.zoneId)!)
    );
    expect(advances.size).toBe(1);
    // Sampled steps are 0, 10, 20, ... so the span covered is (steps - 10) ticks.
    expect([...advances][0]).toBe((steps - 10) * clock.stepMs);
  });
});

describe('determinism of the event stream', () => {
  it('produces byte-identical output for the same configuration', () => {
    const a = streamFor(new VirtualClock({ stepMs: 1000 }), 300);
    const b = streamFor(new VirtualClock({ stepMs: 1000 }), 300);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toHaveLength(300 * ZONES.length);
  });

  it('assigns deterministic event ids, so two runs are comparable record by record', () => {
    const a = streamFor(new VirtualClock({ stepMs: 1000 }), 5);
    const b = streamFor(new VirtualClock({ stepMs: 1000 }), 5);

    expect(a.map((e) => e.eventId)).toEqual(b.map((e) => e.eventId));
    expect(new Set(a.map((e) => e.eventId)).size).toBe(a.length);
  });

  it('produces the same events at any speed — speed changes only how long the run takes', () => {
    const slow = streamFor(new VirtualClock({ stepMs: 1000, speedMultiplier: 1 }), 120);
    const fast = streamFor(new VirtualClock({ stepMs: 1000, speedMultiplier: 60 }), 120);
    const veryFast = streamFor(new VirtualClock({ stepMs: 1000, speedMultiplier: 1000 }), 120);

    expect(JSON.stringify(fast)).toBe(JSON.stringify(slow));
    expect(JSON.stringify(veryFast)).toBe(JSON.stringify(slow));
  });

  it('starts from a fixed epoch, not from whenever the process happened to start', () => {
    const [first] = streamFor(new VirtualClock({ stepMs: 1000 }), 1);
    expect(first.producedAt).toBe(DEFAULT_SIM_START_EPOCH_MS + 1000);
    expect(first.eventTimestamp).toBe(
      first.producedAt - LoadGenerator.sensorLagMs(first.zoneId)
    );
  });
});

describe('SimulationLoop', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Run a loop for `realMs` of (faked) real time and return everything it emitted. */
  async function runLoop(
    clock: VirtualClock,
    realMs: number
  ): Promise<{ events: SensorEvent[]; loop: SimulationLoop }> {
    const events: SensorEvent[] = [];
    const loop = new SimulationLoop(clock, (stepTimes) => {
      for (const simNow of stepTimes) {
        for (const zone of ZONES) {
          events.push(LoadGenerator.generateEvent(zone, 'spike', simNow));
        }
      }
    });

    loop.start();
    await jest.advanceTimersByTimeAsync(realMs);
    loop.stop();

    return { events, loop };
  }

  /** Pace the clock with no payload work � for the tests that are about the rate itself. */
  async function runBare(clock: VirtualClock, realMs: number): Promise<void> {
    const loop = new SimulationLoop(clock, () => {});
    loop.start();
    await jest.advanceTimersByTimeAsync(realMs);
    loop.stop();
  }

  it('advances event time at exactly SPEED_MULTIPLIER times the real rate', async () => {
    for (const speedMultiplier of [1, 10, 60, 600]) {
      const clock = new VirtualClock({ stepMs: 1000, speedMultiplier });
      const realMs = 60_000;

      await runBare(clock, realMs);

      // Exact to within the granularity of one firing — the clock cannot land between steps.
      const expected = realMs * speedMultiplier;
      const granularity = clock.stepsPerRealTick * clock.stepMs;
      expect(Math.abs(clock.elapsedMs - expected)).toBeLessThanOrEqual(granularity);
    }
  });

  it('runs a 60s STRESSED confirmation window in one real second at 60x', async () => {
    // This is what makes evals practical: the state machine needs 60s of *event* time before it
    // will confirm STRESSED (stream-processor/src/stateMachine.ts).
    const clock = new VirtualClock({ stepMs: 1000, speedMultiplier: 60 });
    await runLoop(clock, 1_000);

    expect(clock.elapsedMs).toBeGreaterThanOrEqual(60_000);
  });

  it('emits the identical event stream at 1x and at 10x, for the same simulated span', async () => {
    const slow = await runLoop(new VirtualClock({ stepMs: 1000, speedMultiplier: 1 }), 10_000);
    const fast = await runLoop(new VirtualClock({ stepMs: 1000, speedMultiplier: 10 }), 1_000);

    expect(fast.events).toHaveLength(slow.events.length);
    expect(JSON.stringify(fast.events)).toBe(JSON.stringify(slow.events));
  });

  it('does not accumulate timer rounding error over a long run', async () => {
    // Deadlines are absolute, so a firing that lands late does not push the whole schedule
    // back. With a fractional interval (1000/60 = 16.67ms) a naive setInterval would drift.
    const clock = new VirtualClock({ stepMs: 1000, speedMultiplier: 60 });
    await runBare(clock, 600_000);

    const drift = Math.abs(clock.elapsedMs - 600_000 * 60);
    expect(drift).toBeLessThanOrEqual(clock.stepsPerRealTick * clock.stepMs);
  });

  it('stops advancing once stopped', async () => {
    const clock = new VirtualClock({ stepMs: 1000, speedMultiplier: 60 });
    const { loop } = await runLoop(clock, 5_000);

    const atStop = clock.elapsedMs;
    expect(loop.isRunning()).toBe(false);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(clock.elapsedMs).toBe(atStop);
  });
});
