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
  eventsPerSecond: number;
  scenario: ScenarioType;
  logEveryNEvents: number;
}