import { StateMachine } from '../stateMachine';
import { ZoneStateData, ZoneState } from '../types';

const baseStateData = (): ZoneStateData => ({
  currentState: 'NORMAL',
  window1m: { buckets: new Map(), totalSum: 0, totalCount: 0 },
  window5m: { buckets: new Map(), totalSum: 0, totalCount: 0 },
  stressedSince: null,
  criticalSince: null,
  lastAlertTimestamp: null,
});

describe('StateMachine transitions', () => {
  it('NORMAL → STRESSED after confirmation window', () => {
    const stateData = baseStateData();
    const t0 = 1_000_000;

    const first = StateMachine.getNextState('NORMAL', 0.5, 0.8, t0, stateData);
    expect(first).toBe('NORMAL');
    expect(stateData.stressedSince).toBe(t0);

    const second = StateMachine.getNextState('NORMAL', 0.5, 0.8, t0 + 60_000, stateData);
    expect(second).toBe('STRESSED');
    expect(stateData.stressedSince).toBeNull();
  });

  it('STRESSED → CRITICAL after confirmation window', () => {
    const stateData = baseStateData();
    const t0 = 2_000_000;

    const first = StateMachine.getNextState('STRESSED', 0.92, 0.8, t0, stateData);
    expect(first).toBe('STRESSED');
    expect(stateData.criticalSince).toBe(t0);

    const second = StateMachine.getNextState('STRESSED', 0.92, 0.8, t0 + 20_000, stateData);
    expect(second).toBe('CRITICAL');
    expect(stateData.criticalSince).toBeNull();
  });

  it('CRITICAL → STRESSED when avg5m drops', () => {
    const stateData = baseStateData();
    const t0 = 3_000_000;

    const next = StateMachine.getNextState('CRITICAL', 0.4, 0.8, t0, stateData);
    expect(next).toBe('STRESSED');
    expect(stateData.stressedSince).toBe(t0);
  });

  it('STRESSED → NORMAL when avg5m recovers', () => {
    const stateData = baseStateData();
    const t0 = 4_000_000;
    stateData.stressedSince = t0 - 10_000;

    const next = StateMachine.getNextState('STRESSED', 0.4, 0.6, t0, stateData);
    expect(next).toBe('NORMAL');
    expect(stateData.stressedSince).toBeNull();
    expect(stateData.criticalSince).toBeNull();
  });

  it('No transition when averages below thresholds', () => {
    const stateData = baseStateData();
    const t0 = 5_000_000;

    const next = StateMachine.getNextState('NORMAL', 0.4, 0.7, t0, stateData);
    expect(next).toBe('NORMAL');
    expect(stateData.stressedSince).toBeNull();
  });
});

describe('StateMachine edge threshold values', () => {
  it('should transition NORMAL → STRESSED exactly at threshold 0.75', () => {
    const stateData = baseStateData();
    const t0 = 1_000_000;

    const first = StateMachine.getNextState('NORMAL', 0.5, 0.75, t0, stateData);
    expect(first).toBe('NORMAL');
    expect(stateData.stressedSince).toBe(t0);

    const second = StateMachine.getNextState('NORMAL', 0.5, 0.75, t0 + 60_000, stateData);
    expect(second).toBe('STRESSED');
  });

  it('should transition STRESSED → CRITICAL exactly at threshold 0.90', () => {
    const stateData = baseStateData();
    const t0 = 2_000_000;

    const first = StateMachine.getNextState('STRESSED', 0.90, 0.90, t0, stateData);
    expect(first).toBe('STRESSED');
    expect(stateData.criticalSince).toBe(t0);

    const second = StateMachine.getNextState('STRESSED', 0.90, 0.90, t0 + 20_000, stateData);
    expect(second).toBe('CRITICAL');
  });

  it('should transition STRESSED → NORMAL exactly at threshold 0.65', () => {
    const stateData = baseStateData();
    const t0 = 3_000_000;

    const next = StateMachine.getNextState('STRESSED', 0.5, 0.65, t0, stateData);
    expect(next).toBe('NORMAL');
    expect(stateData.stressedSince).toBeNull();
    expect(stateData.criticalSince).toBeNull();
  });

  it('should transition CRITICAL → STRESSED exactly at threshold 0.80', () => {
    const stateData = baseStateData();
    const t0 = 4_000_000;

    const next = StateMachine.getNextState('CRITICAL', 0.5, 0.80, t0, stateData);
    expect(next).toBe('STRESSED');
    expect(stateData.criticalSince).toBeNull();
    expect(stateData.stressedSince).toBe(t0);
  });
});

