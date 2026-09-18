import 'dotenv/config';
import { Kafka } from 'kafkajs';
import { cellsFor } from '@geopulse/spatial';

import { ZoneDegradation } from './types';

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const DEGRADATIONS_TOPIC = process.env.DEGRADATIONS_TOPIC || 'zone.degradations';

async function sendTest() {
  const kafka = new Kafka({ clientId: 'degradation-test-producer', brokers: [KAFKA_BROKER] });
  const producer = kafka.producer();
  await producer.connect();

  const latitude = 37.7749;
  const longitude = -122.4194;
  const cells = cellsFor(latitude, longitude);

  const degradation: ZoneDegradation = {
    zoneId: 'Z-1',
    h3Cell: cells.h3Cell,
    h3CoarseCell: cells.h3CoarseCell,
    latitude,
    longitude,
    previousState: 'NORMAL',
    currentState: 'STRESSED',
    severity: 0.76,
    avg1m: 0.78,
    avg5m: 0.76,
    eventTime: Date.now()
  };

  // Keyed by coarse cell, not zone id. See ADR-004.
  await producer.send({
    topic: DEGRADATIONS_TOPIC,
    messages: [{ key: degradation.h3CoarseCell, value: JSON.stringify(degradation) }]
  });
  console.log('Sent test degradation:', degradation);
  await producer.disconnect();
}

sendTest().catch(err => { console.error(err); process.exit(1); });
