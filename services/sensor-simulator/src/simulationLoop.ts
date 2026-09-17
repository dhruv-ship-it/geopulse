import { VirtualClock } from './virtualClock';

export type NowFn = () => number;

/**
 * Paces a VirtualClock against real time.
 *
 * This is the one place in the simulator allowed to read the wall clock, and it reads it only
 * to decide *when* to fire — never to stamp an event. Event timestamps come from the tick
 * count alone (see VirtualClock), so timer jitter, a slow Kafka send or a different
 * SPEED_MULTIPLIER change how long a run takes without changing what the run contains.
 *
 * Scheduling is deadline-based rather than a fixed `setInterval`: firing n is due at
 * `startedAt + n * realTickIntervalMs`. A late firing therefore does not push every later one
 * back, which matters because realTickIntervalMs is usually fractional and timers round.
 */
export class SimulationLoop {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private startedAtRealMs = 0;
  private firings = 0;

  constructor(
    private readonly clock: VirtualClock,
    private readonly onTick: (stepTimes: number[]) => void | Promise<void>,
    private readonly now: NowFn = Date.now
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.startedAtRealMs = this.now();
    this.firings = 0;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Real milliseconds since start(), by the loop's own clock source. */
  realElapsedMs(): number {
    return this.now() - this.startedAtRealMs;
  }

  private scheduleNext(): void {
    if (!this.running) {
      return;
    }

    const dueAt = this.startedAtRealMs + (this.firings + 1) * this.clock.realTickIntervalMs;
    const delay = Math.max(0, dueAt - this.now());

    this.timer = setTimeout(() => {
      void this.fire();
    }, delay);
  }

  private async fire(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.firings += 1;

    const stepTimes: number[] = [];
    for (let i = 0; i < this.clock.stepsPerRealTick; i++) {
      stepTimes.push(this.clock.tick());
    }

    try {
      await this.onTick(stepTimes);
    } finally {
      this.scheduleNext();
    }
  }
}
