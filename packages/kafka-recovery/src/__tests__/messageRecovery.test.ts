import { DeadLetterPublisher, DeadLetterRecord } from '../deadLetter';
import {
  backoffFor,
  DEFAULT_RETRY_POLICY,
  processWithRecovery,
  RecoveryContext,
  retryPolicyFromEnv,
  RetryPolicy,
  retryWithBackoff
} from '../messageRecovery';

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

/**
 * A stand-in payload. The package is deliberately ignorant of what a GeoPulse message contains —
 * the two services that use it hand it different shapes — so the tests are too.
 */
interface Payload {
  zoneId: string;
  currentState: string;
  eventTime: number;
}

const MESSAGE: Payload = {
  zoneId: 'Z-0042',
  currentState: 'STRESSED',
  eventTime: 1_700_000_000_000
};

function ctxFor(
  handle: (payload: Payload) => Promise<void>,
  deadLetter: DeadLetterPublisher,
  value: Buffer | null = Buffer.from(JSON.stringify(MESSAGE))
): RecoveryContext<Payload> {
  return {
    value,
    key: Buffer.from(MESSAGE.zoneId),
    topic: 'zone.degradations',
    partition: 3,
    offset: '9182',
    parse: (raw: Buffer) => JSON.parse(raw.toString()) as Payload,
    handle,
    onFailure: 'dead-letter',
    deadLetter,
    policy: FAST_POLICY,
    sleep: noSleep
  };
}

