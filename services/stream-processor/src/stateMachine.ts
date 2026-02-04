import { ZoneState, ZoneStateData } from './types';

/**
 * State machine implementation for zone operational states
 * Implements exact transition rules with hysteresis and confirmation delays
 */
export class StateMachine {
  private static readonly THRESHOLD_STRESSED = 0.75;
  private static readonly THRESHOLD_CRITICAL_1M = 0.90;
  private static readonly THRESHOLD_CRITICAL_TO_STRESSED = 0.80;
  private static readonly THRESHOLD_STRESSED_TO_NORMAL = 0.65;
  
  private static readonly CONFIRMATION_STRESSED_MS = 60000; // 60 seconds
  private static readonly CONFIRMATION_CRITICAL_MS = 20000; // 20 seconds

  /**
   * Determine next state based on current metrics and state
   */
  static getNextState(
    currentState: ZoneState,
    avg1m: number,
    avg5m: number,
    currentTimestamp: number,
    stateData: ZoneStateData
  ): ZoneState {
    switch (currentState) {
      case 'NORMAL':
        return this.evaluateNormalState(avg5m, currentTimestamp, stateData);
      
      case 'STRESSED':
        return this.evaluateStressedState(avg1m, avg5m, currentTimestamp, stateData);
      
      case 'CRITICAL':
        return this.evaluateCriticalState(avg5m, currentTimestamp, stateData);
      
      default:
        return 'NORMAL';
    }
  }

  /**
   * Evaluate transitions from NORMAL state
   */
  private static evaluateNormalState(
    avg5m: number,
    currentTimestamp: number,
    stateData: ZoneStateData
  ): ZoneState {
    // NORMAL → STRESSED: avg5m ≥ 0.75 for ≥ 60 seconds
    if (avg5m >= this.THRESHOLD_STRESSED) {
      if (stateData.stressedSince === null) {
        stateData.stressedSince = currentTimestamp;
      }
      
      if (currentTimestamp - stateData.stressedSince! >= this.CONFIRMATION_STRESSED_MS) {
        stateData.stressedSince = null; // Reset for next transition
        return 'STRESSED';
      }
      return 'NORMAL'; // Still in confirmation period
    } else {
      // Condition broken, reset timer
      stateData.stressedSince = null;
      return 'NORMAL';
    }
  }

  /**
   * Evaluate transitions from STRESSED state
   */
  private static evaluateStressedState(
    avg1m: number,
    avg5m: number,
    currentTimestamp: number,
    stateData: ZoneStateData
  ): ZoneState {
    // STRESSED → CRITICAL: avg1m ≥ 0.90 for ≥ 20 seconds
    if (avg1m >= this.THRESHOLD_CRITICAL_1M) {
      if (stateData.criticalSince === null) {
        stateData.criticalSince = currentTimestamp;
      }
      
      if (currentTimestamp - stateData.criticalSince! >= this.CONFIRMATION_CRITICAL_MS) {
        stateData.criticalSince = null; // Reset for next transition
        return 'CRITICAL';
      }
      return 'STRESSED'; // Still in confirmation period
    }
    // STRESSED → NORMAL: avg5m ≤ 0.65
    else if (avg5m <= this.THRESHOLD_STRESSED_TO_NORMAL) {
      stateData.stressedSince = null;
      stateData.criticalSince = null;
      return 'NORMAL';
    }
    // Condition broken, reset timers
    else {
      stateData.criticalSince = null;
      return 'STRESSED';
    }
  }

  /**
   * Evaluate transitions from CRITICAL state
   */
  private static evaluateCriticalState(
    avg5m: number,
    currentTimestamp: number,
    stateData: ZoneStateData
  ): ZoneState {
    // CRITICAL → STRESSED: avg5m ≤ 0.80
    if (avg5m <= this.THRESHOLD_CRITICAL_TO_STRESSED) {
      stateData.criticalSince = null;
      stateData.stressedSince = currentTimestamp; // Start STRESSED confirmation timer
      return 'STRESSED';
    }
    return 'CRITICAL';
  }

  /**
   * Check if state transition should trigger an alert
   * Only alert when actual state changes, not during confirmation periods
   */
  static shouldAlert(
    previousState: ZoneState,
    currentState: ZoneState,
    lastAlertTimestamp: number | null,
    currentTimestamp: number
  ): boolean {
    // Only alert on actual state changes
    if (previousState !== currentState) {
      // Prevent duplicate alerts for same transition
      if (lastAlertTimestamp === null || currentTimestamp - lastAlertTimestamp > 1000) {
        return true;
      }
    }
    return false;
  }
}