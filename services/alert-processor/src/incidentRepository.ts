import { Pool, PoolClient } from 'pg';

import { IncidentWireEvent } from './incidentTypes';
import { logger } from './logger';
import {
  incidentEventsPersistedTotal,
  incidentMemberRowsWrittenTotal,
  postgresIncidentWriteLatencyMs
} from './metrics';

export interface IncidentRepositoryStats {
  events: number;
  memberJoins: number;
  memberDepartures: number;
}

/**
 * Writes an incident's lifecycle into `incidents`, `incident_members` and `incident_events`.
 *
 * ## Why three tables and two different write shapes
 *
 * An incident is three different kinds of fact. `incidents` is *what it is now* and is mutable —
 * it is overwritten on every event. `incident_members` is a set of intervals — a zone joined at
 * one event time and, eventually, left at another. `incident_events` is *how it got that way*
 * and is append-only; it is the timeline the API serves and the only record that an incident
 * merged rather than simply grew.
 *
 * ## At-least-once, and what actually makes it safe
 *
 * `zone.incidents` is delivered at-least-once — `IncidentDispatcher` publishes before offsets
 * resolve, so a crash in between replays the batch. Two properties make replaying safe, and they
 * are different properties:
 *
 * 1. **Idempotence.** Incident ids are deterministic (ADR-003), so a replayed event carries the
 *    same key. The `incidents` write is a full-row upsert and the membership write is an upsert
 *    plus a departure update that only touches rows still open, so applying an event twice leaves
 *    exactly the state applying it once does. `incident_events` is the one table that would
 *    genuinely duplicate, and it is protected by a uniqueness constraint on
 *    `(incident_id, event_type, event_time)` with `ON CONFLICT DO NOTHING` — that triple is
 *    unique by construction, because the lifecycle reconciles at one watermark at a time and
 *    emits at most one event of each type per incident per reconcile.
 *
 * 2. **Ordering.** Idempotence alone is not enough: replaying `GREW` *after* `CLOSED` would
 *    reopen a closed incident, and nothing above prevents that. What prevents it is that every
 *    event for one incident lands on one partition — `zone.incidents` is keyed by the coarse
 *    cell, and an incident's key is fixed at its first event precisely so its own events cannot
 *    scatter (ADR-004). A redelivery replays a contiguous run of one partition in offset order,
 *    so the last write for an incident is still its last event. This is the concrete reason that
 *    partitioning decision is a correctness decision and not a throughput one.
 *
 * ## One transaction per event
 *
 * The three writes go in a transaction, not because two of them are idempotent — they are — but
 * because `incident_members` and `incident_events` both carry a foreign key to `incidents`. A
 * failure between the parent insert and the children would otherwise leave an incident whose
 * timeline is missing its own opening event, which is worse than no row at all: it looks like
 * data rather than like a gap.
 */
export class IncidentRepository {
  private events = 0;
  private memberJoins = 0;
  private memberDepartures = 0;

  constructor(private readonly pool: Pool) {}

  stats(): IncidentRepositoryStats {
    return {
      events: this.events,
      memberJoins: this.memberJoins,
      memberDepartures: this.memberDepartures
    };
  }

