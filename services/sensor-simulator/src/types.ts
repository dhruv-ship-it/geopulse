export interface SensorEvent {
  eventId: string;
  zoneId: string;
  latitude: number;
  longitude: number;
  load: number;
  eventTimestamp: number;
  producedAt: number;
}

export interface ZoneConfig {
  zoneId: string;
  latitude: number;
  longitude: number;
  baseLoad: number;
}

export type ScenarioType = 'normal' | 'spike' | 'drop';

export interface SimulatorConfig {
  numberOfZones: number;
  scenario: ScenarioType;
  logEveryNEvents: number;
  /** Simulated epoch the run starts at. Fixed by default so runs are comparable. */
  startEpochMs: number;
  /** Simulated milliseconds per tick; one event per zone per tick. */
  stepMs: number;
  /** Simulated milliseconds per real millisecond. 60 = a simulated minute per real second. */
  speedMultiplier: number;
}