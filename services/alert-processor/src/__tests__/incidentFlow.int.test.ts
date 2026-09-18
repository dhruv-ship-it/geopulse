import { Kafka, Partitioners, Producer } from 'kafkajs';
import { KafkaDeadLetterProducer } from '@geopulse/kafka-recovery';

import { KafkaIncidentConsumer } from '../incidentConsumer';
import { IncidentRepository } from '../incidentRepository';
import { IncidentWireEvent } from '../incidentTypes';
import { PostgresClient } from '../postgresClient';
import { runMigrations } from '../migrate';

/**
 * End-to-end: produce to `zone.incidents`, let the REAL consumer and the REAL repository take
 * it, and assert what landed in Postgres.
 *
 * The unit suite proves the *shape* of the SQL against a fake pool. This proves the claims that
 * only a real database can settle, and they are the ones the at-least-once argument rests on:
 * that replaying an event is genuinely a no-op rather than a duplicated timeline, and that the
 * membership intervals close when an incident closes.
 *
 * Requires the stack:
 *   cd infra && docker compose up -d --build
 *   cd services/alert-processor && GEOPULSE_INTEGRATION=1 npm test
 */
const RUN = process.env.GEOPULSE_INTEGRATION === '1';
const describeIntegration = RUN ? describe : describe.skip;

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const INCIDENTS_TOPIC = 'zone.incidents';

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

describeIntegration('incident flow (integration)', () => {
  let producer: Producer;
  let postgres: PostgresClient;
  let consumer: KafkaIncidentConsumer;
  let deadLetter: KafkaDeadLetterProducer;

  const groupId = `incident-persister-it-${Date.now()}`;
  // Unique per run so the assertions below cannot be satisfied by a previous run's rows.
  const incidentId = `it${Date.now().toString(16)}`;
  const zones = ['Z-IT-1', 'Z-IT-2', 'Z-IT-3'];
  const openedAt = 1_700_000_000_000;

  const event = (overrides: Partial<IncidentWireEvent>): IncidentWireEvent => ({
    incidentId,
    eventType: 'OPENED',
    status: 'OPEN',
    lifecycleStatus: 'OPEN',
    memberZones: zones,
    memberCount: zones.length,
    peakSeverity: 0.88,
    severity: 0.88,
    footprint: {
      h3Cells: ['85283473fffffff'],
      centroid: { latitude: 50.5, longitude: 10.1 },
      radiusKm: 18.2
    },
    propagation: null,
    mergedFrom: null,
    supersededBy: null,
    splitFrom: null,
    closeReason: null,
    openedAt,
    updatedAt: openedAt,
    closedAt: null,
    h3CoarseCell: '83283ffffffffff',
    ...overrides
  });

  async function publish(wire: IncidentWireEvent): Promise<void> {
    await producer.send({
      topic: INCIDENTS_TOPIC,
      messages: [{ key: wire.h3CoarseCell, value: JSON.stringify(wire) }]
    });
  }

  beforeAll(async () => {
    postgres = new PostgresClient();
    await postgres.connect();
    await runMigrations(postgres.getClient());

    const kafka = new Kafka({ clientId: 'incident-flow-it', brokers: [KAFKA_BROKER] });
    producer = kafka.producer({
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.LegacyPartitioner
    });
    await producer.connect();

    deadLetter = new KafkaDeadLetterProducer(kafka);
    await deadLetter.connect();

    consumer = new KafkaIncidentConsumer({
      kafka,
      groupId,
      fromBeginning: false,
      deadLetter,
      policy: { maxAttempts: 2, initialBackoffMs: 50, backoffMultiplier: 2, maxBackoffMs: 200 }
    });
    await consumer.connect();
    await consumer.startConsuming((wire) =>
      new IncidentRepository(postgres.getClient()).persist(wire)
    );

    // Let the group finish joining before producing, otherwise fromBeginning:false drops it.
    await sleep(3000);
  }, 60000);

  afterAll(async () => {
    if (consumer) await consumer.disconnect();
    if (deadLetter) await deadLetter.disconnect();
    if (producer) await producer.disconnect();
    if (postgres) {
      await postgres
        .getClient()
        .query('DELETE FROM incidents WHERE incident_id = $1', [incidentId])
        .catch(() => undefined);
      await postgres.disconnect();
    }
  }, 30000);

  it('persists an incident lifecycle, and a replay changes nothing', async () => {
    const opened = event({});
    await publish(opened);

    const row = await waitFor(
      async () => {
        const result = await postgres
          .getClient()
          .query('SELECT status, member_count, opened_at FROM incidents WHERE incident_id = $1', [
            incidentId
          ]);
        return result.rows.length > 0 ? result.rows[0] : null;
      },
      30000,
      'the OPENED event to reach Postgres'
    );
    expect(row.status).toBe('OPEN');
    expect(Number(row.member_count)).toBe(3);
    expect(Number(row.opened_at)).toBe(openedAt);

    const members = await postgres
      .getClient()
      .query('SELECT zone_id, left_at FROM incident_members WHERE incident_id = $1 ORDER BY zone_id', [
        incidentId
      ]);
    expect(members.rows.map((r) => r.zone_id)).toEqual(zones);
    expect(members.rows.every((r) => r.left_at === null)).toBe(true);

    // The replay. Byte-identical, exactly as a redelivery would be — incident ids are
    // deterministic, so the same event carries the same key.
    await publish(opened);
    await sleep(3000);

    const timeline = await postgres
      .getClient()
      .query('SELECT count(*)::int AS n FROM incident_events WHERE incident_id = $1', [incidentId]);
    expect(timeline.rows[0].n).toBe(1);

    const memberCount = await postgres
      .getClient()
      .query('SELECT count(*)::int AS n FROM incident_members WHERE incident_id = $1', [incidentId]);
    expect(memberCount.rows[0].n).toBe(3);
  }, 90000);

  it('closes every membership interval when the incident closes', async () => {
    await publish(
      event({
        eventType: 'CLOSED',
        status: 'CLOSED',
        lifecycleStatus: 'CLOSED',
        closeReason: 'GRACE_EXPIRED',
        updatedAt: openedAt + 300_000,
        closedAt: openedAt + 300_000
      })
    );

    const open = await waitFor(
      async () => {
        const result = await postgres
          .getClient()
          .query(
            'SELECT count(*)::int AS n FROM incident_members WHERE incident_id = $1 AND left_at IS NULL',
            [incidentId]
          );
        return result.rows[0].n === 0 ? result.rows[0] : null;
      },
      30000,
      'every membership interval to close'
    );
    expect(open.n).toBe(0);

    const incident = await postgres
      .getClient()
      .query('SELECT status, closed_at FROM incidents WHERE incident_id = $1', [incidentId]);
    expect(incident.rows[0].status).toBe('CLOSED');
    expect(Number(incident.rows[0].closed_at)).toBe(openedAt + 300_000);

    // Two distinct timeline entries now: OPENED and CLOSED, each once.
    const timeline = await postgres
      .getClient()
      .query(
        'SELECT event_type FROM incident_events WHERE incident_id = $1 ORDER BY event_time, event_type',
        [incidentId]
      );
    expect(timeline.rows.map((r) => r.event_type)).toEqual(['OPENED', 'CLOSED']);
  }, 90000);
});
