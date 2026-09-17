/**
 * The correlation core: membership in event time, and connected components over it.
 *
 * Everything the service layer (WP3) needs is here, and nothing here knows about Kafka, Redis,
 * Postgres or HTTP. That separation is what makes the differential fuzz test possible at all —
 * 10,000 randomised sequences a second because there is no I/O to wait for — and it is also what
 * lets the eval harness (WP6b) replay a ground-truth scenario through the same code the service
 * runs, without standing up the stack.
 *
 * `IncidentLifecycle` — component to incident, with OPENED / GREW / MERGED / SHRANK / CLOSED —
 * is WP2b and lands next. It will be exported from here too.
 */
export {
  AdjacencyProvider,
  Connectivity,
  canonicalise,
  describePartition
} from './connectivity';
export {
  CorrelationWindow,
  CorrelationWindowOptions,
  CorrelationWindowStats,
  WindowMember
} from './correlationWindow';
export { NaiveConnectivity } from './naiveConnectivity';
export { TimeAwareConnectivity, TimeAwareConnectivityStats } from './timeAwareConnectivity';
