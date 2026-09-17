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

export function topicSpecs(
  partitions: number = DEFAULT_PARTITIONS,
  replicationFactor: number = REPLICATION_FACTOR
): TopicSpec[] {
  return [
    {
      topic: 'raw.zone.events',
      numPartitions: partitions,
      replicationFactor,
      rationale:
        'Sensor events, keyed by zoneId. Per-zone windowing needs all of a zone`s events on ' +
        'one partition; beyond that the work is embarrassingly parallel.'
    },
    {
      topic: 'zone.alerts',
      numPartitions: partitions,
      replicationFactor,
      rationale:
        'Pre-rename name of zone.degradations, still produced/consumed until WP3 lands the ' +
        'rename. Created here so the current pipeline keeps working with auto-creation off.'
    },
    {
      topic: 'zone.degradations',
      numPartitions: partitions,
      replicationFactor,
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
      configEntries: [{ name: 'retention.ms', value: FOURTEEN_DAYS_MS }],
      rationale:
        'Dead letters from alert-processor. One partition for ordered inspection; 14-day ' +
        'retention so a failure is not silently aged out before anyone looks at it.'
    },
    {
      topic: 'zone.incidents',
      numPartitions: partitions,
      replicationFactor,
      rationale:
        'Correlated incident lifecycle events, keyed by coarse H3 cell (see ADR-004) so a ' +
        'consumer rebuilding regional state reads one partition rather than fanning out.'
    }
  ];
}

export const TOPIC_NAMES = topicSpecs().map((t) => t.topic);
