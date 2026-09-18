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
Isotropic adjacency. On a square grid the four diagonal neighbours are exactly √2 = 1.4142 times
farther than the four edge neighbours, so "adjacent" means different physical distances in
different directions and correlation would be directionally biased. A hexagon's six neighbours are
near-equidistant.

**Say "near", not "equal", and have the number.** H3 is a hexagonal grid projected onto a sphere
through an icosahedron, so the cells are distorted and the six neighbours are not exactly
equidistant. I measured it over 5,000 cells sampled uniformly by area: furthest-over-nearest is
**1.045 median, 1.207 worst**, against the square grid's **exact 1.4142**. The point is not just
that hexagons are better, it is that the square grid's anisotropy is structural and everywhere
while the hexagon's is a bounded projection artefact.
(Also: O(1) neighbour lookup by cell arithmetic — no distance computation in the hot path.)

*Expect the follow-up, because it is the standard H3 gotcha:* there are **12 pentagons** at every
resolution, one per icosahedron vertex, with 5 neighbours instead of 6. My tests cover a zone
inside one. Cell area also varies — 156 to 305 km² at resolution 5, a 1.95 ratio — which is why
the same sensor density gives different neighbourhood sizes depending on where on the globe the
field sits. That showed up in my own benchmark as neighbour counts drifting 2.9 to 4.2 at fixed
density, and it tracked mean cell area exactly.

*And the honest limitation, if they push:* cell adjacency **brackets** a distance threshold rather
than equalling one. Measured over 1,200 zones in a 200 km square: two zones 9.2 km apart can
already be non-adjacent, and two 31.7 km apart can still be adjacent. Closer than the first is
always adjacent, further than the second never is, and in between it depends where the cell
boundary falls. If that band ever mattered I would filter by cell and then verify by true
distance — ADR-001 records that upgrade with an explicit trigger rather than pretending the
problem does not exist.

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
Differential testing against an oracle. I kept the naive full-recompute implementation — it is not
dead code, it is the reference — and drive both through one shared window with an identical call
sequence, comparing the component partitions **after every single operation**, not just at the end.
Measured: **11,000 sequences, 551,871 operations, 551,871 partition comparisons, zero
divergences.** Seed is pinned, so it reproduces exactly on any machine.

**Then the part that actually makes that number mean something.** A fuzz test that never generates
the hard cases passes trivially while testing nothing — so I measure what the generator reached
and assert on it. That run hit **7,732 component splits, 110,754 expirations, 5,305 full teardowns,
largest component 28.** Splits are the case the whole design turns on: union-find cannot delete, so
a member expiring mid-component is exactly where a wrong implementation diverges. Without that
second assertion, "zero divergences over 11,000 sequences" could mean the optimised path was never
put under stress.

Plus property tests for the invariants: every active zone in exactly one component; two zones share
a component iff a path of active adjacent zones connects them; replay of an identical sequence is
byte-identical. And 1,000 of those sequences run over the **real H3 neighbour graph** rather than a
synthetic one, with a guard that the generated field is neither fully disconnected nor a single
blob — both of which would make the comparison vacuous.

That is stronger evidence than unit tests, because unit tests only check the cases I thought of.

**Q6. Two incidents merge. What happens to the IDs you already published?**
The survivor is the incident with the earlier `openedAt`, ties broken lexicographically on ID — so
the outcome is deterministic and replay-stable. I emit a `MERGED` event on the survivor carrying
`mergedFrom: [loserIds]`, and a terminal event on each loser carrying `supersededBy`. Downstream
consumers must treat incident identity as mergeable — the contract is documented, and it's the
same class of problem as stream-stream joins or CRDT merges.
*(Follow-up you should expect: "and what if the bridging zone then expires and it splits again?"
→ the keeper is the fragment that **inherited the most of the incident's members**, ties on total
size, then canonical order. Deliberately not raw size: a fragment can be large because unrelated
zones joined it in the same batch, and ranking on that hands the ID to the half that inherited
least. It's a judgement call optimised for on-call continuity — the person already looking at that
ID should keep seeing the biggest part of *their* problem — rather than set-theoretic purity.
ADR-003.)*

**The lifecycle has three statuses, not two, and the third one is forced.** Closing needs a grace
period below the minimum member count, but the invariant is that no OPEN incident is ever below
that minimum. Both cannot hold with only OPEN and CLOSED — during the grace period the incident is
below the minimum and not yet closed. `DRAINING` is that state; an incident that regrows during it
returns to OPEN. I found this because the property test asserting the invariant failed against my
own spec.

**Q6a. How are incident IDs generated, and how do you know they're unique?**
*(Ask yourself this one — it is where the best bug in the project lives.)*

`SHA-256("geopulse-incident-v1" | openedAt | sorted seed members)`, first 64 bits, `INC-` prefixed.
A hash rather than a UUID or a counter because it has to be **stable across replays** — same input
stream, same IDs, which is what makes the whole thing diffable and testable.

*Be precise about how far that goes, because it is a fair challenge.* `openedAt` is in the
preimage, and `openedAt` is whatever watermark the reconcile ran at — which, with `eachBatch`, is
set by where Kafka happened to draw the batch boundary. So output is byte-identical for a **fixed
batching**, and I assert that. Two live runs over the same topic can draw batches differently and
name the same incident differently. The clean fix is to reconcile on a fixed event-time grid
instead of per batch, so `openedAt` is always a tick multiple and the ID stops depending on
fetch behaviour at all. I know the limitation, it is in ADR-004, and I would take that fix before
relying on cross-run diffing.

