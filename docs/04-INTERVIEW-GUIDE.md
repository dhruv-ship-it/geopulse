# 04 — Interview Guide

> The code is not the deliverable. **You are.** This document is how the project converts into
> offers.

---

## 1. The 60-second pitch

Practise until it is smooth but not recited. Pause after the second beat — that is where the
interviewer usually interrupts with a question, and that is a good sign.

> "I built a real-time monitoring pipeline on Kafka — sensors across geographic zones, sliding
> windows, a state machine with hysteresis so a flapping metric wouldn't spam alerts.
>
> Then I injected a regional fault to test it, and got about two hundred alerts in ninety seconds
> for what was obviously one event. I'd solved alert flapping in the *time* dimension and done
> nothing at all about *space*.
>
> So the second version correlates alerts geographically. Zones map onto an H3 hex grid, and when
> adjacent zones degrade inside the same time window I treat them as one incident using streaming
> connected-components — union-find over the adjacency graph, with time-based expiry of members.
> Two hundred alerts become one incident.
>
> And the incident carries information no individual alert could have: I fit a regression over
> member join times and positions, so the incident knows it's moving north-east at about forty
> kilometres an hour. That's an emergent property — it doesn't exist at the level of a single
> sensor."

**Why this works:** it opens with a problem anyone understands, it contains an honest moment of
discovering your own system was wrong, and it ends on a claim that is genuinely non-obvious. The
"emergent property" line is the hook — it is the thing that makes an interviewer lean in.

---

## 2. Framing rules

**Lead with the problem, never the tech.** "I built a thing with Kafka and Redis" invites
"so what?". "Two hundred pages for one outage" invites "how did you fix it?".

**Own the origin story.** You built v1, found it wanting by running it honestly, and built v2.
Do not pretend you designed the correlation engine from day one. The arc *is* the credibility —
engineers trust people who have debugged their own design.

**Volunteer limitations before you're asked.** "The correlation state is in memory, so a restart
loses it — the fix is changelog-backed state stores, same model Kafka Streams uses, and I scoped
it as the next phase." This converts your weakest point into evidence of judgement. An
interviewer who finds a gap you hid is far worse than one you walked into deliberately.

**Have one number ready and know its provenance.** The collapse ratio. Absolute numbers, not just
a percentage, and be able to name the file it came from.

**Never say "the AI wrote that."** Also never claim you hand-typed every line. If asked directly
about tooling: *"I used AI assistance for implementation, the same way I'd use any tool — the
design decisions, the correctness argument, and the evaluation methodology are mine, and I can
walk you through any of them."* Then demonstrate it by actually walking them through one. That is
a completely normal 2026 answer and does not hurt you; being unable to explain your own code does.

---

## 3. Questions you will be asked — and must answer without notes

Grouped by how likely they are. **If you cannot answer a Tier 1 question cold, the project is not
ready to be on the resume.**

### Tier 1 — near-certain

**Q1. Why hexagons?**
Every one of a hexagon's six neighbours is equidistant from its centre. On a square grid, the four
diagonal neighbours are √2 times farther than the four edge neighbours, so "adjacent" would mean
different physical distances in different directions — which would bias correlation directionally.
Hexagons give isotropic adjacency, which is exactly the property a spatial correlation rule needs.
(Also: H3 gives O(1) neighbour lookup by cell arithmetic, no distance computation in the hot path.)

**Q2. Why not just cluster by distance — DBSCAN, or a radius query?**
Three reasons. First, cost: DBSCAN is O(n log n) per run and would need re-running continuously as
the active set changes; H3 adjacency is O(1) per lookup and incremental. Second, semantics: I want
*transitive connectivity* — a chain of adjacent degraded zones is one incident even if its two ends
are 200 km apart — which is connected-components, not density clustering. Third, streaming: DBSCAN
is a batch algorithm, and this is a stream.
*(If pushed: yes, there are incremental DBSCAN variants; I judged the complexity not worth it for
a property I get for free from the grid.)*

**Q3. Walk me through union-find.**
Forest of trees, each tree a component, each node pointing at a parent, root is the representative.
`find` walks to the root; **path compression** re-points every node on that walk directly at the
root. `union` links the two roots, **by rank/size** so the shallower tree hangs off the deeper one.
Together those give O(α(n)) amortised, where α is the inverse Ackermann function — effectively a
small constant (≤ 5) for any n that fits in this universe.

