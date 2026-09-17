# ADR-006 — Ground truth by construction: one severity function, two thresholds

**Status.** Accepted (WP6a, session S2b).
**Context.** `docs/03-MEASUREMENT.md` §2, `docs/02-PHASE-1-CORRELATION.md` WP6a.
**Supersedes / relates to.** Builds on ADR-005 (simulated event time). Everything below is
expressed in virtual event time; there is no wall-clock read in any generation path.

---

## Context

Phase 1 claims the correlation engine collapses a storm of zone alerts into a small number of
geographically coherent incidents. That claim is only worth making if it can be scored, and
scoring needs labels: for each injected fault, which zones it affected and from when.

We are in the unusual and genuinely advantageous position of writing the fault injector
ourselves, so the labels can be exact rather than guessed. The decision is *how* to produce them
without quietly measuring something other than the detector.

---

## Decision

**1. One severity function, called by both the generator and the label deriver.**

`anomaly.severityAt(spec, zone, t)` returns a dimensionless severity in `[0, 1]`. The event
generator turns it into load; the ground-truth deriver walks the same tick grid, at the same
instants the events are stamped with, and calls the same function to decide membership and
onset. The labels and the stream are not two implementations of one idea — they are one
implementation, read twice.

**2. Severity maps directly onto load, combined across anomalies with `max`, not `+`.**

A zone under severity 0.97 reports a load of 0.97. Keeping the injected and the observed
quantity the same thing means the labelling thresholds can be compared against the state
machine's thresholds without a conversion nobody will remember in three weeks.

`max` rather than a sum for two reasons. A sum would let two anomalies that merely overlap
produce a *more* severe zone than either alone, which reads downstream as evidence of one larger
event — handing the engine the over-grouping conclusion in its input rather than testing it.
And combining with `max` keeps each anomaly's contribution attributable, which is what makes
per-anomaly membership labels possible at all.

Likewise the anomaly is combined with the zone's baseline by `max`, not by addition: a fault
does not make a busy zone busier, it takes the zone over. Adding would make a zone's degradation
depend on how loaded it already was, smuggling a second spatial pattern into a measurement whose
whole purpose is to isolate the injected one.

**3. A floored radial profile, accepting a hard edge at the rim.**

Severity is `plateau(distance) × envelope(time)`, where the plateau is `peak` inside the core
(85% of the radius), falls linearly towards the rim, and is then **floored at
`MIN_AFFECTED_SEVERITY`**. Outside the radius it is exactly zero.

The floor is the one place the injector is deliberately less realistic than nature, and it fixes
a real problem. A gradient falling smoothly to zero necessarily passes through the band where a
zone's load hovers around the degradation threshold. Zones in that band degrade on some ticks
and not others; whichever way they are labelled they are wrong about half the time. Measured on
a 400-zone field before the floor was added, that annulus held 2–3 of roughly 50 zones per
anomaly — a ~5% ceiling on membership precision belonging to the fault injector, not to the
detector, and unrecoverable by any amount of tuning.

The cost is that an anomaly has a hard boundary where a real regional fault has a fuzzy one.
That is the right trade: the fuzzy edge buys realism the correlation engine cannot benefit from
and sells label precision the whole measurement depends on. The interior gradient (0.97 at the
core down to 0.85 at the rim) is kept, so the severity field still has structure.

**4. Two thresholds, because membership and onset are different questions.**

| Constant | Value | Question it answers |
|---|---|---|
| `MIN_AFFECTED_SEVERITY` | 0.85 | Did this anomaly take this zone over? (membership) |
| `ONSET_SEVERITY` | `0.75 / 1.05` ≈ 0.714 | From when was it showing? (onset) |

Using one threshold for both was the original design and it was wrong in a way that mattered.
Severity climbs through a 120-second ramp, so a zone's load crosses the degradation threshold
about twelve seconds before severity reaches 0.85. Time-to-detect is measured from the labelled
onset, so labelling the later instant would have reported every TTD twelve seconds faster than
it was — a bias in the flattering direction, in the metric with the least room for generosity.

`ONSET_SEVERITY` is pinned to the earliest instant the zone's load *could* have crossed
`DEGRADING_LOAD`, given the sensor's bounded ±5% jitter. Any residual error is therefore
conservative: the label can be a tick or two early, never late.

**5. The deriver refuses to emit an ambiguous label.**