describe('processWithRecovery, dead-letter policy', () => {
  it('commits nothing and loses nothing when persistence keeps failing: the message lands in the DLQ', async () => {
    const dlq = new RecordingDeadLetterPublisher();
    const handle = jest.fn().mockRejectedValue(new Error('insert into zone_alerts failed'));

    const disposition = await processWithRecovery(ctxFor(handle, dlq));

    expect(disposition).toBe('dead-lettered');
    expect(handle).toHaveBeenCalledTimes(FAST_POLICY.maxAttempts);
    expect(dlq.records).toHaveLength(1);

    // The exact original bytes are recoverable — this is the "not lost" assertion.
    const recovered: Payload = JSON.parse(dlq.records[0].value.toString());
    expect(recovered).toEqual(MESSAGE);
    expect(dlq.records[0].sourceTopic).toBe('zone.degradations');
    expect(dlq.records[0].sourcePartition).toBe(3);
    expect(dlq.records[0].sourceOffset).toBe('9182');
    expect(dlq.records[0].reason).toBe('handler-failed');
    expect(dlq.records[0].attempts).toBe(FAST_POLICY.maxAttempts);
  });

  it('throws when the DLQ is also unavailable, so the offset is not committed', async () => {
    const handle = jest.fn().mockRejectedValue(new Error('postgres down'));

    await expect(
      processWithRecovery(ctxFor(handle, new BrokenDeadLetterPublisher()))
    ).rejects.toThrow(/Failed to dead-letter message from zone\.degradations\[3\]@9182/);
  });

  it('throws rather than dropping when the policy asks for a DLQ and none was supplied', async () => {
    const handle = jest.fn().mockRejectedValue(new Error('postgres down'));
    const ctx = ctxFor(handle, new RecordingDeadLetterPublisher());

    await expect(
      processWithRecovery({ ...ctx, deadLetter: undefined })
    ).rejects.toThrow(/no DeadLetterPublisher was supplied/);
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
 * The cheaper policy, and the properties that make it defensible: it still retries, it still
 * never returns a lie about what happened, and the give-up is *reported* rather than logged and
 * forgotten. Its whole difference from the dead-letter policy is that the message is gone
 * afterwards — which is the trade `stream-processor` makes for raw sensor samples, and the one
 * `alert-processor` must never make. See ADR-000's amendment.
 */
describe('processWithRecovery, drop policy', () => {
  function dropCtx(handle: (payload: Payload) => Promise<void>, value?: Buffer | null) {
    const ctx = ctxFor(handle, new RecordingDeadLetterPublisher(), value);
    return { ...ctx, onFailure: 'drop' as const, deadLetter: undefined };
  }

  it('retries first, then drops and reports rather than dead-lettering', async () => {
    const handle = jest.fn().mockRejectedValue(new Error('redis down'));
    const drops: { reason: string; attempts: number }[] = [];

    const disposition = await processWithRecovery({
      ...dropCtx(handle),
      onDrop: (reason, _err, attempts) => drops.push({ reason, attempts })
    });

    expect(disposition).toBe('dropped');
    expect(handle).toHaveBeenCalledTimes(FAST_POLICY.maxAttempts);
    expect(drops).toEqual([{ reason: 'handler-failed', attempts: FAST_POLICY.maxAttempts }]);
  });

  it('drops an unparseable message without retrying it', async () => {
    const handle = jest.fn();
    const drops: string[] = [];

    const disposition = await processWithRecovery({
      ...dropCtx(handle, Buffer.from('{not json')),
      onDrop: (reason) => drops.push(reason)
    });

    expect(disposition).toBe('dropped');
    expect(handle).not.toHaveBeenCalled();
    expect(drops).toEqual(['unparseable']);
  });

  it('needs no DLQ at all, which is the point of it', async () => {
    const handle = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(
      processWithRecovery({ ...dropCtx(handle), onDrop: undefined })
    ).resolves.toBe('dropped');
  });

  it('still returns processed when the handler eventually succeeds', async () => {
    const handle = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);

    await expect(processWithRecovery(dropCtx(handle))).resolves.toBe('processed');
  });
});

describe('retryWithBackoff', () => {
  it('returns the operation result once it succeeds', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new Error('not yet'))
      .mockResolvedValueOnce('published');

    await expect(
      retryWithBackoff(operation, FAST_POLICY, { sleep: noSleep })
    ).resolves.toBe('published');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('rethrows the last failure after exhausting the policy', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('broker unreachable'));
    const delays: number[] = [];

    await expect(
      retryWithBackoff(operation, FAST_POLICY, { sleep: async (ms) => void delays.push(ms) })
    ).rejects.toThrow('broker unreachable');

    expect(operation).toHaveBeenCalledTimes(FAST_POLICY.maxAttempts);
    expect(delays).toEqual([10, 20]);
  });

  it('reports each retry', async () => {
    const attempts: number[] = [];
    const operation = jest.fn().mockRejectedValue(new Error('nope'));

    await expect(
      retryWithBackoff(operation, FAST_POLICY, {
        sleep: noSleep,
        onRetry: (attempt) => attempts.push(attempt)
      })
    ).rejects.toThrow();

    expect(attempts).toEqual([1, 2]);
  });

  it('runs exactly once under a no-retry policy', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('once'));
    const policy: RetryPolicy = { ...FAST_POLICY, maxAttempts: 1 };

    await expect(retryWithBackoff(operation, policy, { sleep: noSleep })).rejects.toThrow('once');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('policy configuration', () => {
  it('caps the backoff rather than growing without bound', () => {
    const policy: RetryPolicy = {
      maxAttempts: 6,
      initialBackoffMs: 100,
      backoffMultiplier: 10,
      maxBackoffMs: 5000
    };
    expect([1, 2, 3, 4].map((n) => backoffFor(policy, n))).toEqual([100, 1000, 5000, 5000]);
  });

  it('reads a prefixed policy out of the environment', () => {
    const policy = retryPolicyFromEnv('ALERT', {
      ALERT_MAX_ATTEMPTS: '7',
      ALERT_INITIAL_BACKOFF_MS: '25',
      ALERT_BACKOFF_MULTIPLIER: '1.5',
      ALERT_MAX_BACKOFF_MS: '900'
    } as NodeJS.ProcessEnv);

    expect(policy).toEqual({
      maxAttempts: 7,
      initialBackoffMs: 25,
      backoffMultiplier: 1.5,
      maxBackoffMs: 900
    });
  });

  it('falls back to the default for every variable that is absent', () => {
    expect(retryPolicyFromEnv('SENSOR', {} as NodeJS.ProcessEnv)).toEqual(DEFAULT_RETRY_POLICY);
  });

  it('keeps two services on separate prefixes', () => {
    const env = { ALERT_MAX_ATTEMPTS: '9', SENSOR_MAX_ATTEMPTS: '2' } as NodeJS.ProcessEnv;
    expect(retryPolicyFromEnv('ALERT', env).maxAttempts).toBe(9);
    expect(retryPolicyFromEnv('SENSOR', env).maxAttempts).toBe(2);
  });
});
