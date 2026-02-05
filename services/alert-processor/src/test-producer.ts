import 'dotenv/config';
import { Kafka } from 'kafkajs';
import { ZoneAlert } from './types';

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const ALERTS_TOPIC = 'zone.alerts';

async function sendTest() {
  const kafka = new Kafka({ clientId: 'alert-test-producer', brokers: [KAFKA_BROKER] });
  const producer = kafka.producer();
  await producer.connect();

  const alert: ZoneAlert = {
    zoneId: 'Z-1',
    previousState: 'NORMAL',
    currentState: 'STRESSED',
    avg1m: 0.78,
    avg5m: 0.76,
    timestamp: Date.now()
  };

  await producer.send({ topic: ALERTS_TOPIC, messages: [{ key: alert.zoneId, value: JSON.stringify(alert) }] });
  console.log('Sent test alert:', alert);
  await producer.disconnect();
}

sendTest().catch(err => { console.error(err); process.exit(1); });
