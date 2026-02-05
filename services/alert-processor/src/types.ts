export interface ZoneAlert {
  zoneId: string;
  previousState: string;
  currentState: string;
  avg1m: number;
  avg5m: number;
  timestamp: number;
}

export interface ZoneAlertForZoneList {
  previousState: string;
  currentState: string;
  avg1m: number;
  avg5m: number;
  timestamp: number;
}
