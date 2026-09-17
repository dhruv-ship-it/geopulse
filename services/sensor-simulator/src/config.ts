import { SimulatorConfig } from './types';
import {
  DEFAULT_SIM_START_EPOCH_MS,
  DEFAULT_SIM_STEP_MS,
  DEFAULT_SPEED_MULTIPLIER
} from './virtualClock';

export const DEFAULT_CONFIG: SimulatorConfig = {
  numberOfZones: 10,
  scenario: 'normal',
  logEveryNEvents: 100,
  startEpochMs: DEFAULT_SIM_START_EPOCH_MS,
  stepMs: DEFAULT_SIM_STEP_MS,
  speedMultiplier: DEFAULT_SPEED_MULTIPLIER
};

/**
 * `EVENTS_PER_SECOND` is deliberately gone. It used to mean "timer firings per real second",
 * which conflated two independent things: how densely a zone is sampled in simulated time
 * (SIM_STEP_MS) and how fast simulated time runs (SPEED_MULTIPLIER). The real event rate is now
 * a derived quantity:
 *
 *   events per real second = NUM_ZONES * (1000 / SIM_STEP_MS) * SPEED_MULTIPLIER
 */
export function loadConfig(): SimulatorConfig {
  return {
    numberOfZones: parseInt(process.env.NUM_ZONES || '10', 10),
    scenario: (process.env.SCENARIO as 'normal' | 'spike' | 'drop') || 'normal',
    logEveryNEvents: parseInt(process.env.LOG_EVERY_N || '100', 10),
    startEpochMs: parseInt(
      process.env.SIM_START_EPOCH_MS || String(DEFAULT_SIM_START_EPOCH_MS),
      10
    ),
    stepMs: parseInt(process.env.SIM_STEP_MS || String(DEFAULT_SIM_STEP_MS), 10),
    speedMultiplier: parseFloat(
      process.env.SPEED_MULTIPLIER || String(DEFAULT_SPEED_MULTIPLIER)
    )
  };
}
