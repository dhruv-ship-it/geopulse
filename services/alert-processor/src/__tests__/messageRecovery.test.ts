import { processWithRecovery, RetryPolicy } from '../messageRecovery';
import { DeadLetterPublisher, DeadLetterRecord } from '../deadLetter';
import { AlertProcessor } from '../alertProcessor';
import { ZoneAlert } from '../types';
import { PostgresClient, ZoneAlertRow } from '../postgresClient';

/** Collects dead letters in memory so a test can assert the message survived. */
class RecordingDeadLetterPublisher implements DeadLetterPublisher {
  public records: DeadLetterRecord[] = [];
  async publish(record: DeadLetterRecord): Promise<void> {
    this.records.push(record);
  }
}

class BrokenDeadLetterPublisher implements DeadLetterPublisher {
  async publish(): Promise<void> {
    throw new Error('DLQ broker unreachable');
  }
}

const FAST_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 10,
  backoffMultiplier: 2,
  maxBackoffMs: 50
};

const noSleep = async () => {};

const ALERT: ZoneAlert = {
  zoneId: 'Z-0042',
  previousState: 'NORMAL',
  currentState: 'STRESSED',
  avg1m: 0.81,
  avg5m: 0.77,
  timestamp: 1_700_000_000_000
};

function ctxFor(
  handle: (alert: ZoneAlert) => Promise<void>,
  deadLetter: DeadLetterPublisher,
  value: Buffer | null = Buffer.from(JSON.stringify(ALERT))
) {
  return {
    value,
    key: Buffer.from(ALERT.zoneId),
    topic: 'zone.alerts',
    partition: 3,
    offset: '9182',
    parse: (raw: Buffer) => JSON.parse(raw.toString()) as ZoneAlert,
    handle,
    deadLetter,
    policy: FAST_POLICY,
    sleep: noSleep
  };
}

describe('processWithRecovery', () => {
  it('commits nothing and loses nothing when persistence keeps failing: the message lands in the DLQ', async () => {
    const dlq = new RecordingDeadLetterPublisher();
    const handle = jest.fn().mockRejectedValue(new Error('insert into zone_alerts failed'));

    const disposition = await processWithRecovery(ctxFor(handle, dlq));

    expect(disposition).toBe('dead-lettered');
    expect(handle).toHaveBeenCalledTimes(FAST_POLICY.maxAttempts);
    expect(dlq.records).toHaveLength(1);

    // The exact original bytes are recoverable — this is the "not lost" assertion.
    const recovered: ZoneAlert = JSON.parse(dlq.records[0].value.toString());
    expect(recovered).toEqual(ALERT);
    expect(dlq.records[0].sourceTopic).toBe('zone.alerts');
    expect(dlq.records[0].sourcePartition).toBe(3);
    expect(dlq.records[0].sourceOffset).toBe('9182');
    expect(dlq.records[0].reason).toBe('handler-failed');
    expect(dlq.records[0].attempts).toBe(FAST_POLICY.maxAttempts);
  });

  it('throws when the DLQ is also unavailable, so the offset is not committed', async () => {
    const handle = jest.fn().mockRejectedValue(new Error('postgres down'));

    await expect(
      processWithRecovery(ctxFor(handle, new BrokenDeadLetterPublisher()))
    ).rejects.toThrow(/Failed to dead-letter message from zone\.alerts\[3\]@9182/);
  });

  it('retries a transient failure and succeeds without dead-lettering', async () => {
    const dlq = new RecordingDeadLetterPublisher();
    const handle = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(undefined);

    const disposition = await processWithRecovery(ctxFor(handle, dlq));

    expect(disposition).toBe('processed');
    expect(handle).toHaveBeenCalledTimes(2);
    expect(dlq.records).toHaveLength(0);
  });

  it('dead-letters an unparseable message immediately rather than retrying a poison pill', async () => {
    const dlq = new RecordingDeadLetterPublisher();
    const handle = jest.fn();

    const disposition = await processWithRecovery(
      ctxFor(handle, dlq, Buffer.from('{not json'))
    );

    expect(disposition).toBe('dead-lettered');
    expect(handle).not.toHaveBeenCalled();
    expect(dlq.records[0].reason).toBe('unparseable');
    expect(dlq.records[0].value.toString()).toBe('{not json');
  });

  it('skips a tombstone without dead-lettering it', async () => {
    const dlq = new RecordingDeadLetterPublisher();
    const handle = jest.fn();

    const disposition = await processWithRecovery(ctxFor(handle, dlq, null));

    expect(disposition).toBe('skipped');
    expect(handle).not.toHaveBeenCalled();
    expect(dlq.records).toHaveLength(0);
  });

  it('applies exponential backoff capped at maxBackoffMs', async () => {
    const dlq = new RecordingDeadLetterPublisher();
    const delays: number[] = [];
    const handle = jest.fn().mockRejectedValue(new Error('boom'));

    await processWithRecovery({
      ...ctxFor(handle, dlq),
      policy: { maxAttempts: 5, initialBackoffMs: 100, backoffMultiplier: 3, maxBackoffMs: 500 },
      sleep: async (ms: number) => {
        delays.push(ms);
      }
    });

    expect(delays).toEqual([100, 300, 500, 500]);
  });
});

/**
 * The end-to-end version of the defect: a real AlertProcessor whose Postgres write rejects.
 * D1 was that this exception was swallowed by the consumer and the offset committed anyway.
 */
describe('D1 regression: a failing Postgres write must not silently drop the alert', () => {
  class RejectingPostgresClient extends PostgresClient {
    public attempts = 0;
    constructor() {
      super();
    }
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

  it('propagates out of the real AlertProcessor and parks the alert in the DLQ', async () => {
    const postgres = new RejectingPostgresClient();
    const redis = fakeRedis();
    const processor = new AlertProcessor(redis.client, postgres);
    const dlq = new RecordingDeadLetterPublisher();

    const disposition = await processWithRecovery(
      ctxFor((alert) => processor.persistAlert(alert), dlq)
    );

    expect(disposition).toBe('dead-lettered');
    expect(postgres.attempts).toBe(FAST_POLICY.maxAttempts);

    // The alert is recoverable byte-for-byte from the DLQ.
    expect(JSON.parse(dlq.records[0].value.toString())).toEqual(ALERT);

    // And nothing was written to Redis for a write that never became durable, because
    // persistAlert writes Postgres first.
    expect(redis.client.lPush).not.toHaveBeenCalled();
  });
});