**Q4. Union-find has no delete. Your members expire. How do you handle that?**
Correct — and that is the central design problem. Deletion breaks the structure because a node may
be an interior node of a compressed tree; removing it would disconnect descendants that are still
genuinely connected through other edges, and the structure has thrown away the edge information
needed to know that.
My approach: incremental unions on the hot path, and a periodic compaction tick that removes
expired members and **rebuilds only the components that actually lost a member** — a local BFS over
that component's survivors, O(V+E) within the component rather than across the whole graph. That
works because arrivals are frequent and expiries are comparatively rare, and components are small
relative to the universe.
Alternatives I considered: full recompute every tick (I kept it — as a test oracle, not as the
implementation); and fully dynamic connectivity structures like Holm–de Lichtenberg–Thorup or
Euler-tour trees at O(log² n) amortised, which I rejected as more implementation complexity than
my scale justifies. It's in ADR-002.

**Q5. How do you know the optimised version is correct?**
Differential testing. I kept the naive full-recompute implementation as an oracle and fuzz both
with the same randomised event sequences — ten thousand of them — asserting the component
partitions are identical. Plus property-based tests for invariants: every active zone is in exactly
one component; two zones share a component iff a path of active adjacent zones connects them;
replaying an identical event sequence produces byte-identical output.
That is stronger evidence than unit tests, because unit tests only check cases I thought of and
the fuzzer explores cases I didn't.

**Q6. Two incidents merge. What happens to the IDs you already published?**
The survivor is the incident with the earlier `openedAt`, ties broken lexicographically on ID — so
the outcome is deterministic and replay-stable. I emit a `MERGED` event on the survivor carrying
`mergedFrom: [loserIds]`, and a terminal event on each loser carrying `supersededBy`. Downstream
consumers must treat incident identity as mergeable — the contract is documented, and it's the
same class of problem as stream-stream joins or CRDT merges.
*(Follow-up you should expect: "and what if the bridging zone then expires and it splits again?"
→ largest surviving fragment keeps the ID, other fragments open fresh incidents. It's a judgement
call: I optimised for on-call continuity — the person already looking at that incident ID should
keep seeing the biggest part of the problem — rather than set-theoretic purity. ADR-003.)*

**Q7. What happens when the correlation engine crashes?**
Right now, honestly: in-memory state is lost, and on restart it rebuilds from the correlation
window as new degradations arrive — so incidents already open get re-opened with new IDs, and
in-flight correlation state within the window is lost.
The fix is the Kafka Streams state-store model: a compacted changelog topic per partition that the
state writes through to, and committing offsets and state atomically so recovery restores exactly
the state corresponding to the committed offset. I scoped it as the next phase and specified it in
`06-FUTURE-PHASES.md` — I chose to get the correlation semantics and the evaluation methodology
right first, because a fast, crash-safe implementation of the wrong algorithm is worth nothing.

**Q8. How does this scale? / Why can't you just add partitions?**
That is the most interesting problem in the project. The per-zone stage partitions by `zoneId` and
scales linearly — one consumer owns a zone's window state. But correlation needs to see
*neighbours* together, and hashing by `zoneId` scatters geographic neighbours uniformly at random
across partitions, which is precisely wrong.
So I repartition on a **coarse H3 cell** — roughly 60 km edge, much larger than a plausible
incident radius — which puts all zones in a region on the same partition and makes correlation
local again.
The cost is the boundary case: an incident straddling two coarse cells is seen as two incidents.
I measure how often that happens rather than hand-waving it. The complete fix is two-level
correlation — local correlation per cell, then any incident touching its cell boundary is
republished keyed by the parent cell for a second merge stage. That's structurally the same thing
distributed connected-components algorithms do at partition boundaries.

### Tier 2 — likely

**Q9. How did you pick the correlation window / H3 resolution?**
Parameter sweep across all four eval scenarios, with the tuning curve committed. Too short or too
fine and one real event fragments into many incidents; too long or too coarse and unrelated events
get merged. I picked the operating point off that curve. I can show you the curve.

**Q10. How do you know you're not just inventing incidents?**
That is exactly why the `noise` scenario exists — scattered independent single-zone degradations
with no regional structure at all. False-incident rate on that scenario is the metric that proves
the system isn't manufacturing structure out of noise. I also run `multi-anomaly`, two disjoint
simultaneous events, to catch the opposite failure of over-merging.

**Q11. Why a separate service instead of doing it in the stream processor?**
Different partitioning requirements — per-zone versus spatially-local — so they genuinely cannot
share a consumer group. Also different state profiles and different scaling curves. Keeping them
separate preserves the clean linear scaling of the per-zone stage and isolates the harder stateful
stage.

