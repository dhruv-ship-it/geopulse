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
  /**
   * Event time of the last degradation published for this zone, transition or re-assertion.
   *
   * Exists because the correlation window is *level*-expecting and this service is
   * *edge*-triggered — see `DEGRADATION_REASSERT_MS` in `streamProcessor.ts` (defect D14).
   */
  lastDegradationPublishedAt: number | null;
}

export interface StateTransitionAlert {
  zoneId: string;
  previousState: ZoneState;
  currentState: ZoneState;
  avg1m: number;
  avg5m: number;
  detectedAt: number;
}

/**
 * What this service publishes to `zone.degradations` — the schema in `01-ARCHITECTURE.md` §4.2.
 *
 * A `currentState` of `NORMAL` is a **recovery**, and it is published like any other transition.
 * The correlation window needs it to release a member early; without it an incident is reported
 * over ground that recovered up to `CORRELATION_WINDOW_MS` ago.
 *
 * `correlation-engine` and `alert-processor` each declare their own copy of this interface.
 * That is deliberate and not an oversight to be tidied up: these are separately deployable
 * processes and the wire format is the contract between them, so a shared TypeScript type would
 * create a compile-time coupling that does not exist at runtime — and would quietly stop being
 * true the moment one of them is deployed at a different version. What must not be duplicated is
 * the *geometry* (`@geopulse/spatial`), because two processes disagreeing about which cell a zone
 * is in fails silently; two processes disagreeing about a field name fails at the JSON.
 */
export interface ZoneDegradation {
  zoneId: string;
  /** Fine-resolution cell (detection res). */
  h3Cell: string;
  /** Coarse cell = partition key. */
  h3CoarseCell: string;
  latitude: number;
  longitude: number;
  previousState: ZoneState;
  currentState: ZoneState;
  /** 0..1 normalised, for incident severity rollup. See `severity.ts`. */
  severity: number;
  avg1m: number;
  avg5m: number;
  /** Event-time ms. Never a wall clock, never a Kafka record timestamp — see ADR-007. */
  eventTime: number;
}