import { DeadLetterPublisher } from './deadLetter';

/**
 * How a consumed message was disposed of. Returned rather than thrown so the caller can
 * decide what to log; anything that does NOT return here throws, and a throw out of
 * eachMessage is what stops kafkajs committing the offset.
 */
export type Disposition = 'processed' | 'dead-lettered' | 'skipped';

export interface RetryPolicy {
  /** Total attempts including the first. 1 means no retry. */
  maxAttempts: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: parseInt(process.env.ALERT_MAX_ATTEMPTS || '4', 10),
  initialBackoffMs: parseInt(process.env.ALERT_INITIAL_BACKOFF_MS || '100', 10),
  backoffMultiplier: parseFloat(process.env.ALERT_BACKOFF_MULTIPLIER || '3'),
  maxBackoffMs: parseInt(process.env.ALERT_MAX_BACKOFF_MS || '5000', 10)
};

export interface RecoveryContext<T> {
  value: Buffer | null;
  key: Buffer | null;
  topic: string;
  partition: number;
  offset: string;
  /** Deserialise. Throwing here means a poison pill: retrying cannot help. */
  parse: (raw: Buffer) => T;
  handle: (parsed: T) => Promise<void>;
  deadLetter: DeadLetterPublisher;
  policy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  onDeadLetter?: (reason: string, err: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Process one Kafka message such that it is never silently dropped.
 *
 * The bug this replaces: `eachMessage` wrapped everything in try/catch and logged the error.
 * Returning normally from `eachMessage` tells kafkajs the message was handled, so the offset
 * is committed and the message is gone forever. A failed Postgres insert therefore destroyed
 * the alert it was supposed to make durable.
 *
 * The rules now:
 *   - transient handler failure  -> bounded retry with exponential backoff, in-process
 *   - exhausted retries          -> published to the DLQ, then the offset may commit
 *   - unparseable message        -> straight to the DLQ, no retries (retrying a poison pill
 *                                   just blocks the partition forever)
 *   - DLQ itself unavailable     -> throw, so the offset is NOT committed and kafkajs
 *                                   redelivers the message later
 *
 * The last rule is the important one: the DLQ is the only thing that makes it safe to commit
 * after a failure, so if the DLQ is down we must fall back to not committing.
 */
export async function processWithRecovery<T>(ctx: RecoveryContext<T>): Promise<Disposition> {
  const policy = ctx.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = ctx.sleep ?? defaultSleep;

  if (!ctx.value) {
    // Null payload (tombstone). Nothing to persist and nothing to lose.
    return 'skipped';
  }

  let parsed: T;
  try {
    parsed = ctx.parse(ctx.value);
  } catch (err) {
    await sendToDeadLetter(ctx, 'unparseable', err, 1);
    return 'dead-lettered';
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      await ctx.handle(parsed);
      return 'processed';
    } catch (err) {
      lastError = err;
      if (attempt < policy.maxAttempts) {
        const delayMs = Math.min(
          policy.initialBackoffMs * Math.pow(policy.backoffMultiplier, attempt - 1),
          policy.maxBackoffMs
        );
        ctx.onRetry?.(attempt, delayMs, err);
        await sleep(delayMs);
      }
    }
  }

  await sendToDeadLetter(ctx, 'handler-failed', lastError, policy.maxAttempts);
  return 'dead-lettered';
}

async function sendToDeadLetter<T>(
  ctx: RecoveryContext<T>,
  reason: string,
  err: unknown,
  attempts: number
): Promise<void> {
  ctx.onDeadLetter?.(reason, err);
  try {
    await ctx.deadLetter.publish({
      value: ctx.value as Buffer,
      key: ctx.key,
      sourceTopic: ctx.topic,
      sourcePartition: ctx.partition,
      sourceOffset: ctx.offset,
      reason,
      error: describe(err),
      attempts,
      failedAt: Date.now()
    });
  } catch (dlqErr) {
    // Cannot park the message anywhere durable. Rethrow so the offset is not committed and
    // the broker hands the message back to us.
    throw new Error(
      `Failed to dead-letter message from ${ctx.topic}[${ctx.partition}]@${ctx.offset} ` +
        `(original failure: ${describe(err)}); DLQ error: ${describe(dlqErr)}`
    );
  }
}