**Q12. Why `eachBatch` instead of `eachMessage`?**
A regional event produces a burst of degradations essentially simultaneously. Processing them one
at a time means emitting a `GREW` event per zone — hundreds of incident events for one real change.
Batching lets me apply the whole burst and emit one consolidated update. It also removes a network
round-trip per message from the hot path.

**Q13. What's your biggest bug story?**
The Postgres one, and tell it properly: the alert consumer caught and logged the exception from a
failed insert, which meant the offset committed anyway and the alert was gone permanently. The code
comment literally said it failed loudly for audit purposes. It did the exact opposite. Found it
reading my own error-handling path while auditing the pipeline before benchmarking. Fixed it by
letting the error propagate so kafkajs retries, with a bounded backoff and a dead-letter topic
after exhaustion.
*(This is a genuinely good answer — a real bug, in your own code, found by deliberate audit, with
a correct fix and an understanding of why the original was wrong.)*

**Q14. What would you do differently?**
Build the evaluation harness before the detector — I eventually did, and it changed what I built.
And design the partitioning key at the start instead of inheriting `zoneId` from v1 and
discovering it was wrong for correlation.

### Tier 3 — deep-dive / senior interviewers

**Q15. Exactly-once semantics?** Currently at-least-once with non-idempotent effects — a duplicate
degradation can produce a duplicate `GREW`. The path to correctness: idempotent producer +
transactional writes tying the offset commit and the state write into one transaction, which is
what `processing.guarantee=exactly_once_v2` does in Kafka Streams. Phase 3.

**Q16. Out-of-order events / watermarks?** Honest answer: the current windowing evicts relative to
the incoming event's timestamp, which means a future-dated event can prematurely evict a window.
It's a known defect, it's documented, and the correct fix is a proper watermark with a bounded
allowed-lateness and a side-output for late events.

**Q17. Backpressure?** kafkajs pauses fetching when the handler is slow, so consumer lag is the
backpressure signal. Lag is monitored, and a flat lag curve is a precondition for any throughput
number I report being valid.

**Q18. Why Kafka and not Flink, which has all of this built in?** Flink would give me windowing,
watermarks, checkpointed state, and exactly-once out of the box, and for a production system with
this shape it would be the right choice. I built it on raw Kafka deliberately, to understand the
mechanisms rather than consume them — which is also why I can tell you what Flink's checkpoint
barriers are actually doing. *(Only say the last clause if it is true. Learn it if you want to say it.)*

**Q19. Memory at a million zones?** Per-zone state is the window buckets plus a union-find node.
The unbounded-map defect is fixed with an idle TTL. At a million zones the real constraint is that
one process can't hold it — that is what the coarse-cell partitioning is for, and the number of
partitions is then sized by state-per-partition rather than by throughput.

---

## 4. Understanding checkpoints (self-test before each WP is "done")

Take these from each work package in `02-PHASE-1-CORRELATION.md`. The protocol:

1. Agent implements the package. You read the diff carefully.
2. **Close the editor.**
3. Answer the checkpoint questions out loud, as if to an interviewer.
4. Anything you stumble on → reopen, re-derive, repeat.

Being able to *read* the code is not the same as being able to *explain* it under pressure. The
gap between those two only closes by practising the second one.

---

## 5. Whiteboard-ready diagram

Practise drawing this in under 90 seconds. Most project conversations end up at a whiteboard.

```
   sensors           per-zone stage              spatial stage
   ───────           ──────────────              ─────────────
   [Z] [Z] [Z]  ──►  windows + FSM      ──►   H3 neighbour graph
   [Z] [Z] [Z]       (key: zoneId)            union-find + expiry
   [Z] [Z] [Z]       scales linearly          (key: coarse H3 cell)
                            │                          │
                     "this zone is bad"        "these zones are ONE thing"
                            │                          │
                            ▼                          ▼
                     200 alerts                  1 incident
                                                 + footprint
                                                 + direction of travel
```

The two labels in quotes are the whole project. If you draw nothing else, draw those.

---

## 6. If asked "is this actually useful in the real world?"

Yes, and it is a real product category — PagerDuty's Intelligent Alert Grouping, BigPanda,
Moogsoft, Datadog Watchdog all sell exactly this. What they mostly correlate on is *metadata*:
service tags, hostnames, deployment IDs, text similarity of alert titles. That works for software
topology.

It works poorly for physically-distributed infrastructure — telecom cell sites, power distribution,
logistics fleets, environmental sensor networks — where the thing that actually correlates failures
is physical adjacency, and no tag encodes "these two towers are on the same fibre run."

So the spatial angle isn't a toy substitute for the metadata approach; it covers a case the
metadata approach structurally cannot. And the two compose — in a real deployment you'd correlate
on both and take the union.