If any zone's peak severity lands between the two thresholds, `deriveGroundTruth` throws. The
floor in (3) is designed so this cannot happen, so reaching it means a scenario parameter has
moved somewhere it should not have. Better a failed run than a silently degraded precision
ceiling on every number taken afterwards.

**6. A deterministic run id, deviating from the doc's illustrative form.**

`docs/03-MEASUREMENT.md` §2 shows `2026-09-20T14:02:11Z-seed42`. We emit
`20260115T120000Z-regional-anomaly-seed42` instead: the *simulated* start epoch, the scenario,
and the seed.

A wall-clock stamp is embedded in every record, so it would make every record differ between two
runs of the same configuration — destroying the exact property the determinism rule exists to
protect. `:` is also not a legal Windows filename character. Same configuration now means same
id means same file, which is correct, because same configuration also means the same ground
truth. `RUN_ID` overrides it when several runs of one configuration need keeping side by side.

**7. Labels are written before the first event, plus a sidecar manifest.**

If the broker is down or a run is killed half way, what is on disk still describes what was
supposed to happen. The manifest (`<run-id>.meta.json`) carries the run configuration — zone
count, simulated hours, seed — which the scorer needs for the metrics that are rates rather than
set comparisons. False-incident rate is per simulated hour and is not derivable from the
anomalies alone. It is deliberately *not* in the JSONL, which stays exactly the §2 schema.

---

## Alternatives rejected

**Observe the labels from the emitted stream instead of deriving them.** Run the simulator,
watch which zones degrade, write that down. Rejected: it makes the labels a function of the
consumer's thresholds and windowing, so tuning the state machine would silently move the ground
truth, and a bug in the observation path would be indistinguishable from a bug in the detector.
The current design reads the same function twice; this one would introduce a second
implementation for the first to drift from.

**Hand-authored scenario fixtures.** A checked-in JSON file listing which zones are in which
anomaly. Rejected: it cannot follow a change in zone count, layout or seed, so it would be stale
within a session, and staleness in a label file is invisible until a result is wrong.

**A step-function anomaly (severity `peak` inside the radius, 0 outside).** Rejected but close.
It removes the boundary ambiguity just as well, but it also removes the interior gradient, and
the gradient is what makes per-zone onset times vary meaningfully as a front sweeps — which is
the entire signal WP4's propagation-vector estimation has to work from. The floored profile
keeps the gradient and removes the ambiguity.

**A WGS84 ellipsoidal geodesy library.** Rejected: the ~0.3% difference from a spherical model
is far below anything the correlation window or H3 cell size is sensitive to, and a sphere is
exactly reproducible in forty lines rather than depending on a library's version — which, for a
simulator whose determinism is load-bearing, is the property that matters.

**Labelling the affected set as "every zone within `radiusKm`".** Rejected because it says
nothing about *time*, and without a per-zone onset there is no time-to-detect and no propagation
vector to estimate. `radiusKm` stays on the record as the geometric parameter; `affectedZones`
is the claim.

---

## Costs accepted

- **An anomaly has a hard spatial edge.** Justified in (3). The realism lost is not realism the
  detector could exploit.
- **`DEGRADING_LOAD = 0.75` duplicates `stateMachine.THRESHOLD_STRESSED`.** The simulator and
  the stream processor are separate services and neither should import the other, so the number
  exists twice. It is commented in both places and asserted in the simulator's tests against the
  emitted stream. If the state machine's threshold moves and this does not, the ground-truth
  tests fail rather than the results quietly skewing.
- **The eval scenarios need a dense zone field, which the original layout does not provide.**
  See D9 and `benchmarks/results/d9-zone-spacing.txt`; `regional-grid` was added for this and is
  the default for anomaly scenarios only.
- **Deriving labels walks the tick grid per candidate zone.** A generous spatial prefilter keeps
  it to milliseconds at 400 zones over four simulated hours. The prefilter is allowed to be
  over-inclusive and never under-inclusive: a false positive costs wasted ticks, a false
  negative silently drops a zone from the labels.

---

## What this buys in an interview

The claim to make is not "my system scores 0.94". It is:

> *I built the fault injector and the scorer before I built the detector, so I could never fool
> myself about whether it worked. The labels and the event stream come from the same function,
> so they cannot disagree. And when I checked the labels against the stream I found I was
> recording onsets twelve seconds late, which would have made every time-to-detect number look
> better than it was — that is why there are two thresholds rather than one.*

The second half of that is the part worth having. A clean result nobody struggled for
demonstrates far less than a specific bias found, explained and fixed.
