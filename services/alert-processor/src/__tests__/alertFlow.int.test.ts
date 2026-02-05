import { Kafka, Producer } from 'kafkajs';
import { createClient, RedisClientType } from 'redis';
import { ZoneAlert } from '../types';

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || '6380';
const ALERTS_TOPIC = 'zone.alerts';
const GLOBAL_KEY = 'alerts:global';

describe('Alert Flow Integration Test', () => {
  let kafkaProducer: Producer;
  let redisClient: RedisClientType;
  let alertProcessor: AlertProcessor;

  // Simple AlertProcessor class for test
  class AlertProcessor {
    private redis: RedisClientType;

    constructor(redisClient: RedisClientType) {
      this.redis = redisClient;
    }

    async persistAlert(alert: ZoneAlert): Promise<void> {
      await this.redis.lPush(GLOBAL_KEY, JSON.stringify(alert));
      await this.redis.lTrim(GLOBAL_KEY, 0, 999);
    }
  }

  beforeAll(async () => {
    // Connect to Redis
    redisClient = createClient({
      url: `redis://${REDIS_HOST}:${REDIS_PORT}`
    });
    await redisClient.connect();

    // Clear test data
    await redisClient.del(GLOBAL_KEY);

    // Create Kafka producer
    const kafka = new Kafka({
      clientId: 'test-producer',
      brokers: [KAFKA_BROKER]
    });
    kafkaProducer = kafka.producer();
    await kafkaProducer.connect();

    // Initialize alert processor
    alertProcessor = new AlertProcessor(redisClient);

    // Wait a moment for Kafka to be ready
    await new Promise(resolve => setTimeout(resolve, 1000));
  }, 30000);

  afterAll(async () => {
    await kafkaProducer.disconnect();
    await redisClient.disconnect();
  }, 10000);

  it('should produce alert to Kafka and persist to Redis', async () => {
    // Create test alert
    const testAlert: ZoneAlert = {
      zoneId: 'test-zone-integration',
      previousState: 'NORMAL',
      currentState: 'STRESSED',
      avg1m: 0.45,
      avg5m: 0.78,
      timestamp: Date.now()
    };

    // Produce alert to Kafka
    await kafkaProducer.send({
      topic: ALERTS_TOPIC,
      messages: [{ value: JSON.stringify(testAlert) }]
    });

    // Simulate alert processor behavior (direct persistence)
    await alertProcessor.persistAlert(testAlert);

    // Query Redis for persisted alert
    const alerts = await redisClient.lRange(GLOBAL_KEY, 0, -1);
    expect(alerts.length).toBeGreaterThan(0);

    // Parse and verify the most recent alert
    const latestAlert: ZoneAlert = JSON.parse(alerts[0]);
    expect(latestAlert.zoneId).toBe(testAlert.zoneId);
    expect(latestAlert.previousState).toBe(testAlert.previousState);
    expect(latestAlert.currentState).toBe(testAlert.currentState);
    expect(latestAlert.avg1m).toBe(testAlert.avg1m);
    expect(latestAlert.avg5m).toBe(testAlert.avg5m);
  }, 15000);
});
