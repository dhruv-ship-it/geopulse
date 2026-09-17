/**
 * A single simulated clock, shared by every zone.
 *
 * Why this exists (defect D8, see docs/01-ARCHITECTURE.md §3.2): event time used to be a
 * per-zone accumulator that advanced by a constant per *event*, so it ran at 0.5–10% of real
 * time and every zone ran at a different rate. Two adjacent zones degrading at the same real
 * instant carried event timestamps minutes apart, which makes the judgement the whole project
 * rests on — "these neighbouring zones degraded within the same window" — unexpressible.
 *
 * The model instead:
 *
 *   - Simulated time is a pure function of the tick count: now() = startEpochMs + ticks * stepMs.
 *     No wall-clock read, no accumulation, no per-zone state. The same tick index always yields
 *     the same timestamp, on any machine, at any speed.
 *   - Every zone reads this one clock, so "same window" is meaningful again. Per-zone sensor lag
 *     is applied on top as a bounded offset (see LoadGenerator.sensorLagMs), never as a rate.
 *   - How fast ticks happen in *real* time is a separate concern, owned by the pacing schedule
 *     below and by SimulationLoop. Changing the speed changes how long a run takes on the wall
 *     clock; it does not change a single event timestamp.
 *
 * That last property is what makes SPEED_MULTIPLIER safe. The state machine needs 60s of event
 * time to confirm STRESSED and the eval scenarios span minutes; at 60x, 60s of event time
 * elapses in one real second, so benchmarks and evals are minutes rather than overnight jobs —
 * and they produce byte-identical output to a 1x run.
 */

/** Fixed default start. A constant, not `Date.now()`, so two runs are comparable. */
export const DEFAULT_SIM_START_EPOCH_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

/** Simulated time between ticks. One event per zone per tick, so this is the sample interval. */
export const DEFAULT_SIM_STEP_MS = 1000;

/** Simulated ms per real ms. 1 = real time; 60 = a simulated minute every real second. */
export const DEFAULT_SPEED_MULTIPLIER = 1;

/**
 * Timers cannot be trusted to fire meaningfully below a few milliseconds, so at high speeds we
 * fire less often and advance several steps per firing instead of asking for a 0.3ms interval.
 */
export const DEFAULT_MIN_REAL_INTERVAL_MS = 5;

export interface VirtualClockOptions {
  startEpochMs?: number;
  stepMs?: number;
  speedMultiplier?: number;
  minRealIntervalMs?: number;
}

export class VirtualClock {
  readonly startEpochMs: number;
  readonly stepMs: number;
  readonly speedMultiplier: number;

  /** Steps to advance per real-time firing. > 1 only when the ideal interval is too small. */
  readonly stepsPerRealTick: number;

  /** Real milliseconds between firings. May be fractional; SimulationLoop paces by deadline. */
  readonly realTickIntervalMs: number;

  private ticks = 0;

  constructor(options: VirtualClockOptions = {}) {
    const startEpochMs = options.startEpochMs ?? DEFAULT_SIM_START_EPOCH_MS;
    const stepMs = options.stepMs ?? DEFAULT_SIM_STEP_MS;
    const speedMultiplier = options.speedMultiplier ?? DEFAULT_SPEED_MULTIPLIER;
    const minRealIntervalMs = options.minRealIntervalMs ?? DEFAULT_MIN_REAL_INTERVAL_MS;

    if (!Number.isInteger(startEpochMs)) {
      throw new Error(`SIM_START_EPOCH_MS must be an integer, got ${startEpochMs}`);
    }
    if (!Number.isInteger(stepMs) || stepMs < 1) {
      throw new Error(`SIM_STEP_MS must be an integer >= 1, got ${stepMs}`);
    }
    if (!Number.isFinite(speedMultiplier) || speedMultiplier <= 0) {
      throw new Error(`SPEED_MULTIPLIER must be > 0, got ${speedMultiplier}`);
    }
    if (!Number.isFinite(minRealIntervalMs) || minRealIntervalMs <= 0) {
      throw new Error(`minRealIntervalMs must be > 0, got ${minRealIntervalMs}`);
    }

    this.startEpochMs = startEpochMs;
    this.stepMs = stepMs;
    this.speedMultiplier = speedMultiplier;

    // Ideal spacing between single steps in real time. If that is below what a timer can
    // honour, batch whole steps together so the *rate* still works out to exactly the
    // requested multiplier — never by shortening or stretching a step.
    const idealRealIntervalMs = stepMs / speedMultiplier;
    this.stepsPerRealTick =
      idealRealIntervalMs >= minRealIntervalMs
        ? 1
        : Math.ceil(minRealIntervalMs / idealRealIntervalMs);
    this.realTickIntervalMs = (this.stepsPerRealTick * stepMs) / speedMultiplier;
  }

  /** Current simulated time, in epoch milliseconds. */
  now(): number {
    return this.startEpochMs + this.ticks * this.stepMs;
  }

  /** Advance one step and return the new simulated time. */
  tick(): number {
    this.ticks += 1;
    return this.now();
  }

  /** Advance `steps` steps and return the new simulated time. */
  advance(steps: number): number {
    if (!Number.isInteger(steps) || steps < 0) {
      throw new Error(`steps must be a non-negative integer, got ${steps}`);
    }
    this.ticks += steps;
    return this.now();
  }

  /** Back to the start epoch. The clock holds no other state, so this is a full reset. */
  reset(): void {
    this.ticks = 0;
  }

  get tickCount(): number {
    return this.ticks;
  }

  /** Simulated milliseconds elapsed since the start epoch. */
  get elapsedMs(): number {
    return this.ticks * this.stepMs;
  }

  /**
   * The achieved rate of the pacing schedule: simulated ms per real ms. Equal to
   * speedMultiplier by construction — asserted in the tests so a schedule change cannot
   * quietly distort the relationship between simulated and real time.
   */
  get simulatedMsPerRealMs(): number {
    return (this.stepsPerRealTick * this.stepMs) / this.realTickIntervalMs;
  }

  /** Events emitted per real second, given a zone count. Useful for logging and benchmarks. */
  eventsPerRealSecond(zoneCount: number): number {
    return (zoneCount * this.stepsPerRealTick * 1000) / this.realTickIntervalMs;
  }
}
