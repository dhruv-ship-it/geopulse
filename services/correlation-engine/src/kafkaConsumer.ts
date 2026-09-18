import { Consumer, EachBatchPayload, Kafka, KafkaMessage } from 'kafkajs';

import { logger } from './logger';
import { ZoneDegradation } from './types';

export interface DegradationConsumerOptions {
  broker: string;
  topic: string;
  groupId: string;
  fromBeginning: boolean;
  maxBatchSize: number;
}

/**
 * What a batch handler is given, and what it must guarantee.
 *
 * The contract is deliberately narrow: the handler receives the parsed messages of one batch and
 * must have made their effects durable — published and written — by the time it resolves. Only
 * then are offsets resolved. See `startConsuming`.
 */
export type BatchHandler = (messages: ZoneDegradation[]) => Promise<void>;

/**
 * Consumes `zone.degradations` a batch at a time.
 *
 * ## Why `eachBatch` and not `eachMessage`
 *
 * The full argument is in the README; the short version is that a regional fault does not
 * produce one degradation, it produces a burst of them — sixty-two zones in the reference
 * scenario, all within a few seconds of event time — and `eachMessage` would fold them in one at
 * a time with a reconcile after each. That yields an `OPENED` and sixty-one `GREW` events for
 * one fault, published, written to Redis and eventually persisted, each describing a state the
 * next one immediately obsoletes. `eachBatch` folds the whole burst in and reconciles once: one
 * `OPENED` carrying all sixty-two members.
 *
 * This is not a throughput optimisation with a correctness cost attached. The output is
 * *better*: the events a consumer receives describe the fault rather than the arrival order of
 * the messages that revealed it.
 *
 * ## Offsets
 *
 * `eachBatchAutoResolve` is off and offsets are resolved by hand, after the handler has
 * returned. That ordering is the whole point and it is the lesson of defect D1: the original
 * pipeline caught its own exception inside `eachMessage`, so kafkajs saw a clean return and
 * committed an offset for work that had failed. Here, a handler that throws resolves nothing and
 * the batch is redelivered.
 *
 * The consequence is at-least-once delivery, which is chosen rather than tolerated. The
 * alternative ordering — resolve first, then publish — would lose incident events on a crash,
 * and an incident event is the product's output. Every downstream write is an idempotent
 * overwrite keyed by a deterministic incident id, so a redelivered batch converges to the same
 * state.
 *
 * ## Heartbeats
 *
 * A large batch can take longer than the session timeout to fold in, and a consumer that does
 * not heartbeat inside that window is evicted from the group mid-batch — which then redelivers
 * the batch to somebody else, and looks exactly like a slow consumer getting slower. The handler
 * is awaited between the parse and the resolve, and `heartbeat()` is called around it.
 */
export class KafkaDegradationConsumer {
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;
  private connected = false;

  private batches = 0;
  private messages = 0;
  private skipped = 0;
  private unparseable = 0;

  constructor(private readonly options: DegradationConsumerOptions) {
    this.kafka = new Kafka({
      clientId: 'correlation-engine',
      brokers: [options.broker]
    });

    this.consumer = this.kafka.consumer({
      groupId: options.groupId,
      // Off deliberately: subscribing to a topic that does not exist should fail loudly rather
      // than conjure a 1-partition topic. See tools/kafka-bootstrap.
      allowAutoTopicCreation: false,
      maxBytesPerPartition: 1048576
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: this.options.topic,
      fromBeginning: this.options.fromBeginning
    });
    this.connected = true;
    logger.info(
      {
        broker: this.options.broker,
        topic: this.options.topic,
        groupId: this.options.groupId,
        fromBeginning: this.options.fromBeginning
      },
      'Degradation consumer connected'
    );
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.consumer.disconnect();
    this.connected = false;
    logger.info('Degradation consumer disconnected');
  }

  async startConsuming(handler: BatchHandler): Promise<void> {
    if (!this.connected) {
      throw new Error('Consumer not connected');
    }

    await this.consumer.run({
      eachBatchAutoResolve: false,
      eachBatch: async (payload: EachBatchPayload) => {
        await this.processBatch(payload, handler);
      }
    });

    logger.info({ maxBatchSize: this.options.maxBatchSize }, 'Correlation consumer started');
  }

  stats(): { batches: number; messages: number; skipped: number; unparseable: number } {
    return {
      batches: this.batches,
      messages: this.messages,
      skipped: this.skipped,
      unparseable: this.unparseable
    };
  }

  /**
   * Exposed for tests, which drive it with a hand-built `EachBatchPayload` rather than a broker.
   * The alternative — a test that stands up Kafka to prove that offsets are not resolved when a
   * handler throws — would be slower and would prove less, because the failure it has to produce
   * is one a broker will not produce on request.
   */
  async processBatch(payload: EachBatchPayload, handler: BatchHandler): Promise<void> {
    const { batch, resolveOffset, heartbeat, isRunning, isStale } = payload;

    // A batch fetched before a rebalance belongs to a partition this consumer no longer owns.
    // Processing it would fold degradations into a window whose partition has moved on.
    if (!isRunning() || isStale()) {
      logger.debug(
        { topic: batch.topic, partition: batch.partition },
        'Dropping a stale or shutting-down batch without resolving offsets'
      );
      return;
    }

    const messages = batch.messages;
    // A batch larger than the configured maximum is processed in slices. kafkajs sizes batches
    // in bytes, not messages, so the message count is not directly bounded; slicing keeps the
    // fold — and therefore the consolidation a single reconcile performs — to a size the
    // heartbeat interval can cover.
    for (let start = 0; start < messages.length; start += this.options.maxBatchSize) {
      if (!isRunning() || isStale()) {
        return;
      }

      const slice = messages.slice(start, start + this.options.maxBatchSize);
      const parsed = this.parse(slice, batch.topic, batch.partition);

      this.batches++;
      this.messages += parsed.length;

      // No try/catch. Anything the handler throws must escape eachBatch so that the offsets
      // below are never reached and kafkajs redelivers. That is defect D1, in one comment.
      await handler(parsed);

      // Durable now: resolve every offset in the slice, including the ones that failed to parse.
      // A message that cannot be JSON-parsed cannot be parsed on the next attempt either, so
      // leaving its offset unresolved would stall the partition forever on a single bad byte.
      for (const message of slice) {
        resolveOffset(message.offset);
      }
      await heartbeat();
    }
  }

  private parse(messages: readonly KafkaMessage[], topic: string, partition: number): ZoneDegradation[] {
    const parsed: ZoneDegradation[] = [];

    for (const message of messages) {
      if (message.value === null) {
        // A tombstone. `zone.degradations` is not a compacted topic, so this should not occur;
        // it is counted rather than assumed away.
        this.skipped++;
        continue;
      }
      try {
        parsed.push(JSON.parse(message.value.toString()) as ZoneDegradation);
      } catch (error) {
        this.unparseable++;
        logger.error(
          { error, topic, partition, offset: message.offset },
          'Degradation is not valid JSON; skipping its offset'
        );
      }
    }

    return parsed;
  }
}
