/**
 * `@geopulse/kafka-recovery` — the shared answer to "what happens to a Kafka message that could
 * not be processed".
 *
 * **Why a package rather than a module in one service.** This started as
 * `alert-processor/src/messageRecovery.ts`, written to close defect D1: `eachMessage` wrapped
 * its work in try/catch and logged the failure, which returns normally, which tells kafkajs the
 * message was handled, which commits the offset. A failed Postgres insert therefore destroyed
 * the alert it was supposed to make durable.
 *
 * The same bug was still sitting in `stream-processor/src/kafkaConsumer.ts`, in the same shape,
 * for the same reason. Fixing it by writing the retry loop a second time would have produced two
 * implementations of the one rule in this system that is genuinely load-bearing for data loss,
 * free to drift apart — and the *interesting* part of that rule is not the loop, it is the
 * decision of what to do when the loop gives up. Two services, two different right answers, one
 * place where both are spelled out and named: see `FailurePolicy`.
 *
 * Kafka is a peer dependency, not a dependency: this package must not be able to pull a second
 * copy of kafkajs into a service that already has one.
 */
export {
  DeadLetterPublisher,
  DeadLetterRecord,
  DLQ_TOPIC,
  KafkaDeadLetterProducer
} from './deadLetter';
export {
  backoffFor,
  DEFAULT_RETRY_POLICY,
  Disposition,
  FailurePolicy,
  processWithRecovery,
  RecoveryContext,
  retryPolicyFromEnv,
  RetryPolicy,
  retryWithBackoff
} from './messageRecovery';
