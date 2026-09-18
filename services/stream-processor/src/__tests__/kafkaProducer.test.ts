import { DeadLetterPublisher, DeadLetterRecord } from '@geopulse/kafka-recovery';

import { KafkaDegradationProducer } from '../kafkaProducer';
import { ZoneDegradation } from '../types';

/**
 * Drives the real producer with its kafkajs `send` replaced.
 *
 * The producer is constructed for real — its Kafka client, its partitioner, its policy — and
 * only the one method that would open a socket is substituted. The alternative, a test that
 * stands up a broker and then takes it away mid-run to prove the DLQ path, would be slower and
 * would prove less: a broker will not fail a send on request.
 */
function producerWith(
  send: jest.Mock,
  deadLetter: DeadLetterPublisher
): KafkaDegradationProducer {
  const producer = new KafkaDegradationProducer({
    deadLetter,
    policy: { maxAttempts: 3, initialBackoffMs: 10, backoffMultiplier: 2, maxBackoffMs: 50 },
    sleep: async () => {}
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (producer as any).producer = { send, connect: jest.fn(), disconnect: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (producer as any).isConnected = true;
  return producer;
}

class RecordingDeadLetterPublisher implements DeadLetterPublisher {
  public records: DeadLetterRecord[] = [];
  async publish(record: DeadLetterRecord): Promise<void> {
    this.records.push(record);
  }
}

const DEGRADATION: ZoneDegradation = {
  zoneId: 'Z-0042',
  h3Cell: '85283473fffffff',
  h3CoarseCell: '83283ffffffffff',
  latitude: 37.7749,
  longitude: -122.4194,
  previousState: 'NORMAL',
  currentState: 'STRESSED',
  severity: 0.81,
  avg1m: 0.81,
  avg5m: 0.77,
  eventTime: 1_700_000_000_000
};

describe('KafkaDegradationProducer', () => {
  it('keys the record by coarse cell, not by zone id', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    await producerWith(send, new RecordingDeadLetterPublisher()).publish(DEGRADATION);

    const record = send.mock.calls[0][0];
    expect(record.topic).toBe('zone.degradations');
    expect(record.messages[0].key).toBe('83283ffffffffff');
    expect(record.messages[0].key).not.toBe(DEGRADATION.zoneId);
  });

  /**
   * D10 in one assertion. Retention is evaluated against the record timestamp, and this
   * pipeline's event time sits at a fixed historical epoch, so a producer that stamps its own
   * timestamp hands the broker a deletion deadline 245 days in the past. The event time is
   * carried in the payload instead, which is the only place any consumer reads it from.
   */
  it('sets no record timestamp, so the broker stamps LogAppendTime', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    await producerWith(send, new RecordingDeadLetterPublisher()).publish(DEGRADATION);

    expect(send.mock.calls[0][0].messages[0].timestamp).toBeUndefined();
    const payload = JSON.parse(send.mock.calls[0][0].messages[0].value);
    expect(payload.eventTime).toBe(DEGRADATION.eventTime);
  });

  it('round-trips the whole schema', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    await producerWith(send, new RecordingDeadLetterPublisher()).publish(DEGRADATION);

    expect(JSON.parse(send.mock.calls[0][0].messages[0].value)).toEqual(DEGRADATION);
  });

  it('publishes a recovery like any other transition', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const recovery: ZoneDegradation = {
      ...DEGRADATION,
      previousState: 'STRESSED',
      currentState: 'NORMAL',
      severity: 0.41
    };

    await producerWith(send, new RecordingDeadLetterPublisher()).publish(recovery);

    expect(JSON.parse(send.mock.calls[0][0].messages[0].value).currentState).toBe('NORMAL');
  });

  it('retries a transient send failure rather than losing the transition', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error('LEADER_NOT_AVAILABLE'))
      .mockResolvedValueOnce(undefined);
    const dlq = new RecordingDeadLetterPublisher();

    const producer = producerWith(send, dlq);
    await producer.publish(DEGRADATION);

    expect(send).toHaveBeenCalledTimes(2);
    expect(dlq.records).toHaveLength(0);
    expect(producer.stats()).toEqual({ published: 1, retried: 1, deadLettered: 0 });
  });

  /**
   * The transition is a derived fact and nothing re-emits it — the state machine has already
   * advanced past it and will not fire again while the condition holds. So an exhausted publish
   * must leave the degradation recoverable, not logged.
   */
  it('dead-letters a degradation it cannot publish, recoverable byte for byte', async () => {
    const send = jest.fn().mockRejectedValue(new Error('broker unreachable'));
    const dlq = new RecordingDeadLetterPublisher();

    const producer = producerWith(send, dlq);
    await producer.publish(DEGRADATION);

    expect(send).toHaveBeenCalledTimes(3);
    expect(dlq.records).toHaveLength(1);
    expect(JSON.parse(dlq.records[0].value.toString())).toEqual(DEGRADATION);
    expect(dlq.records[0].sourceTopic).toBe('zone.degradations');
    expect(dlq.records[0].reason).toBe('publish-failed');
    expect(dlq.records[0].attempts).toBe(3);
    expect(producer.stats().deadLettered).toBe(1);
  });

  it('does not invent a partition for a message that never reached one', async () => {
    const send = jest.fn().mockRejectedValue(new Error('broker unreachable'));
    const dlq = new RecordingDeadLetterPublisher();

    await producerWith(send, dlq).publish(DEGRADATION);

    // A replay tool reads these headers as provenance. Claiming partition 0 would be a lie.
    expect(dlq.records[0].sourcePartition).toBe(-1);
    expect(dlq.records[0].sourceOffset).toBe('unpublished');
  });

  /**
   * The last resort: with nowhere durable to park it, the only thing left that does not lose
   * the transition is to fail the message, so the consumer does not commit the offset and the
   * raw sensor event is redelivered.
   */
  it('throws when the DLQ is unreachable too, so the offset is not committed', async () => {
    const send = jest.fn().mockRejectedValue(new Error('broker unreachable'));
    const brokenDlq: DeadLetterPublisher = {
      publish: async () => {
        throw new Error('DLQ unreachable');
      }
    };

    await expect(producerWith(send, brokenDlq).publish(DEGRADATION)).rejects.toThrow(
      'DLQ unreachable'
    );
  });

  it('refuses to publish before it is connected', async () => {
    const producer = new KafkaDegradationProducer({
      deadLetter: new RecordingDeadLetterPublisher()
    });
    await expect(producer.publish(DEGRADATION)).rejects.toThrow('not connected');
  });
});
