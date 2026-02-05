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
});
