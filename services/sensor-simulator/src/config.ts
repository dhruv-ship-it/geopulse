import { SimulatorConfig } from './types';

export const DEFAULT_CONFIG: SimulatorConfig = {
  numberOfZones: 10,
  eventsPerSecond: 50,
  scenario: 'normal',
  logEveryNEvents: 100
};

export function loadConfig(): SimulatorConfig {
  return {
    numberOfZones: parseInt(process.env.NUM_ZONES || '10', 10),
    eventsPerSecond: parseInt(process.env.EVENTS_PER_SECOND || '50', 10),
    scenario: (process.env.SCENARIO as 'normal' | 'spike' | 'drop') || 'normal',
    logEveryNEvents: parseInt(process.env.LOG_EVERY_N || '100', 10)
  };
}