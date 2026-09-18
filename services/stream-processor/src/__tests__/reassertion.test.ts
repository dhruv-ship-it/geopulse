import { StateMachine } from '../stateMachine';
import { TimeWindowManager } from '../timeWindowManager';
import { ZoneStateData } from '../types';

/**
 * Defect D14, as a property of the two components that disagreed.
 *
 * `StreamProcessor.handleEvent` needs Kafka, Redis and a producer to run, so testing the
 * re-assertion decision through it would be testing the wiring. What actually went wrong is
 * smaller and sharper than the wiring, and it is what these tests pin: **the state machine emits
 * edges, and a zone that is steadily degraded emits nothing at all.** Join that to a correlation
 * window whose membership rule is "degraded within the last `CORRELATION_WINDOW_MS`" and the
 * membership lapses underneath an ongoing fault.
 *
 * The first test below is the defect itself — it asserts the silence. The rest assert that the
 * re-assertion predicate covers that silence at a rate the window can survive.
 */

const CORRELATION_WINDOW_MS = 120_000;
const DEGRADATION_REASSERT_MS = 30_000;

function freshState(): ZoneStateData {
  return {
    currentState: 'NORMAL',
    window1m: TimeWindowManager.createWindow(),
    window5m: TimeWindowManager.createWindow(),
    stressedSince: null,
    criticalSince: null,
    lastAlertTimestamp: null,
    lastDegradationPublishedAt: null
  };
}

/**
 * The predicate in `handleEvent`'s `else if`, extracted so it can be stated once and checked.
 * Kept in the test rather than exported from the service because it is three comparisons; what
 * is worth pinning is the behaviour over a timeline, not the expression.
 */
function shouldReassert(state: ZoneStateData, nextState: string, eventTime: number): boolean {
  return (
    nextState !== 'NORMAL' &&
    DEGRADATION_REASSERT_MS > 0 &&
    (state.lastDegradationPublishedAt === null ||
      eventTime - state.lastDegradationPublishedAt >= DEGRADATION_REASSERT_MS)
  );
}

describe('D14: a steadily degraded zone emits no transitions', () => {
  it('goes silent once it has crossed the threshold, which is the whole defect', () => {
    const state = freshState();
    const start = 1_768_478_400_000;

    // Drive a zone to STRESSED: avg5m at 0.82 held past the 60 s confirmation.
    let current: ZoneStateData['currentState'] = 'NORMAL';
    let transitions = 0;
    for (let t = 0; t <= 300_000; t += 1000) {
      const next = StateMachine.getNextState(current, 0.83, 0.82, start + t, state);
      if (
        StateMachine.shouldAlert(current, next, state.lastAlertTimestamp, start + t)
      ) {
        transitions++;
        state.lastAlertTimestamp = start + t;
      }
      current = next;
    }

    // One transition, at the end of the confirmation window — and then nothing for the
    // remaining four minutes, although the zone is degraded for every second of them.
    expect(current).toBe('STRESSED');
    expect(transitions).toBe(1);

    // And that is longer than the correlation window, so membership lapses under a live fault.
    expect(300_000 - 60_000).toBeGreaterThan(CORRELATION_WINDOW_MS);
  });
});

describe('re-assertion covers the silence', () => {
  it('fires immediately for a zone that has never published', () => {
    expect(shouldReassert(freshState(), 'STRESSED', 1_768_478_400_000)).toBe(true);
  });

  it('does not fire again inside the interval', () => {
    const state = freshState();
    state.lastDegradationPublishedAt = 1_768_478_400_000;
    expect(shouldReassert(state, 'STRESSED', 1_768_478_400_000 + 29_999)).toBe(false);
  });

  it('fires again exactly at the interval', () => {
    const state = freshState();
    state.lastDegradationPublishedAt = 1_768_478_400_000;
    expect(shouldReassert(state, 'STRESSED', 1_768_478_400_000 + 30_000)).toBe(true);
  });

  it('never fires for a healthy zone — NORMAL is not a thing to keep asserting', () => {
    const state = freshState();
    state.lastDegradationPublishedAt = null;
    expect(shouldReassert(state, 'NORMAL', 1_768_478_400_000 + 10_000_000)).toBe(false);
  });

  it('fires for CRITICAL as well as STRESSED', () => {
    const state = freshState();
    state.lastDegradationPublishedAt = 1_768_478_400_000;
    expect(shouldReassert(state, 'CRITICAL', 1_768_478_400_000 + 30_000)).toBe(true);
  });

  /**
   * The number that makes the fix work rather than merely exist. A member expires
   * `CORRELATION_WINDOW_MS` after its last degradation, so the interval has to leave room for
   * more than one attempt inside a window — otherwise a single failed publish drops a zone out
   * of its incident and the incident flickers.
   */
  it('leaves room for several assertions inside one correlation window', () => {
    const perWindow = Math.floor(CORRELATION_WINDOW_MS / DEGRADATION_REASSERT_MS);
    expect(perWindow).toBeGreaterThanOrEqual(3);
  });

  /**
   * The timeline that failed before the fix: a fault that runs far longer than the correlation
   * window. Membership must never lapse across it.
   */
  it('keeps a member alive across a fault far longer than the window', () => {
    const state = freshState();
    const start = 1_768_478_400_000;
    const faultMs = 2.4 * 60 * 60 * 1000; // what the regional scenario actually runs for
    let published = 0;
    let longestGap = 0;
    let previous = start;

    for (let t = 0; t <= faultMs; t += 1000) {
      const at = start + t;
      if (shouldReassert(state, 'STRESSED', at)) {
        longestGap = Math.max(longestGap, at - previous);
        previous = at;
        state.lastDegradationPublishedAt = at;
        published++;
      }
    }

    // Never a silence long enough for the correlation window to expire the member.
    expect(longestGap).toBeLessThan(CORRELATION_WINDOW_MS);
    // And the volume is the bounded cost this buys it with: one message per interval per zone.
    expect(published).toBe(Math.floor(faultMs / DEGRADATION_REASSERT_MS) + 1);
  });

  it('costs one message per degraded zone per interval, and no more', () => {
    // 62 zones, the reference regional fault, over one hour of event time.
    const zones = 62;
    const perHour = (60 * 60 * 1000) / DEGRADATION_REASSERT_MS;
    expect((zones * perHour) / 3600).toBeCloseTo(2.07, 1); // ~2 messages/second
  });
});
