# 06 — Future Phases (specified, deferred)

> These were ideated alongside Phase 1 and deliberately scoped out. They are specified here in
> enough detail that picking one up later costs no re-ideation — an agent can read the relevant
> section and start work.
>
> **Two independent reasons to read this even if you never build any of them:**
> (a) an interviewer *will* ask "what would you do next?", and a precise answer is worth a great
> deal; (b) an interviewer will probe Phase 1's gaps, and these are the answers.

---

## Phase 2 — Adaptive learned baselines

**Problem.** Zone degradation is currently decided by hardcoded thresholds — `avg5m >= 0.75`,
`avg1m >= 0.90`, identical for every zone. But zones have genuinely different normal behaviour: a
dense urban zone running at 0.8 is fine, a rural zone at 0.8 is in trouble. One global threshold
guarantees both false positives on busy zones and false negatives on quiet ones.

**Approach.**
1. **Streaming quantile sketches** per zone — DDSketch (relative-error guarantee, mergeable) or
   t-digest. Maintain per-zone p50/p95/p99 of load over a rolling multi-day horizon in bounded
   memory. Degradation becomes "this zone is above *its own* p99", not "above 0.75".
2. **Seasonality.** Load has daily and weekly structure — the existing `getDailyPattern` in the
   simulator already fakes this. Maintain EWMA baselines bucketed by hour-of-week so 3am is
   compared against 3am, not against a flat daily mean.
3. **Robust deviation scoring.** Median absolute deviation rather than standard deviation, so a
   single extreme spike does not inflate the threshold that is supposed to catch it.
4. **Cold start.** A new zone has no history. Fall back to the global prior, blending toward the
   zone's own distribution as observations accumulate (a Bayesian-flavoured shrinkage estimator;
   simple weighted blend is fine and defensible).

**Why it is valuable beyond accuracy:** it makes Phase 1's numbers better *and* it is where a
second, independent set of resume metrics comes from — precision/recall of zone-level detection
against injected ground truth, measured the same way as Phase 1.

**Metrics it produces.** Detection precision/recall/F1 vs static-threshold baseline; false-positive
reduction; memory per zone for the sketch (the DDSketch selling point — bounded, mergeable).

**Interview value.** Streaming quantile estimation is a genuinely good topic. Knowing *why*
DDSketch (relative error bound, mergeable across partitions) versus t-digest (better tail accuracy,
trickier merge) versus naive reservoir sampling is a strong signal.

---

## Phase 3 — Crash-safe stateful stream processing

**This is the single highest-value follow-up for backend/distributed-systems roles.** It is the
answer to the question Phase 1 is most exposed on.

**Problem.** Both `stream-processor` and `correlation-engine` hold all state in memory. A restart
loses every window and every open incident. There is no recovery, no checkpoint, and offset commits
are unrelated to state durability — so a crash can lose alerts *or* duplicate them, depending on
timing.

**Approach — reimplement the Kafka Streams state-store model on kafkajs, which has no equivalent.**

1. **Changelog-backed state stores.** Every state mutation writes through to a compacted Kafka
   topic keyed by the state key (`changelog.zone-windows`, `changelog.incidents`). Log compaction
   means the topic retains the latest value per key indefinitely at bounded size. On restart,
   replay the changelog to rebuild state before resuming.
2. **Atomic offset + state commit.** The correctness crux. Use a transactional producer: the state
   write and the consumer-offset commit go into one Kafka transaction
   (`sendOffsetsToTransaction`), so recovery always restores state matching exactly the committed
   offset. This is what `processing.guarantee=exactly_once_v2` does.
3. **Rebalance-safe partitioned state.** On partition revocation, flush and release that
   partition's state; on assignment, restore from the changelog before processing. Requires
   kafkajs rebalance-listener handling.
4. **Standby replicas (stretch).** A warm consumer tailing the changelog for partitions it does not
   own, so failover restores in milliseconds instead of a full replay.
5. **Real watermarks.** Fixes defect D3: track the max event-time seen per partition, define
   watermark = max − allowedLateness, evict windows on watermark rather than on the incoming
   event's timestamp, and side-output late events instead of silently corrupting windows.
6. **Chaos harness.** The proof. A script that `kill -9`s services at randomised points mid-stream,
   restarts them, and asserts the final incident set is byte-identical to a clean run over the
   same deterministic input. Report duplicates and losses across N injected faults.

**Metrics it produces.** Zero duplicate/lost incidents across N faults; p50/p95 state recovery time
vs state size; throughput cost of transactional writes (there is one — measure it honestly and be
able to state the trade-off).

**Why it is compelling to talk about.** "I reimplemented the Kafka Streams recovery model because
the JS ecosystem has no equivalent, and proved it with chaos testing" is a strong, specific claim
that invites exactly the questions you want.

