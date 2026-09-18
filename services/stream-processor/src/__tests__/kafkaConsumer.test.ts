import { EachMessagePayload } from 'kafkajs';

import { KafkaEventConsumer } from '../kafkaConsumer';
import { SensorEvent } from '../types';

/**
 * Defect D1, in the consumer that still had it.
 *
 * The old `eachMessage` caught everything and logged it, which returns normally, which commits
 * the offset. These tests drive `handleMessage` — the body of `eachMessage`, extracted for
 * exactly this reason — with a hand-built payload, and assert the two properties that matter:
 * a transient failure is retried rather than discarded on the first try, and a message that
 * cannot be handled at all is *reported* rather than swallowed.
 *
 * The drop policy is the deliberate difference from `alert-processor`, which dead-letters. See
 * the class doc and ADR-000's amendment: a sensor event is one sample of a signal re-sampled
 * every second, and a DLQ entry per lost sample at 400 zones is a firehose nobody replays.
 */
const EVENT: SensorEvent = {
  eventId: '6f0a4b0c-1c8e-4d9a-9a8b-2f5d3c7e1a44',
  zoneId: 'Z-0042',
  latitude: 37.7749,
  longitude: -122.4194,
  load: 0.81,
  eventTimestamp: 1_700_000_000_000,
  producedAt: 1_700_000_000_010
};

function payload(value: Buffer | null, offset = '9182'): EachMessagePayload {
  return {
    topic: 'raw.zone.events',
    partition: 3,
    message: {
      key: Buffer.from(EVENT.zoneId),
      value,
      offset,
      timestamp: '0',
      attributes: 0,
      size: 0,
      headers: {}
    },
    heartbeat: async () => {},
    pause: () => () => {}
  } as unknown as EachMessagePayload;
}

function consumerFor(handler: (event: SensorEvent, partition: number) => Promise<void>) {
  const consumer = new KafkaEventConsumer({
    policy: { maxAttempts: 3, initialBackoffMs: 10, backoffMultiplier: 2, maxBackoffMs: 50 },
    sleep: async () => {}
  });
  // startConsuming() would need a live broker; the handler is what the recovery path wraps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (consumer as any).messageHandler = handler;
  return consumer;
}

describe('KafkaEventConsumer recovery', () => {
  it('passes the parsed event and its partition to the handler', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const consumer = consumerFor(handler);

    const disposition = await consumer.handleMessage(
      payload(Buffer.from(JSON.stringify(EVENT)))
    );

    expect(disposition).toBe('processed');
    // The partition travels with the event because event-time progress is a per-partition
    // property — see the comment in handleMessage.
    expect(handler).toHaveBeenCalledWith(EVENT, 3);
    expect(consumer.stats()).toEqual({ consumed: 1, dropped: 0 });
  });

  it('retries a transient handler failure instead of discarding the event', async () => {
    const handler = jest
      .fn()
      .mockRejectedValueOnce(new Error('redis connection reset'))
      .mockResolvedValueOnce(undefined);
    const consumer = consumerFor(handler);

    const disposition = await consumer.handleMessage(
      payload(Buffer.from(JSON.stringify(EVENT)))
    );

    expect(disposition).toBe('processed');
    expect(handler).toHaveBeenCalledTimes(2);
    expect(consumer.stats().dropped).toBe(0);
  });

  it('drops a persistently failing event after the policy is exhausted, and counts it', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('redis down'));
    const consumer = consumerFor(handler);

    const disposition = await consumer.handleMessage(
      payload(Buffer.from(JSON.stringify(EVENT)))
    );

    expect(disposition).toBe('dropped');
    expect(handler).toHaveBeenCalledTimes(3);
    // The drop is the deliberate policy; the count is what keeps it from being D1 again.
    expect(consumer.stats()).toEqual({ consumed: 0, dropped: 1 });
  });

  it('drops an unparseable event without retrying a poison pill', async () => {
    const handler = jest.fn();
    const consumer = consumerFor(handler);

    const disposition = await consumer.handleMessage(payload(Buffer.from('{not json')));

    expect(disposition).toBe('dropped');
    expect(handler).not.toHaveBeenCalled();
    expect(consumer.stats().dropped).toBe(1);
  });

  it('skips a tombstone without counting it as a drop', async () => {
    const handler = jest.fn();
    const consumer = consumerFor(handler);

    const disposition = await consumer.handleMessage(payload(null));

    expect(disposition).toBe('skipped');
    expect(handler).not.toHaveBeenCalled();
    expect(consumer.stats()).toEqual({ consumed: 0, dropped: 0 });
  });

  /**
   * Pins the boundary between this consumer's policy and the producer's.
   *
   * Every handler failure is absorbed here, by design — that is what `'drop'` means, and it is
   * the whole reason a slow downstream cannot stall this partition. The escape hatch lives one
   * level down: `KafkaDegradationProducer.publish` throws only when it could neither publish a
   * degradation *nor* dead-letter it, and that throw travels straight through `eachMessage` so
   * the offset is not committed. Asserted there, in `kafkaProducer.test.ts`; asserted here is
   * that this layer does not accidentally catch it first.
   */
  it('honours a single-attempt policy without retrying', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('boom'));
    const consumer = new KafkaEventConsumer({
      policy: { maxAttempts: 1, initialBackoffMs: 1, backoffMultiplier: 1, maxBackoffMs: 1 },
      sleep: async () => {}
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (consumer as any).messageHandler = handler;

    await expect(
      consumer.handleMessage(payload(Buffer.from(JSON.stringify(EVENT))))
    ).resolves.toBe('dropped');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses to start consuming before it is connected', async () => {
    const consumer = new KafkaEventConsumer();
    await expect(consumer.startConsuming(async () => {})).rejects.toThrow('not connected');
  });
});
