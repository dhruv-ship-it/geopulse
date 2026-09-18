import { RedisClientType } from 'redis';

import { roundCoordinate } from './footprint';
import { logger } from './logger';
import { redisIncidentWriteLatencyMs } from './metrics';
import { IncidentWireEvent } from './types';

export const INCIDENT_KEY_PREFIX = 'incident:';
export const ACTIVE_INCIDENTS_KEY = 'incidents:active';
export const INCIDENTS_GEO_KEY = 'incidents:geo';

export interface IncidentStoreOptions {
  /** Seconds to keep a closed incident's hash. 0 keeps it forever. */
  closedTtlSeconds: number;
}

export interface IncidentStoreStats {
  writes: number;
  opened: number;
  closed: number;
  /** Incidents whose geo entry was skipped because they had no live members to locate. */
  withoutPosition: number;
}

/**
 * Live incident state in Redis: the answer to "what is happening right now", served without
 * touching Postgres or replaying a Kafka topic.
 *
 * Three structures, each for a question the others cannot answer:
 *
 * | Key | Type | Question |
 * |---|---|---|
 * | `incident:<id>` | HASH | everything about one incident |
 * | `incidents:active` | SET | which incidents are live — without scanning the keyspace |
 * | `incidents:geo` | GEO | which incidents are near a point |
 *
 * The SET exists for the same reason `zones:registry` does. Enumerating live incidents with
 * `KEYS incident:*` was defect D2 in this repo, and it is O(N) over the *entire* keyspace on a
 * single-threaded server. The set is O(N) in the incidents, which is the number the caller
 * actually asked about.
 *
 * The GEO index is the one that makes the project's output spatially queryable in its own right:
 * `zones:geo` answers "which sensors are near me", and this answers "which *incidents* are near
 * me" — a different and more useful question, and one that only exists because degradations were
 * correlated into things that have a position at all.
 *
 * ## Writes are idempotent, because delivery is at-least-once
 *
 * The consumer publishes and writes before it resolves an offset, so a crash in between replays
 * the batch. Every operation here is therefore a full overwrite (`HSET` of every field, `SADD`,
 * `GEOADD`) rather than an increment or an append: applying the same event twice leaves exactly
 * the state applying it once does. Incident ids are deterministic (ADR-003), so a replayed event
 * even carries the same key.
 *
 * ## Closed incidents get a TTL
 *
 * An unbounded map of everything that ever happened was defect D5, and Redis holding every
 * incident forever is the same mistake at a different layer. On close, the incident leaves the
 * active set and the geo index and its hash gets `CLOSED_INCIDENT_TTL_SECONDS` to be read by
 * anything still interested. The durable record is Postgres (WP3 item 6) and the
 * `zone.incidents` topic; this is a cache of the present, not an archive.
 */
export class IncidentStore {
  private writes = 0;
  private opened = 0;
  private closed = 0;
  private withoutPosition = 0;

  constructor(
    private readonly client: RedisClientType,
    private readonly options: IncidentStoreOptions
  ) {}

  /**
   * Apply a batch of incident events in one pipelined round trip.
   *
   * One round trip per batch, not per event: a regional storm produces several events in one
   * reconcile, and paying a network round trip for each one would make the batching that
   * produced them pointless.
   */
  async apply(events: readonly IncidentWireEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const startedAt = Date.now();
    const pipeline = this.client.multi();

    for (const event of events) {
      const key = `${INCIDENT_KEY_PREFIX}${event.incidentId}`;
      pipeline.hSet(key, toHash(event));

      if (event.status === 'CLOSED') {
        this.closed++;
        pipeline.sRem(ACTIVE_INCIDENTS_KEY, event.incidentId);
        pipeline.zRem(INCIDENTS_GEO_KEY, event.incidentId);
        if (this.options.closedTtlSeconds > 0) {
          pipeline.expire(key, this.options.closedTtlSeconds);
        }
        continue;
      }

      if (event.eventType === 'OPENED') {
        this.opened++;
      }
      pipeline.sAdd(ACTIVE_INCIDENTS_KEY, event.incidentId);

      if (event.memberCount > 0) {
        pipeline.geoAdd(INCIDENTS_GEO_KEY, {
          longitude: roundCoordinate(event.footprint.centroid.longitude),
          latitude: roundCoordinate(event.footprint.centroid.latitude),
          member: event.incidentId
        });
      } else {
        // A live incident with no members should not exist — the lifecycle closes one the moment
        // its last member leaves. Counted rather than asserted, so the impossible case is
        // visible if it ever turns out not to be impossible.
        this.withoutPosition++;
        logger.warn(
          { incidentId: event.incidentId, eventType: event.eventType },
          'Live incident has no members; skipping its geo entry'
        );
      }
    }

    await pipeline.exec();
    this.writes++;
    redisIncidentWriteLatencyMs.observe(Date.now() - startedAt);
  }

