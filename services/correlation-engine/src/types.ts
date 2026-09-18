/**
 * The wire schemas this service consumes and produces, exactly as `01-ARCHITECTURE.md` §4.2
 * specifies them.
 *
 * These are deliberately separate types from the core's `IncidentEvent` in `src/core`. The core
 * type is the *algorithm's* output — membership transitions, ids, statuses — and knows nothing
 * about geography or severity. The wire type is the *product's* output, and carries the
 * enrichment a consumer needs to draw an incident on a map without joining back to the zone
 * registry. Keeping them apart is what lets the core stay I/O-free and property-tested; the
 * mapping between them lives in `incidentEnricher.ts` and is the only place that knows both.
 */

export type ZoneState = 'NORMAL' | 'STRESSED' | 'CRITICAL';

/**
 * Kafka `zone.degradations` — key: coarse H3 cell (ADR-004 pending; see `01-ARCHITECTURE.md` §6).
 *
 * `currentState: 'NORMAL'` is a **recovery**: the zone climbed back out, and the correlation
 * window releases it early rather than waiting out `CORRELATION_WINDOW_MS`. That is why the
 * topic is called degradations and not alerts — it carries every observation of a zone's
 * degradation state changing, in both directions.
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
  /** 0..1 normalised, for incident severity rollup. */
  severity: number;
  avg1m: number;
  avg5m: number;
  /** Event-time ms. Never a wall clock, never a Kafka record timestamp — see ADR-007. */
  eventTime: number;
}

export interface IncidentFootprint {
  h3Cells: string[];
  centroid: { latitude: number; longitude: number };
  radiusKm: number;
}

export interface IncidentPropagation {
  bearingDeg: number;
  speedKmh: number;
  /** Fit quality; low => not really moving. */
  rSquared: number;
}

/**
 * Kafka `zone.incidents` — key: `h3CoarseCell`, **not** `incidentId` (see `01-ARCHITECTURE.md`
 * §6). Keying by incident id would spread one region's incidents across every partition, which
 * is the same mistake as keying degradations by zone id.
 */
export interface IncidentWireEvent {
  incidentId: string;
  eventType: 'OPENED' | 'GREW' | 'MERGED' | 'SHRANK' | 'CLOSED';
  /**
   * The question a consumer actually asks: is this incident still live? `DRAINING` answers
   * "yes", so it maps to `OPEN` here, exactly as §4.2 specifies.
   */
  status: 'OPEN' | 'CLOSED';
  /**
   * The core's full status, which has three values and not two. `DRAINING` — below
   * `INCIDENT_MIN_ZONES` but still inside its grace period — is not decoration: it is what
   * makes "no OPEN incident is below the minimum" and "close after the grace period" both
   * true at once (WP2b). Collapsing it into `OPEN` on the wire is right for a consumer
   * deciding whether to page someone, and wrong for a UI that wants to show an incident
   * fading. Both are served: `status` for the first, this for the second.
   */
  lifecycleStatus: 'OPEN' | 'DRAINING' | 'CLOSED';
  memberZones: string[];
  memberCount: number;
  peakSeverity: number;
  severity: number;
  footprint: IncidentFootprint;
  /** Null until WP4. See `correlationEngine.ts`. */
  propagation: IncidentPropagation | null;
  /** Populated on MERGED. */
  mergedFrom: string[] | null;
  /** Set on the losing incident of a merge. */
  supersededBy: string | null;
  /** Set on an incident that was carved out of another when a component split. */
  splitFrom: string | null;
  /**
   * `CLOSED` only. A consumer has to tell "absorbed into another incident, follow
   * `supersededBy`" from "this fault is over" — silence is the same shape for both.
   */
  closeReason: 'SUPERSEDED' | 'DISSOLVED' | 'GRACE_EXPIRED' | null;
  openedAt: number;
  updatedAt: number;
  closedAt: number | null;
  /** The partition key this event is published under. */
  h3CoarseCell: string;
}
