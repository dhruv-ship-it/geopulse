/**
 * Single source of truth for GeoPulse Kafka topics.
 *
 * Topics used to be auto-created by the producers, which meant they were created with
 * broker defaults — one partition. Messages are keyed by zoneId (and, from WP3 onwards,
 * by coarse H3 cell), so a single partition throws away the only parallelism the keying
 * was designed to buy. Creating topics explicitly is the fix; disabling
 * allowAutoTopicCreation on every client is what stops the problem coming back silently.
 */

export interface TopicSpec {
  topic: string;
  numPartitions: number;
  replicationFactor: number;
  configEntries?: { name: string; value: string }[];
  /** Why this topic exists and why it is partitioned the way it is. */
  rationale: string;
}

const DEFAULT_PARTITIONS = parseInt(process.env.KAFKA_TOPIC_PARTITIONS || '12', 10);
const REPLICATION_FACTOR = parseInt(process.env.KAFKA_REPLICATION_FACTOR || '1', 10);

const FOURTEEN_DAYS_MS = String(14 * 24 * 60 * 60 * 1000);

/**
 * Stamp records with the time the broker received them, not the time the producer claims.
 *
 * This is the guard for defect D10. Retention is evaluated against the record timestamp, so
 * under the default `CreateTime` a producer decides when the broker deletes its data. The
 * simulator produces at a fixed simulated epoch in the past (ADR-005), so under CreateTime every
 * message arrived 245 days past a 7-day retention deadline and each segment was deleted seconds
 * after it rolled - 5.76M events destroyed underneath a consumer that was still reading them.
 * Evidence in `benchmarks/results/d10-root-cause.txt`.
 *
 * The producer no longer sets a record timestamp, which fixes it; this pins it. Storage-layer
 * ageing is a broker concern and should not be delegated to whoever happens to be publishing.
 * Application event time is unaffected - it travels in the payload, which is the only place any
 * consumer here reads it from. See `docs/adr/ADR-007-record-timestamp-vs-event-time.md`.
 *
 * Applied to every topic rather than only to the one that broke, because the argument is not
 * specific to raw.zone.events and a topic added later should not have to rediscover it.
 */
const LOG_APPEND_TIME = { name: 'message.timestamp.type', value: 'LogAppendTime' };

export function topicSpecs(
  partitions: number = DEFAULT_PARTITIONS,
  replicationFactor: number = REPLICATION_FACTOR
): TopicSpec[] {
  return [
    {
      topic: 'raw.zone.events',
      numPartitions: partitions,
      replicationFactor,
      configEntries: [LOG_APPEND_TIME],
      rationale:
        'Sensor events, keyed by zoneId. Per-zone windowing needs all of a zone`s events on ' +
        'one partition; beyond that the work is embarrassingly parallel.'
    },
    {
      topic: 'zone.alerts',
      numPartitions: partitions,
      replicationFactor,
      configEntries: [LOG_APPEND_TIME],
      rationale:
        'Pre-rename name of zone.degradations, still produced/consumed until WP3 lands the ' +
        'rename. Created here so the current pipeline keeps working with auto-creation off.'
    },
    {
      topic: 'zone.degradations',
      numPartitions: partitions,
      replicationFactor,
      configEntries: [LOG_APPEND_TIME],
      rationale:
        'Per-zone degradation observations, keyed by COARSE H3 CELL so geographic neighbours ' +
        'land on the same partition and one correlation consumer can see them together.'
    },
    {
      topic: 'zone.degradations.dlq',
      // Deliberately 1 partition: the DLQ is low volume, and a single partition keeps
      // failed messages in arrival order, which makes manual inspection and replay simple.
      numPartitions: 1,
      replicationFactor,
      configEntries: [{ name: 'retention.ms', value: FOURTEEN_DAYS_MS }, LOG_APPEND_TIME],
      rationale:
        'Dead letters from alert-processor. One partition for ordered inspection; 14-day ' +
        'retention so a failure is not silently aged out before anyone looks at it.'
    },
    {
      topic: 'zone.incidents',
      numPartitions: partitions,
      replicationFactor,
      configEntries: [LOG_APPEND_TIME],
      rationale:
        'Correlated incident lifecycle events, keyed by coarse H3 cell (see ADR-004) so a ' +
        'consumer rebuilding regional state reads one partition rather than fanning out.'
    }
  ];
}

export const TOPIC_NAMES = topicSpecs().map((t) => t.topic);