---

## Phase 4 — Deterministic replay and time-travel debugging

**Premise.** The simulator is deterministic and all processing is event-time driven. That is a rare
and valuable property, and it enables something most systems cannot do.

**Approach.** Periodic state snapshots keyed by offset; restore-to-offset and replay forward; diff
two runs' incident streams; "what-if" replay with different parameters
(`CORRELATION_WINDOW_MS`, `H3_RESOLUTION`) over identical historical input; a CLI that answers
*"why was incident INC-8f2a opened?"* by replaying to just before that moment and dumping the
correlation state.

**Depends on** Phase 3 snapshots. **Metrics:** replay speed vs real-time (e.g. 50× faster);
parameter-sweep turnaround time.

**Interview value.** Debuggability is a senior concern and almost no candidate projects address it.
It also makes Phase 2's parameter tuning dramatically cheaper, which is a nice systems-thinking
story: the tooling investment paid for itself.

---

## Phase 5 — Agentic incident triage

**Only worth building with a real evaluation harness.** Without evals it is an LLM wrapper, and
senior interviewers in 2026 discount those heavily. With evals it demonstrates something rarer:
that you can engineer around a non-deterministic component.

**Approach.**
1. On incident OPEN, an agent assembles grounded context: member zones and their windows,
   neighbouring non-degraded zones (the negative evidence — what *didn't* fail is often the most
   informative signal), the footprint and propagation vector, and similar historical incidents
   retrieved by embedding the footprint + trajectory into pgvector.
2. Bounded tool surface — query zone history, query similar incidents, query topology. No free-form
   actions, no writes.
3. Output a structured hypothesis: probable cause class, confidence, supporting evidence with
   citations back to specific data, recommended next check.
4. **The actual work: the eval harness.** Build a labelled set of injected incidents whose true
   cause is known by construction (the simulator injected it), then measure cause-classification
   accuracy, citation groundedness (does every claim trace to retrieved data?), hallucination rate,
   p95 latency, and cost per incident.
5. Guardrails: refuse to answer below a confidence floor; never state a cause without a citation.

**Metrics.** Classification accuracy vs a naive baseline; groundedness rate; hallucination rate;
cost/latency per triage.

**Interview framing.** Lead with the eval harness, not the agent. *"The interesting part wasn't
prompting the model, it was building a labelled ground-truth set so I could measure whether it was
actually right"* is the sentence that separates this from a wrapper. Anyone can call an API; very
few candidates can tell you their hallucination rate and how they measured it.

---

## Phase 6 — Production deployment (smaller, opportunistic)

Lower intellectual value than 2/3, but cheap and relevant for infra-leaning interviews:

- **KRaft-mode Kafka**, dropping Zookeeper (removed in Kafka 4.0). Small diff, removes a dated
  detail from the stack, and is worth knowing about.
- Containerise all four services (currently only infra is dockerised).
- Kubernetes manifests with an HPA driven by **consumer lag** rather than CPU — lag is the correct
  scaling signal for a stream processor, and knowing that is itself a good talking point.
- Grafana dashboards over the existing Prometheus metrics; define SLOs (correlation latency p99,
  incident detection time) and alert on error budget burn.
- Multi-broker with replication factor 3, and `min.insync.replicas` tuned — then be able to explain
  the durability/availability trade-off that setting encodes.

---

## Deliberately rejected ideas (and why)

Recording these matters: "what did you consider and reject?" is a common question, and having a
real answer signals judgement.

| Idea | Why rejected |
|---|---|
| ML anomaly detection (LSTM / autoencoder on load series) | Unjustifiable complexity for data this simple; a per-zone quantile baseline (Phase 2) gets most of the benefit with a fraction of the cost and full explainability. Reaching for a neural net where a statistic suffices is a negative signal, not a positive one. |
| Graph database (Neo4j) for the zone topology | The adjacency graph is derivable from H3 cell arithmetic in O(1). Storing it externally adds a network hop, an operational dependency, and a consistency problem, to replace a computation that is already free. |
| Real geospatial datasets (OSM, real cell-tower locations) | Loses ground truth, which is the project's main measurement advantage. Synthetic-and-labelled beats real-and-unlabelled for demonstrating correctness. |
| Full frontend application (auth, dashboards, CRUD) | Dilutes a backend/distributed-systems project with work that signals nothing about the skills being assessed. The single-page live map (WP5) is the right amount of UI — it exists purely to make the mechanism visible. |
| Microservice sprawl (splitting into 8+ services) | Service count is not an achievement. Each additional service must earn its existence with a distinct scaling or partitioning requirement — which is precisely the argument made for `correlation-engine` and for nothing else. |