  /** Live incident ids, from the set rather than from a keyspace scan. */
  async activeIncidentIds(): Promise<string[]> {
    const ids = await this.client.sMembers(ACTIVE_INCIDENTS_KEY);
    return ids.sort();
  }

  async getIncident(incidentId: string): Promise<Record<string, string> | null> {
    const hash = await this.client.hGetAll(`${INCIDENT_KEY_PREFIX}${incidentId}`);
    return hash && Object.keys(hash).length > 0 ? hash : null;
  }

  stats(): IncidentStoreStats {
    return {
      writes: this.writes,
      opened: this.opened,
      closed: this.closed,
      withoutPosition: this.withoutPosition
    };
  }
}

/**
 * The hash form of an incident event.
 *
 * Redis hash values are strings, so everything is stringified here rather than being left to
 * whatever `hSet` would do with a number or a null. Two specific choices:
 *
 * - `memberZones` and `h3Cells` are stored as JSON arrays, not as comma-joined strings. Zone ids
 *   are opaque to this service, and a delimiter that turns up inside one is the kind of bug that
 *   surfaces months later on one unlucky id.
 * - A field with no value is written as an empty string rather than omitted. An omitted field
 *   and a field that was cleared read identically out of `HGETALL`, so a merge survivor that was
 *   never superseded and one whose `supersededBy` was somehow dropped would look the same.
 */
export function toHash(event: IncidentWireEvent): Record<string, string> {
  return {
    incidentId: event.incidentId,
    eventType: event.eventType,
    status: event.status,
    lifecycleStatus: event.lifecycleStatus,
    memberZones: JSON.stringify(event.memberZones),
    memberCount: String(event.memberCount),
    severity: String(event.severity),
    peakSeverity: String(event.peakSeverity),
    h3Cells: JSON.stringify(event.footprint.h3Cells),
    centroidLat: String(roundCoordinate(event.footprint.centroid.latitude)),
    centroidLon: String(roundCoordinate(event.footprint.centroid.longitude)),
    radiusKm: String(event.footprint.radiusKm),
    // WP4. Written as empty rather than omitted so that "no vector" is a value a consumer reads,
    // not a key it fails to find.
    bearingDeg: event.propagation === null ? '' : String(event.propagation.bearingDeg),
    speedKmh: event.propagation === null ? '' : String(event.propagation.speedKmh),
    rSquared: event.propagation === null ? '' : String(event.propagation.rSquared),
    mergedFrom: JSON.stringify(event.mergedFrom ?? []),
    supersededBy: event.supersededBy ?? '',
    splitFrom: event.splitFrom ?? '',
    closeReason: event.closeReason ?? '',
    h3CoarseCell: event.h3CoarseCell,
    openedAt: String(event.openedAt),
    updatedAt: String(event.updatedAt),
    closedAt: event.closedAt === null ? '' : String(event.closedAt),
    // Wall clock, and labelled as such. `updatedAt` is event time and answers "when did this
    // incident change"; this answers "when did this row last get written", which is a different
    // question and the one an operator asks when they suspect the pipeline has stopped.
    lastWrittenAt: String(Date.now())
  };
}
