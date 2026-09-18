import {
  DeadLetterPublisher,
  DeadLetterRecord,
  processWithRecovery,
  RetryPolicy
} from '@geopulse/kafka-recovery';

import { AlertProcessor } from '../alertProcessor';
import { PostgresClient, ZoneAlertRow } from '../postgresClient';
import { ZoneDegradation } from '../types';

/**
 * The end-to-end version of defect D1: a real AlertProcessor whose Postgres write rejects.
 * D1 was that this exception was swallowed by the consumer and the offset committed anyway.
 *
 * The generic properties of `processWithRecovery` are tested in `@geopulse/kafka-recovery`,
 * where the function lives. What is tested here is the part that is specific to this service and
 * cannot be asserted from inside the package: that a real `AlertProcessor` failure reaches the
 * recovery path at all, and that this service uses the `'dead-letter'` policy — because a
 * degradation that reached `alert-processor` is the durable record of a state transition, and
 * `stream-processor` makes the opposite call about the raw samples it derived that transition
 * from (ADR-000, amendment).
 */
class RecordingDeadLetterPublisher implements DeadLetterPublisher {
  public records: DeadLetterRecord[] = [];
  async publish(record: DeadLetterRecord): Promise<void> {
    this.records.push(record);
  }
}

const FAST_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 10,
  backoffMultiplier: 2,
  maxBackoffMs: 50
};

const DEGRADATION: ZoneDegradation = {
  zoneId: 'Z-0042',
  h3Cell: '85283473fffffff',
  h3CoarseCell: '83283ffffffffff',
  latitude: 37.7749,
  longitude: -122.4194,
  previousState: 'NORMAL',
  currentState: 'STRESSED',
  severity: 0.77,
  avg1m: 0.81,
  avg5m: 0.77,
  eventTime: 1_700_000_000_000
};

describe('D1 regression: a failing Postgres write must not silently drop the degradation', () => {
  class RejectingPostgresClient extends PostgresClient {
    public attempts = 0;
    async insertAlert(_row: ZoneAlertRow): Promise<void> {
      this.attempts++;
      throw new Error('duplicate key value violates unique constraint');
    }
  }

  /** Minimal in-memory stand-in for the Redis commands AlertProcessor actually uses. */
  function fakeRedis() {
    const lists = new Map<string, string[]>();
    return {
      lists,
      client: {
        lPush: jest.fn(async (key: string, value: string) => {
          const list = lists.get(key) ?? [];
          list.unshift(value);
          lists.set(key, list);
          return list.length;
        }),
        lTrim: jest.fn(async (key: string, start: number, stop: number) => {
          const list = lists.get(key) ?? [];
          lists.set(key, list.slice(start, stop + 1));
          return 'OK';
        })
      } as any
    };
  }

  it('propagates out of the real AlertProcessor and parks the degradation in the DLQ', async () => {
    const postgres = new RejectingPostgresClient();
    const redis = fakeRedis();
    const processor = new AlertProcessor(redis.client, postgres);
    const dlq = new RecordingDeadLetterPublisher();

    const disposition = await processWithRecovery<ZoneDegradation>({
      value: Buffer.from(JSON.stringify(DEGRADATION)),
      key: Buffer.from(DEGRADATION.h3CoarseCell),
      topic: 'zone.degradations',
      partition: 3,
      offset: '9182',
      parse: (raw) => JSON.parse(raw.toString()) as ZoneDegradation,
      handle: (degradation) => processor.persistAlert(degradation),
      onFailure: 'dead-letter',
      deadLetter: dlq,
      policy: FAST_POLICY,
      sleep: async () => {}
    });

    expect(disposition).toBe('dead-lettered');
    expect(postgres.attempts).toBe(FAST_POLICY.maxAttempts);

    // The degradation is recoverable byte-for-byte from the DLQ.
    expect(JSON.parse(dlq.records[0].value.toString())).toEqual(DEGRADATION);

    // And nothing was written to Redis for a write that never became durable, because
    // persistAlert writes Postgres first.
    expect(redis.client.lPush).not.toHaveBeenCalled();
  });
});
