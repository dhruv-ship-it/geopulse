import { IncidentStore } from './incidentStore';
import { IncidentPublisher } from './kafkaProducer';
import { logger } from './logger';
import { IncidentWireEvent } from './types';

export interface IncidentDispatcherStats {
  dispatched: number;
  flushes: number;
  /** Times a flush failed and its events were carried into the next attempt. */
  retainedFlushes: number;
  /** Events currently held, waiting for a successful flush. */
  pending: number;
}

/**
 * Gets a reconcile's incident events out of the process — to Kafka, then to Redis — and holds
 * on to them until both have succeeded.
 *
 * ## Why this is not just two awaits in the batch handler
 *
 * The obvious version is `await publish(events); await store.apply(events);` inside the handler,
 * with a throw redelivering the batch. That is wrong here, and the reason is specific to a
 * stateful consumer.
 *
 * The correlation engine's state is **in memory**. Redelivering a batch re-folds its messages,
 * and every operation in that fold is idempotent — `admit` takes maxima, `activate` re-runs
 * unions, `reconcile` is a function of the current partition. So the second fold produces the
 * *same state* and therefore emits **nothing**: there is no transition left to describe. The
 * events from the failed attempt would be silently lost, and nothing in the system would say so
 * — the incident would simply never have been announced, while the engine went on believing it
 * had been.
 *
 * So the events outlive the fold that produced them. They sit here until a flush succeeds, and
 * every later batch flushes them first. The buffer is bounded by how long the downstream is
 * down, and a downstream that is down also stops offsets advancing, so it does not grow
 * without limit.
 *
 * ## Kafka first, then Redis
 *
 * `zone.incidents` is the product's output and the durable record; Redis is a cache of the
 * present, rebuilt by anything that replays the topic. Publishing first means the worst case is
 * a Redis view that lags the topic, which self-corrects on the retry. The other order would risk
 * a Redis state describing an incident nobody was ever told about.
 *
 * A flush that publishes and then fails to write Redis republishes on retry, so `zone.incidents`
 * can carry duplicates. That is at-least-once, chosen over the alternative of dropping output,
 * and it is cheap to consume: incident ids are deterministic (ADR-003), so a duplicate event is
 * byte-identical to the one before it and a consumer that overwrites by id needs no dedup logic
 * at all.
 *
 * ## What this does not survive
 *
 * A process crash. The pending buffer is memory, and so is the correlation window behind it — a
 * restarted engine rebuilds its state by re-reading from the last committed offset, and events
 * it had computed but not flushed are gone. Phase 1 accepts that: the window refills within
 * `CORRELATION_WINDOW_MS` of stream time, and the incidents re-derive. The fix, when it is
 * worth it, is the usual one — periodically snapshot the engine's state to a compacted topic
 * and restore from it on start — and it belongs with the partitioned, multi-consumer design
 * (`01-ARCHITECTURE.md` §6) rather than bolted onto a single-consumer Phase 1.
 */
export class IncidentDispatcher {
  private pending: IncidentWireEvent[] = [];

  private dispatched = 0;
  private flushes = 0;
  private retainedFlushes = 0;

  constructor(
    private readonly publisher: IncidentPublisher,
    private readonly store: IncidentStore
  ) {}

  /**
   * Queue a reconcile's events and flush everything outstanding. Throws if the flush fails,
   * which is what stops the caller resolving its offsets.
   */
  async dispatch(events: readonly IncidentWireEvent[]): Promise<void> {
    if (events.length > 0) {
      this.pending.push(...events);
    }
    if (this.pending.length === 0) {
      return;
    }

    const batch = this.pending;
    try {
      await this.publisher.publish(batch);
      await this.store.apply(batch);
    } catch (error) {
      this.retainedFlushes++;
      logger.error(
        { error, pending: batch.length },
        'Failed to dispatch incident events; holding them for the next attempt'
      );
      throw error;
    }

    // Cleared only on success, and by replacement rather than by truncation: `batch` is the same
    // array, and emptying it in place would erase the events a failed attempt is meant to keep.
    this.pending = [];
    this.flushes++;
    this.dispatched += batch.length;
  }

  stats(): IncidentDispatcherStats {
    return {
      dispatched: this.dispatched,
      flushes: this.flushes,
      retainedFlushes: this.retainedFlushes,
      pending: this.pending.length
    };
  }
}
