import { DeadLetterPublisher } from './deadLetter';

/**
 * How a consumed message was disposed of. Returned rather than thrown so the caller can
 * decide what to log; anything that does NOT return here throws, and a throw out of
 * eachMessage is what stops kafkajs committing the offset.
 */
export type Disposition = 'processed' | 'dead-lettered' | 'dropped' | 'skipped';

/**
 * What happens to a message that cannot be processed, once retries are exhausted.
 *
 * There is no default, and that is the point: every call site names it. The two services that
 * use this module make opposite calls and both are right for their data — see ADR-000 and its
 * amendment. Leaving it implicit would mean the cheaper policy could be inherited by accident
 * somewhere it costs a durable fact.
 *
 * - `'dead-letter'` — park the original bytes on the DLQ, then let the offset commit. For a
 *   message that is a *fact*: nothing else in the system carries it, so losing it loses data.
 * - `'drop'` — count it and move on. For a message that is a *sample* of a signal that is
 *   re-sampled continuously: the next one arrives in a second, and a DLQ entry per lost sample
 *   is a firehose nobody will ever replay.
 */
export type FailurePolicy = 'dead-letter' | 'drop';

export interface RetryPolicy {
  /** Total attempts including the first. 1 means no retry. */
  maxAttempts: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
}

/**
 * A retry policy with no environment in it. Services that want theirs configurable build it
 * with `retryPolicyFromEnv`, under their own variable prefix — this module is shared, so a
 * hard-coded `ALERT_*` read here would silently retune a service that never heard of it.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  initialBackoffMs: 100,
  backoffMultiplier: 3,
  maxBackoffMs: 5000
};

/** Read `<PREFIX>_MAX_ATTEMPTS` and friends, falling back to `DEFAULT_RETRY_POLICY`. */
export function retryPolicyFromEnv(
  prefix: string,
  env: NodeJS.ProcessEnv = process.env,
  fallback: RetryPolicy = DEFAULT_RETRY_POLICY
): RetryPolicy {
  return {
    maxAttempts: parseInt(env[`${prefix}_MAX_ATTEMPTS`] || String(fallback.maxAttempts), 10),
    initialBackoffMs: parseInt(
      env[`${prefix}_INITIAL_BACKOFF_MS`] || String(fallback.initialBackoffMs),
      10
    ),
    backoffMultiplier: parseFloat(
      env[`${prefix}_BACKOFF_MULTIPLIER`] || String(fallback.backoffMultiplier)
    ),
    maxBackoffMs: parseInt(env[`${prefix}_MAX_BACKOFF_MS`] || String(fallback.maxBackoffMs), 10)
  };
}

export interface RecoveryContext<T> {
  value: Buffer | null;
  key: Buffer | null;
  topic: string;
  partition: number;
  offset: string;
  /** Deserialise. Throwing here means a poison pill: retrying cannot help. */
  parse: (raw: Buffer) => T;
  handle: (parsed: T) => Promise<void>;
  /** Required, and deliberately so. See `FailurePolicy`. */
  onFailure: FailurePolicy;
  /** Required when `onFailure` is `'dead-letter'`; ignored otherwise. */
  deadLetter?: DeadLetterPublisher;
  policy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  onDeadLetter?: (reason: string, err: unknown) => void;
  /** Called instead of `onDeadLetter` when the policy is `'drop'`. */
  onDrop?: (reason: string, err: unknown, attempts: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Delay before attempt `attempt + 1`, given that `attempt` just failed. */
export function backoffFor(policy: RetryPolicy, attempt: number): number {
  return Math.min(
    policy.initialBackoffMs * Math.pow(policy.backoffMultiplier, attempt - 1),
    policy.maxBackoffMs
  );
}

/**
 * Run `operation` until it succeeds or the policy runs out of attempts, then rethrow the last
 * failure.
 *
 * Extracted from `processWithRecovery` because the producing side needs it too. A
 * `stream-processor` that fails to publish a degradation faces the same transient-versus-
 * permanent question and should answer it the same way, but it holds no Kafka message and no
 * offset, so it cannot use the consumer-shaped function wrapped around it.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  hooks: {
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  } = {}
): Promise<T> {
  const sleep = hooks.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt < policy.maxAttempts) {
        const delayMs = backoffFor(policy, attempt);
        hooks.onRetry?.(attempt, delayMs, err);
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

/**
 * Process one Kafka message such that it is never silently dropped.
 *
 * The bug this replaces: `eachMessage` wrapped everything in try/catch and logged the error.
 * Returning normally from `eachMessage` tells kafkajs the message was handled, so the offset
 * is committed and the message is gone forever. A failed Postgres insert therefore destroyed
 * the alert it was supposed to make durable. That was defect D1, and it was present in two
 * consumers; this module exists so the fix is one implementation rather than two.
 *
 * The rules now:
 *   - transient handler failure  -> bounded retry with exponential backoff, in-process
 *   - exhausted retries          -> `onFailure`, then the offset may commit
 *   - unparseable message        -> straight to `onFailure`, no retries (retrying a poison pill
 *                                   just blocks the partition forever)
 *   - DLQ itself unavailable     -> throw, so the offset is NOT committed and kafkajs
 *                                   redelivers the message later
 *
 * The last rule is the important one: under `'dead-letter'` the DLQ is the only thing that
 * makes it safe to commit after a failure, so if the DLQ is down we must fall back to not
 * committing. Under `'drop'` there is nothing to be unavailable, which is exactly the cost
 * being accepted — a dropped message is gone, and `onDrop` is what keeps it from being gone
 * *quietly*.
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
    return await giveUp(ctx, 'unparseable', err, 1);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      await ctx.handle(parsed);
      return 'processed';
    } catch (err) {
      lastError = err;
      if (attempt < policy.maxAttempts) {
        const delayMs = backoffFor(policy, attempt);
        ctx.onRetry?.(attempt, delayMs, err);
        await sleep(delayMs);
      }
    }
  }

  return await giveUp(ctx, 'handler-failed', lastError, policy.maxAttempts);
}

async function giveUp<T>(
  ctx: RecoveryContext<T>,
  reason: string,
  err: unknown,
  attempts: number
): Promise<Disposition> {
  if (ctx.onFailure === 'drop') {
    ctx.onDrop?.(reason, err, attempts);
    return 'dropped';
  }

  ctx.onDeadLetter?.(reason, err);
  if (!ctx.deadLetter) {
    // A configuration error, not a runtime one, and it must not be allowed to degrade into the
    // very silent drop this module exists to prevent.
    throw new Error(
      `onFailure is 'dead-letter' but no DeadLetterPublisher was supplied for ` +
        `${ctx.topic}[${ctx.partition}]@${ctx.offset}`
    );
  }

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

  return 'dead-lettered';
}