  async persist(event: IncidentWireEvent): Promise<void> {
    const startedAt = Date.now();
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await this.upsertIncident(client, event);
      const { joined, departed } = await this.syncMembers(client, event);
      await this.appendEvent(client, event);
      await client.query('COMMIT');

      this.events++;
      this.memberJoins += joined;
      this.memberDepartures += departed;
      incidentEventsPersistedTotal.labels(event.eventType).inc();
      incidentMemberRowsWrittenTotal.labels('joined').inc(joined);
      incidentMemberRowsWrittenTotal.labels('departed').inc(departed);
      postgresIncidentWriteLatencyMs.observe(Date.now() - startedAt);

      logger.debug(
        {
          incidentId: event.incidentId,
          eventType: event.eventType,
          memberCount: event.memberCount,
          joined,
          departed
        },
        'Incident event persisted'
      );
    } catch (err) {
      // Rolling back is best-effort: if the connection is what failed, this throws too, and the
      // original error is the one worth surfacing.
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error(
        { error: err, incidentId: event.incidentId, eventType: event.eventType },
        'Failed to persist incident event'
      );
      throw err;
    } finally {
      // Always. A connection not released is a connection permanently removed from a pool of
      // five, and five of those is a service that has silently stopped writing anything.
      client.release();
    }
  }

  private async upsertIncident(client: PoolClient, event: IncidentWireEvent): Promise<void> {
    await client.query(
      `INSERT INTO incidents (
         incident_id, status, opened_at, closed_at, updated_at, peak_severity, member_count,
         centroid_lat, centroid_lon, radius_km, bearing_deg, speed_kmh, superseded_by,
         last_written_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (incident_id) DO UPDATE SET
         status         = EXCLUDED.status,
         closed_at      = EXCLUDED.closed_at,
         updated_at     = EXCLUDED.updated_at,
         peak_severity  = GREATEST(incidents.peak_severity, EXCLUDED.peak_severity),
         member_count   = EXCLUDED.member_count,
         centroid_lat   = EXCLUDED.centroid_lat,
         centroid_lon   = EXCLUDED.centroid_lon,
         radius_km      = EXCLUDED.radius_km,
         bearing_deg    = EXCLUDED.bearing_deg,
         speed_kmh      = EXCLUDED.speed_kmh,
         superseded_by  = COALESCE(EXCLUDED.superseded_by, incidents.superseded_by),
         last_written_at = EXCLUDED.last_written_at`,
      [
        event.incidentId,
        event.status,
        // opened_at is never updated: an incident opens once, and a later event that disagreed
        // would be describing a different incident (the id is derived from openedAt — ADR-003).
        event.openedAt,
        event.closedAt,
        event.updatedAt,
        event.peakSeverity,
        event.memberCount,
        event.memberCount > 0 ? event.footprint.centroid.latitude : null,
        event.memberCount > 0 ? event.footprint.centroid.longitude : null,
        event.memberCount > 0 ? event.footprint.radiusKm : null,
        event.propagation?.bearingDeg ?? null,
        event.propagation?.speedKmh ?? null,
        event.supersededBy,
        Date.now()
      ]
    );
  }

  /**
   * Reconcile the membership table against the event's member list.
   *
   * The wire event carries the *complete* current membership, not a delta, which makes this a
   * set difference rather than a log to apply in order — and a set difference is what survives a
   * replay. Members in the list are upserted open; members this incident still has open that are
   * not in the list have left.
   *
   * `joined_at` is `updatedAt`, the event time at which this event observed the zone as a member.
   * For an `OPENED` that is `openedAt`, which is exact. For a zone added by a later `GREW` it is
   * the reconcile watermark that first saw it, which is within one compaction interval of the
   * zone's actual degradation — the precise per-member join time arrives with WP4, which needs it
   * for the propagation regression and will carry it on the wire.
   */
  private async syncMembers(
    client: PoolClient,
    event: IncidentWireEvent
  ): Promise<{ joined: number; departed: number }> {
    const closed = event.status === 'CLOSED';
    let joined = 0;

    if (!closed && event.memberZones.length > 0) {
      const placeholders = event.memberZones
        .map((_, index) => `($1, $${index + 3}, $2, NULL)`)
        .join(', ');

      const result = await client.query(
        `INSERT INTO incident_members (incident_id, zone_id, joined_at, left_at)
         VALUES ${placeholders}
         ON CONFLICT (incident_id, zone_id) DO UPDATE SET
           -- A zone that recovered and degraded again inside the same incident is a member
           -- again. Clearing left_at rather than inserting a second row keeps the primary key
           -- honest; the cost is that the table records the current interval, not every one.
           left_at = NULL
         RETURNING (xmax = 0) AS inserted`,
        [event.incidentId, event.updatedAt, ...event.memberZones]
      );
      // `xmax = 0` is true for a row this statement inserted and false for one it updated —
      // the only way an upsert will tell you which it did. Used for a counter, nothing more.
      joined = result.rows.filter((row) => row.inserted).length;
    }

    // Departures. Scoped to rows still open so a replay does not rewrite a `left_at` that an
    // earlier event already set to an earlier, truer time.
    //
    // A CLOSED event ends every remaining membership unconditionally, whatever its member list
    // says. A closed incident with a zone still marked present would answer "which incidents was
    // this zone in" with an interval that never ends.
    const departures = await client.query(
      `UPDATE incident_members
          SET left_at = $2
        WHERE incident_id = $1
          AND left_at IS NULL
          AND ($3::text[] IS NULL OR NOT (zone_id = ANY($3::text[])))`,
      [
        event.incidentId,
        event.closedAt ?? event.updatedAt,
        !closed && event.memberZones.length > 0 ? event.memberZones : null
      ]
    );

    return { joined, departed: departures.rowCount ?? 0 };
  }

  private async appendEvent(client: PoolClient, event: IncidentWireEvent): Promise<void> {
    await client.query(
      `INSERT INTO incident_events (incident_id, event_type, member_count, event_time)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (incident_id, event_type, event_time) DO NOTHING`,
      [event.incidentId, event.eventType, event.memberCount, event.updatedAt]
    );
  }
}
