import { EachMessagePayload } from 'kafkajs';
import { DeadLetterPublisher, DeadLetterRecord } from '@geopulse/kafka-recovery';

import { KafkaIncidentConsumer } from '../incidentConsumer';
import { IncidentWireEvent } from '../incidentTypes';

class RecordingDeadLetterPublisher implements DeadLetterPublisher {
  public records: DeadLetterRecord[] = [];
  async publish(record: DeadLetterRecord): Promise<void> {
    this.records.push(record);
  }
}

const EVENT: IncidentWireEvent = {
  incidentId: 'c0ffee00c0ffee00c0ffee00c0ffee00',
  eventType: 'OPENED',
  status: 'OPEN',
  lifecycleStatus: 'OPEN',
  memberZones: ['Z-0001', 'Z-0002', 'Z-0003'],
  memberCount: 3,
  peakSeverity: 0.91,
  severity: 0.91,
  footprint: {
    h3Cells: ['85283473fffffff'],
    centroid: { latitude: 37.7749, longitude: -122.4194 },
    radiusKm: 12.5
  },
  propagation: null,
  mergedFrom: null,
  supersededBy: null,
  splitFrom: null,
  closeReason: null,
  openedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  closedAt: null,
  h3CoarseCell: '83283ffffffffff'
};

function payload(value: Buffer | null): EachMessagePayload {
  return {
    topic: 'zone.incidents',
    partition: 7,
    message: {
      key: Buffer.from(EVENT.h3CoarseCell),
      value,
      offset: '4242',
      timestamp: '0',
      attributes: 0,
      size: 0,
      headers: {}
    },
    heartbeat: async () => {},
    pause: () => () => {}
  } as unknown as EachMessagePayload;
}

function consumerFor(
  handler: (event: IncidentWireEvent) => Promise<void>,
  deadLetter: DeadLetterPublisher
) {
  const consumer = new KafkaIncidentConsumer({
    deadLetter,
    policy: { maxAttempts: 3, initialBackoffMs: 10, backoffMultiplier: 2, maxBackoffMs: 50 },
    sleep: async () => {}
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (consumer as any).handler = handler;
  return consumer;
}

describe('KafkaIncidentConsumer', () => {
  it('parses the wire event and hands it to the repository', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const consumer = consumerFor(handler, new RecordingDeadLetterPublisher());

    const disposition = await consumer.handleMessage(payload(Buffer.from(JSON.stringify(EVENT))));

    expect(disposition).toBe('processed');
    expect(handler).toHaveBeenCalledWith(EVENT);
    expect(consumer.stats()).toEqual({ consumed: 1, deadLettered: 0 });
  });

  it('retries a transient Postgres failure', async () => {
    const handler = jest
      .fn()
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce(undefined);
    const consumer = consumerFor(handler, new RecordingDeadLetterPublisher());

    await expect(
      consumer.handleMessage(payload(Buffer.from(JSON.stringify(EVENT))))
    ).resolves.toBe('processed');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  /**
   * An incident event is the product's output and nothing re-emits it: the correlation engine's
   * state is in memory and its fold is idempotent, so re-reading the degradations behind this
   * event produces the same state and emits nothing at all. Dropping would be losing it.
   */
  it('dead-letters rather than drops, because nothing re-emits an incident event', async () => {
    const dlq = new RecordingDeadLetterPublisher();
    const handler = jest.fn().mockRejectedValue(new Error('relation "incidents" does not exist'));
    const consumer = consumerFor(handler, dlq);

    const disposition = await consumer.handleMessage(payload(Buffer.from(JSON.stringify(EVENT))));

    expect(disposition).toBe('dead-lettered');
    expect(handler).toHaveBeenCalledTimes(3);
    expect(JSON.parse(dlq.records[0].value.toString())).toEqual(EVENT);
    expect(dlq.records[0].sourceTopic).toBe('zone.incidents');
    expect(dlq.records[0].sourcePartition).toBe(7);
    expect(consumer.stats().deadLettered).toBe(1);
  });

  it('throws when the DLQ is unavailable too, so the offset is not committed', async () => {
    const broken: DeadLetterPublisher = {
      publish: async () => {
        throw new Error('DLQ unreachable');
      }
    };
    const consumer = consumerFor(jest.fn().mockRejectedValue(new Error('postgres down')), broken);

    await expect(
      consumer.handleMessage(payload(Buffer.from(JSON.stringify(EVENT))))
    ).rejects.toThrow(/Failed to dead-letter message from zone\.incidents\[7\]@4242/);
  });

  it('dead-letters an unparseable event without retrying a poison pill', async () => {
    const dlq = new RecordingDeadLetterPublisher();
    const handler = jest.fn();
    const consumer = consumerFor(handler, dlq);

    await expect(consumer.handleMessage(payload(Buffer.from('{not json')))).resolves.toBe(
      'dead-lettered'
    );
    expect(handler).not.toHaveBeenCalled();
    expect(dlq.records[0].reason).toBe('unparseable');
  });

  it('refuses to start consuming before it is connected', async () => {
    const consumer = consumerFor(jest.fn(), new RecordingDeadLetterPublisher());
    await expect(consumer.startConsuming(async () => {})).rejects.toThrow('not connected');
  });
});