My first uniqueness argument was: the preimage contains `openedAt`, components are disjoint at any
instant, and event time is a monotonic watermark — therefore no two incidents can share a preimage.

**That argument is wrong, and a property test found it.** Monotonic is not *strictly* increasing. A
zone that recovers and re-degrades inside the same millisecond closes an incident and opens an
identical one at an unchanged watermark — same members, same `openedAt`, same ID minted twice. At
`minZones: 1` that is a single pair of messages. fast-check shrank the failing case to 30 events.

The fix retains IDs retired at the current watermark instant and disambiguates against them,
pruning as soon as event time moves past. It holds one instant's closures, not a growing graveyard.
The remaining collision route is a genuine 64-bit SHA-256 birthday collision, which at realistic
incident volumes is negligible — and handled by the same disambiguation loop anyway.

Both the broken argument and the corrected one are in ADR-003, because the reasoning is the
interesting part, not the code.

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

**Q20. Tell me about a bug your tests couldn't have caught.** The first end-to-end run produced
seven incidents from one injected fault. Every test passed — 283 of them, including a differential
fuzz against a naive oracle with zero divergences and property tests over 156,773 invariant checks.
The engine was correct. The *answer* was wrong.

The adjacency graph was configured as H3 resolution 5 with a ring size of 1 — "same cell, or one of
its six neighbours", about 25 km on the ground. The fault had a 95 km radius and the zone field puts
neighbours roughly 15 km apart, so its 62 zones landed in 61 distinct cells and simply were not one
connected component. The engine computed the connected components of the graph it was given,
faithfully, and reported them. Its input had already been fragmented two layers away, by a constant.

What I did about it is the part I would want to be asked about. I did not nudge the ring size until
the number looked right — that is indistinguishable from tuning until you get the answer you wanted.
I wrote a benchmark that measures, for every injected anomaly in all four scenarios, how many
components its labelled zones form under three resolutions crossed with three ring sizes. Res 5
ring 1 gives 7 components for the regional fault; ring 2 gives 1. The same table also checks the
opposite failure: under ring 2 the multi-anomaly scenario's two faults stay 2 components and the 16
noise zones stay 16, so it is not merely a looser setting that smears everything together. That is
the measurement that distinguishes "correct" from "tuned", and it is committed alongside the change.

The generalisable lesson: geometry is a parameter, and a parameter is only defensible against
measured evidence. No amount of testing the code finds a wrong constant, because the code is doing
exactly what it was told. This is also the reason the end-to-end gate exists at all — it is the
only place in the build plan where a wrong parameter can surface.

**Q21. You use `eachBatch`. Why, and did it work?** The original argument was that a regional fault
arrives as a burst — 62 zones within seconds — and reconciling after every message would emit an
`OPENED` plus 61 `GREW`s, each obsoleted by the next, all published and persisted. Reconciling once
per batch emits one `OPENED` with 62 members. Not a throughput optimisation: the output is *better*,
because a lifecycle stream is read by a person and should describe the fault rather than the arrival
order of the messages that revealed it.

It did not work, and I know that because I instrumented the claim rather than assuming it. There is
a histogram, `degradation_batch_size`, whose comment said: if this sits at 1 during a storm, the
claim is false and the complexity is not being paid for. The live run measured 70 messages across 68
batches. Degradations are rare and the pipeline keeps up, so kafkajs hands them over as they arrive.
Per-batch reconciling had degenerated into per-message reconciling *precisely when the system was
healthy*, and consolidated only when it was lagging. It delivered none of the benefit it was chosen
for while carrying a real cost.

That cost was determinism. Incident ids are `SHA-256(scheme | openedAt | members)` and `openedAt`
was the reconcile watermark, so where the broker drew a fetch boundary decided what an incident was
*called*. Output was byte-identical only for a fixed batching, which is a property of the fetch and
not of the data.

The fix is to reconcile on a fixed event-time grid instead: every `RECONCILE_TICK_MS` of event time,
crossing as many boundaries as a batch spans. A boundary `B` is reconciled when the first message
with `eventTime > B` arrives, so that reconcile sees exactly the messages at or before `B`, whatever
the broker did. `openedAt` lands on a tick multiple and the whole output becomes a function of the
message stream alone — there is a test that runs the same twelve messages under four different
batchings and asserts byte-identical output including ids.

`eachBatch` stayed. The batch is still the right unit for resolving offsets and for dispatch; it was
never the right unit for deciding *what happened*. Conflating a transport boundary with a semantic
one was the actual mistake, and it is worth saying that the code was not wrong — the abstraction
boundary was in the wrong place.

**Q22. What does that grid cost you?** A component that forms and dissolves entirely inside one tick
is never observed. That was true before as well; it was just a broker artefact rather than a stated
interval, which is strictly worse because you cannot write it down. `RECONCILE_TICK_MS` is now an
explicit statement of the resolution at which the system is willing to describe change, and at 5 s
against a 120 s correlation window it is two orders of magnitude finer than the thing being measured.

It also fixed something I was not aiming at. Under the old cadence an incident whose grace period
expired at T was reported closed at whatever watermark the next unrelated message happened to carry.
On the grid it closes at the first boundary past T, because the gap is crossed one boundary at a
time. The close is now dated to when the incident ended rather than to who reported next.

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
