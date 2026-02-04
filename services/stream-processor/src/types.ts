export interface SensorEvent {
  eventId: string;
  zoneId: string;
  latitude: number;
  longitude: number;
  load: number;
  eventTimestamp: number;
  producedAt: number;
}

export interface WindowBucket {
  timestamp: number; // Second-level timestamp
  sum: number;
  count: number;
}

export interface ZoneWindow {
  buckets: Map<number, WindowBucket>; // Key: second timestamp
  totalSum: number;
  totalCount: number;
}

export type ZoneState = 'NORMAL' | 'STRESSED' | 'CRITICAL';

export interface ZoneStateData {
  currentState: ZoneState;
  window1m: ZoneWindow;
  window5m: ZoneWindow;
  stressedSince: number | null; // timestamp when STRESSED condition started
  criticalSince: number | null; // timestamp when CRITICAL condition started
  lastAlertTimestamp: number | null;
}

export interface StateTransitionAlert {
  zoneId: string;
  previousState: ZoneState;
  currentState: ZoneState;
  avg1m: number;
  avg5m: number;
  detectedAt: number;
}