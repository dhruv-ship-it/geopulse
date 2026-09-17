import { Kafka, Producer, Partitioners } from 'kafkajs';
import { createClient, RedisClientType } from 'redis';
import { ZoneAlert } from '../types';
import { AlertProcessor } from '../alertProcessor';
import { PostgresClient } from '../postgresClient';
import { KafkaAlertConsumer } from '../kafkaConsumer';

/**
 * End-to-end: produce to zone.alerts, let the REAL KafkaAlertConsumer and the REAL
 * AlertProcessor consume it, assert it landed in both Redis and Postgres.
 *
 * Requires the infra stack:
 *   cd infra && docker-compose up -d
 *   cd tools/kafka-bootstrap && npm install && npm run bootstrap
 *   cd services/alert-processor && GEOPULSE_INTEGRATION=1 npm test
 *
 * Skipped by default because it needs live brokers. It is gated rather than deleted because
 * the unit suites substitute clients at their boundaries; this is the only test that proves
 * the wiring — consumer -> processor -> Redis + Postgres — actually holds together.
 */
const RUN = process.env.GEOPULSE_INTEGRATION === '1';
const describeIntegration = RUN ? describe : describe.skip;

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || '6380';
const ALERTS_TOPIC = 'zone.alerts';
const GLOBAL_KEY = 'alerts:global';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== null && result !== undefined) return result;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describeIntegration('alert flow (integration)', () => {
  let producer: Producer;
  let redis: RedisClientType;
  let postgres: PostgresClient;
  let consumer: KafkaAlertConsumer;

  // A throwaway consumer group so the run does not disturb the real service's offsets.
  const groupId = `alert-processor-it-${Date.now()}`;
  const zoneId = `Z-IT-${Date.now()}`;

  beforeAll(async () => {
    redis = createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}` }) as RedisClientType;
    await redis.connect();

    postgres = new PostgresClient();
    await postgres.connect();

    const kafka = new Kafka({ clientId: 'alert-flow-it', brokers: [KAFKA_BROKER] });
    producer = kafka.producer({
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.LegacyPartitioner
    });
    await producer.connect();

    consumer = new KafkaAlertConsumer({ groupId, fromBeginning: false });
    await consumer.connect();

    const processor = new AlertProcessor(redis, postgres);
    await consumer.startConsuming((alert) => processor.persistAlert(alert));

    // Let the group finish joining before producing, otherwise fromBeginning:false drops it.
    await sleep(3000);
  }, 60000);

  afterAll(async () => {
    if (consumer) await consumer.disconnect();
    if (producer) await producer.disconnect();
    if (postgres) await postgres.disconnect();
    if (redis) await redis.disconnect();
  }, 30000);

  it('persists a produced alert to Redis and Postgres via the real consumer', async () => {
    const alert: ZoneAlert = {
      zoneId,
      previousState: 'NORMAL',
      currentState: 'STRESSED',
      avg1m: 0.45,
      avg5m: 0.78,
      timestamp: Date.now()
    };

    await producer.send({
      topic: ALERTS_TOPIC,
      messages: [{ key: alert.zoneId, value: JSON.stringify(alert) }]
    });

    const row = await waitFor(
      async () => {
        const result = await postgres
          .getClient()
          .query('SELECT zone_id, current_state FROM zone_alerts WHERE zone_id = $1', [zoneId]);
        return result.rows.length > 0 ? result.rows[0] : null;
      },
      30000,
      'the alert to reach Postgres'
    );
    expect(row.current_state).toBe('STRESSED');

    const cached = await waitFor(
      async () => {
        const entries = await redis.lRange(GLOBAL_KEY, 0, 50);
        const match = entries
          .map((e) => JSON.parse(e) as ZoneAlert)
          .find((e) => e.zoneId === zoneId);
        return match ?? null;
      },
      15000,
      'the alert to reach the Redis recent-alerts list'
    );
    expect(cached.avg5m).toBe(0.78);

    const perZone = await redis.lRange(`alerts:zone:${zoneId}`, 0, -1);
    expect(perZone).toHaveLength(1);
  }, 60000);
});