describe('StateMachine confirmation window boundary conditions', () => {
  it('should not transition before confirmation window expires', () => {
    const stateData = baseStateData();
    const t0 = 1_000_000 + 50_000; // Only 50 seconds

    const next = StateMachine.getNextState('NORMAL', 0.5, 0.75, t0, stateData);
    expect(next).toBe('NORMAL'); // Still in confirmation
    expect(stateData.stressedSince).toBe(t0);
  });

  it('should transition exactly when confirmation window expires', () => {
    const stateData = baseStateData();
    const startTime = 1_000_000;
    const confirmationTime = startTime + 60_000; // Exactly 60 seconds

    const first = StateMachine.getNextState('NORMAL', 0.5, 0.75, startTime, stateData);
    expect(first).toBe('NORMAL');

    const second = StateMachine.getNextState('NORMAL', 0.5, 0.75, confirmationTime, stateData);
    expect(second).toBe('STRESSED');
    expect(stateData.stressedSince).toBeNull(); // Reset after transition
  });
});

describe('StateMachine reset logic on downgrade transitions', () => {
  it('should reset timers when conditions break', () => {
    const stateData = baseStateData();
    const t0 = 1_000_000;

    // Start NORMAL → STRESSED confirmation
    StateMachine.getNextState('NORMAL', 0.5, 0.8, t0, stateData);
    expect(stateData.stressedSince).toBe(t0);

    // Break condition before confirmation
    const next = StateMachine.getNextState('NORMAL', 0.5, 0.7, t0 + 30_000, stateData);
    expect(next).toBe('NORMAL');
    expect(stateData.stressedSince).toBeNull(); // Reset
  });

  it('should handle rapid threshold crossing', () => {
    const stateData = baseStateData();
    const t0 = 1_000_000;

    // Cross stressed threshold multiple times quickly
    StateMachine.getNextState('NORMAL', 0.5, 0.8, t0, stateData);
    StateMachine.getNextState('NORMAL', 0.5, 0.7, t0 + 1_000, stateData);

    expect(stateData.stressedSince).toBeNull(); // Should reset
  });
});

describe('StateMachine shouldAlert', () => {
  it('alerts on state change with no previous alert', () => {
    expect(StateMachine.shouldAlert('NORMAL', 'STRESSED', null, 10_000)).toBe(true);
  });

  it('does not alert when state unchanged', () => {
    expect(StateMachine.shouldAlert('NORMAL', 'NORMAL', null, 10_000)).toBe(false);
  });

  it('respects alert cooldown window', () => {
    const previousState: ZoneState = 'STRESSED';
    const currentState: ZoneState = 'CRITICAL';
    const lastAlertTimestamp = 10_000;

    expect(StateMachine.shouldAlert(previousState, currentState, lastAlertTimestamp, 10_500)).toBe(false);
    expect(StateMachine.shouldAlert(previousState, currentState, lastAlertTimestamp, 11_001)).toBe(true);
  });

  it('allows first alert with null timestamp', () => {
    expect(StateMachine.shouldAlert('NORMAL', 'STRESSED', null, 10_000)).toBe(true);
  });
});

describe('StateMachine default state handling', () => {
  it('returns NORMAL for invalid state', () => {
    const stateData = baseStateData();
    const next = StateMachine.getNextState('INVALID' as ZoneState, 0.5, 0.5, 1_000_000, stateData);
    expect(next).toBe('NORMAL');
  });
});
