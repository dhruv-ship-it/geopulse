import 'dotenv/config';
import { Kafka, ITopicConfig } from 'kafkajs';
import { topicSpecs } from './topics';

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';

/**
 * Create the GeoPulse topics explicitly, then print what the broker actually has.
 *
 * Idempotent: createTopics is a no-op for topics that already exist. Note that it will
 * NOT change the partition count of an existing topic — if a topic was previously
 * auto-created with 1 partition you must delete it first (or use increasePartitions).
 * The describe output at the end is there so that mismatch is impossible to miss.
 */
async function main(): Promise<void> {
  const describeOnly = process.argv.includes('--describe-only');

  const kafka = new Kafka({
    clientId: 'geopulse-bootstrap',
    brokers: [KAFKA_BROKER],
    retry: { initialRetryTime: 300, retries: 10 }
  });

  const admin = kafka.admin();
  await admin.connect();

  try {
    const specs = topicSpecs();
    const existing = new Set(await admin.listTopics());

    if (!describeOnly) {
      const toCreate: ITopicConfig[] = specs
        .filter((spec) => !existing.has(spec.topic))
        .map((spec) => ({
          topic: spec.topic,
          numPartitions: spec.numPartitions,
          replicationFactor: spec.replicationFactor,
          configEntries: spec.configEntries
        }));

      if (toCreate.length === 0) {
        console.log('All topics already exist; nothing to create.');
      } else {
        await admin.createTopics({ topics: toCreate, waitForLeaders: true });
        console.log(`Created: ${toCreate.map((t) => t.topic).join(', ')}`);
      }
    }

    const metadata = await admin.fetchTopicMetadata({
      topics: specs.map((s) => s.topic)
    });

    console.log('\nBroker state');
    console.log('------------');
    let mismatched = 0;
    for (const spec of specs) {
      const actual = metadata.topics.find((t) => t.name === spec.topic);
      const actualPartitions = actual ? actual.partitions.length : 0;
      const ok = actualPartitions === spec.numPartitions;
      if (!ok) mismatched++;
      console.log(
        `${ok ? 'OK  ' : 'WARN'} ${spec.topic.padEnd(24)} partitions=${actualPartitions} ` +
          `(expected ${spec.numPartitions})`
      );
    }

    if (mismatched > 0) {
      console.log(
        `\n${mismatched} topic(s) do not have the expected partition count. A topic that was ` +
          'auto-created earlier keeps its original partition count; delete it and re-run.'
      );
      process.exitCode = 1;
    }
  } finally {
    await admin.disconnect();
  }
}

main().catch((err) => {
  console.error('Topic bootstrap failed:', err);
  process.exit(1);
});
