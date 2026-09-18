/**
 * The `zone.incidents` wire schema, as `01-ARCHITECTURE.md` §4.2 specifies it and as
 * `correlation-engine` emits it.
 *
 * Declared here rather than imported from the engine for the same reason `ZoneDegradation` is:
 * these are separately deployable processes and the JSON on the topic is the contract between
 * them. A shared TypeScript type would create a compile-time coupling that does not exist at
 * runtime, and would stop being true the moment the two are deployed at different versions.
 *
 * This service reads a strict subset. `memberZones`, `footprint`, `propagation` and the lifecycle
 * fields all land in Postgres; `severity`, `lifecycleStatus` and `h3CoarseCell` do not, because
 * the schema in the WP3 spec does not have columns for them and inventing columns for fields
 * nothing queries is how a schema stops being readable. They are all on the topic and in Redis
 * if a later work package wants them.
 */

export interface IncidentFootprint {
  h3Cells: string[];
  centroid: { latitude: number; longitude: number };
  radiusKm: number;
}

export interface IncidentPropagation {
  bearingDeg: number;
  speedKmh: number;
  rSquared: number;
}

export interface IncidentWireEvent {
  incidentId: string;
  eventType: 'OPENED' | 'GREW' | 'MERGED' | 'SHRANK' | 'CLOSED';
  status: 'OPEN' | 'CLOSED';
  lifecycleStatus: 'OPEN' | 'DRAINING' | 'CLOSED';
  memberZones: string[];
  memberCount: number;
  peakSeverity: number;
  severity: number;
  footprint: IncidentFootprint;
  propagation: IncidentPropagation | null;
  mergedFrom: string[] | null;
  supersededBy: string | null;
  splitFrom: string | null;
  closeReason: 'SUPERSEDED' | 'DISSOLVED' | 'GRACE_EXPIRED' | null;
  openedAt: number;
  updatedAt: number;
  closedAt: number | null;
  h3CoarseCell: string;
}
