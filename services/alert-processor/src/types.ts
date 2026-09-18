/**
 * What this service consumes, after WP3's rename.
 *
 * `zone.alerts` is gone and `ZoneAlert` with it. The per-zone stage does not emit *alerts* — a
 * human-facing concept implying something worth waking someone for — it emits *observations that
 * a zone's degradation state changed*, in both directions. Only the correlation engine produces
 * human-facing output. That reframing is the conceptual core of Phase 1
 * (`01-ARCHITECTURE.md` §4.1), and leaving the old name on the type this service reads would
 * have kept the old idea alive in the one place it is easiest to believe.
 *
 * The schema is `01-ARCHITECTURE.md` §4.2 and is shared with `correlation-engine`, which defines
 * its own copy for the same reason the two services have their own `logger.ts`: they are
 * separately deployable and neither should fail to build because the other changed. The wire
 * format is the contract, and `zone.degradations` carries it.
 */

export type ZoneState = 'NORMAL' | 'STRESSED' | 'CRITICAL';

export interface ZoneDegradation {
  zoneId: string;
  /** Fine-resolution cell (detection res). */
  h3Cell: string;
  /** Coarse cell = partition key. */
  h3CoarseCell: string;
  latitude: number;
  longitude: number;
  previousState: ZoneState;
  /** `NORMAL` here is a recovery, and is persisted like any other transition. */
  currentState: ZoneState;
  /** 0..1 normalised. */
  severity: number;
  avg1m: number;
  avg5m: number;
  /** Event-time ms. Never a wall clock, never a Kafka record timestamp — see ADR-007. */
  eventTime: number;
}

/** The per-zone Redis list entry: the zone id is already in the key. */
export interface ZoneDegradationForZoneList {
  previousState: string;
  currentState: string;
  severity: number;
  avg1m: number;
  avg5m: number;
  eventTime: number;
}
