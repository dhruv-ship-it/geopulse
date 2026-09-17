import 'dotenv/config';
import { Kafka, ITopicConfig, Admin, ConfigResourceTypes } from 'kafkajs';
import { topicSpecs } from './topics';

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';

/**
 * Create the GeoPulse topics explicitly, then print what the broker actually has.
 *
 * Idempotent: createTopics is a no-op for topics that already exist. Note that it will
 * NOT change the partition count of an existing topic — if a topic was previously
 * auto-created with 1 partition you must delete it first (or use increasePartitions).
 * The describe output at the end is there so that mismatch is impossible to miss.
 *
 * Nor does createTopics apply configEntries to a topic that already exists, which is a sharper
 * edge than it looks: it means a config added to a spec silently does nothing on every broker
 * where the topic is already there — which is every broker that has ever run. That is how D10
 * would have survived its own fix. So configs are reconciled separately, against the topics the
 * broker actually has.
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

    if (!describeOnly) {
      await reconcileConfigs(admin, existing);
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

/**
 * Bring existing topics' configs in line with the spec.
 *
 * Only touches keys the spec names, so a value set by hand on the broker for some other reason
 * is left alone. Reports every change, because a topic config changing under a running pipeline
 * is exactly the kind of thing that should never happen quietly.
 */
async function reconcileConfigs(admin: Admin, existing: Set<string>): Promise<void> {
  const specs = topicSpecs().filter(
    (spec) => existing.has(spec.topic) && spec.configEntries && spec.configEntries.length > 0
  );

  if (specs.length === 0) {
    return;
  }

  const described = await admin.describeConfigs({
    includeSynonyms: false,
    resources: specs.map((spec) => ({
      type: ConfigResourceTypes.TOPIC,
      name: spec.topic
    }))
  });

  let changed = 0;

  for (const spec of specs) {
    const current = described.resources.find((r) => r.resourceName === spec.topic);
    const drifted = (spec.configEntries ?? []).filter((wanted) => {
      const actual = current?.configEntries.find((e) => e.configName === wanted.name);
      return actual?.configValue !== wanted.value;
    });

    if (drifted.length === 0) {
      continue;
    }

    await admin.alterConfigs({
      validateOnly: false,
      resources: [
        {
          type: ConfigResourceTypes.TOPIC,
          name: spec.topic,
          configEntries: drifted.map((entry) => ({ name: entry.name, value: entry.value }))
        }
      ]
    });

    for (const entry of drifted) {
      const before =
        current?.configEntries.find((e) => e.configName === entry.name)?.configValue ?? '(unset)';
      console.log(`Reconciled ${spec.topic}: ${entry.name} ${before} -> ${entry.value}`);
    }
    changed += drifted.length;
  }

  if (changed === 0) {
    console.log('Topic configs already match the spec.');
  }
}

main().catch((err) => {
  console.error('Topic bootstrap failed:', err);
  process.exit(1);
});
