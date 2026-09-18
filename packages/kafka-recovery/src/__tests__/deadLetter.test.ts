import { Kafka } from 'kafkajs';

import { DLQ_TOPIC, KafkaDeadLetterProducer } from '../deadLetter';

/**
 * The dead letter producer is what makes "the message was not lost" a true statement rather than
 * an intention, so the parts of it that carry meaning are worth pinning: the original bytes go
 * through untouched, the provenance headers are complete enough for a replay tool to put the
 * message back without parsing the payload, and publishing before connecting fails loudly instead
 * of quietly doing nothing.
 *
 * Only `producer.send` is substituted. The class is constructed against a real `Kafka` client, so
 * the partitioner and the auto-creation setting are the shipped ones.
 */
function producerWith(send: jest.Mock, topic?: string): KafkaDeadLetterProducer {
  const kafka = new Kafka({ clientId: 'dlq-test', brokers: ['localhost:9092'] });
  const producer = new KafkaDeadLetterProducer(kafka, topic);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (producer as any).producer = {
    send,
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined)
  };
  return producer;
}

const RECORD = {
  value: Buffer.from('{"zoneId":"Z-0042","currentState":"STRESSED"}'),
  key: Buffer.from('83283ffffffffff'),
  sourceTopic: 'zone.degradations',
  sourcePartition: 7,
  sourceOffset: '9182',
  reason: 'handler-failed',
  error: 'Error: relation "zone_alerts" does not exist',
  attempts: 4,
  failedAt: 1_700_000_000_000
};

describe('KafkaDeadLetterProducer', () => {
  it('defaults to the DLQ of the topic it shadows', () => {
    expect(DLQ_TOPIC).toBe('zone.degradations.dlq');
  });

  it('refuses to publish before connecting, rather than silently doing nothing', async () => {
    const send = jest.fn();
    await expect(producerWith(send).publish(RECORD)).rejects.toThrow('not connected');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the original bytes untouched, so the message can be replayed verbatim', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const producer = producerWith(send);
    await producer.connect();

    await producer.publish(RECORD);

    const sent = send.mock.calls[0][0];
    expect(sent.topic).toBe(DLQ_TOPIC);
    expect(sent.messages[0].value).toBe(RECORD.value);
    expect(sent.messages[0].key).toBe(RECORD.key);
  });

  it('carries provenance a replay tool can use without parsing the payload', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const producer = producerWith(send);
    await producer.connect();

    await producer.publish(RECORD);

    expect(send.mock.calls[0][0].messages[0].headers).toEqual({
      'x-source-topic': 'zone.degradations',
      'x-source-partition': '7',
      'x-source-offset': '9182',
      'x-failure-reason': 'handler-failed',
      'x-failure-error': 'Error: relation "zone_alerts" does not exist',
      'x-failure-attempts': '4',
      'x-failed-at': '1700000000000'
    });
  });

  it('honours an overridden topic', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const producer = producerWith(send, 'other.dlq');
    await producer.connect();

    await producer.publish(RECORD);

    expect(send.mock.calls[0][0].topic).toBe('other.dlq');
  });

  it('lets a send failure escape, because a swallowed one is a lost message', async () => {
    const send = jest.fn().mockRejectedValue(new Error('broker unreachable'));
    const producer = producerWith(send);
    await producer.connect();

    // processWithRecovery catches this and rethrows so the offset is not committed. Absorbing it
    // here would make the whole dead-letter contract a lie.
    await expect(producer.publish(RECORD)).rejects.toThrow('broker unreachable');
  });

  it('is idempotent about connecting and disconnecting', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const producer = producerWith(send);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = (producer as any).producer;

    await producer.connect();
    await producer.connect();
    expect(inner.connect).toHaveBeenCalledTimes(1);

    await producer.disconnect();
    await producer.disconnect();
    expect(inner.disconnect).toHaveBeenCalledTimes(1);
  });

  it('is a no-op to disconnect something that never connected', async () => {
    const producer = producerWith(jest.fn());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = (producer as any).producer;

    await producer.disconnect();

    expect(inner.disconnect).not.toHaveBeenCalled();
  });
});
