/**
 * How degraded a zone is, as one number in [0, 1].
 *
 * `ZoneState` is three values, and three values are not enough for the correlation engine to
 * roll up. An incident spanning sixty zones needs to say how bad it is, and "sixty of them are
 * STRESSED" cannot distinguish a region hovering at the threshold from one that is two ticks
 * from CRITICAL everywhere. So the degradation message carries the continuous quantity
 * alongside the discrete one.
 *
 * ## Why `max`, and why of these two numbers
 *
 * The load signal this pipeline carries is already a normalised utilisation in [0, 1] — the
 * simulator's injected severity maps straight onto it (`loadGenerator.applyAnomalies`), which
 * is what makes the injected quantity and the measured quantity the same quantity and lets the
 * eval compare them without a conversion nobody can remember. The windowed averages are
 * averages of that signal, so they are already on the right scale and no normalisation is
 * needed or wanted.
 *
 * The state machine looks at `avg5m` for STRESSED and `avg1m` for CRITICAL. Severity is the max
 * of the two because taking either alone would understate a real fault at the moment it matters
 * most: a zone whose one-minute average has run up to 0.95 while its five-minute average is
 * still dragging at 0.78 is in the steep part of an incident, and reporting 0.78 would describe
 * the past. A mean of the two would report 0.865, which is a number describing nothing —
 * neither window's answer, and not an average over any interval. The max is the worst thing
 * either window the detector actually consults has to say, which is what a severity is for.
 *
 * ## It is clamped, and that is not paranoia
 *
 * `avg1m` and `avg5m` are averages over whatever loads arrived. Nothing in the *stream
 * processor* guarantees a sensor reported in [0, 1] — that is a property of this simulator, not
 * of the schema — and a single malformed reading of 7.0 would otherwise propagate into an
 * incident's `peakSeverity` and out to a UI as a severity of 700%. Clamping here means the
 * contract the wire type declares (`0..1 normalised`) is one this service actually enforces
 * rather than one it merely hopes for.
 */
export function severityOf(avg1m: number, avg5m: number): number {
  const worst = Math.max(avg1m, avg5m);
  if (!Number.isFinite(worst)) {
    // `calculateAverage` already returns 0 for an empty window, so this is not reachable from
    // the pipeline today. It is here because the alternative to a guard is emitting `NaN` on
    // the wire, and `JSON.stringify(NaN)` is `null` — a silent type change in a field the
    // correlation engine takes maxima over.
    return 0;
  }
  return Math.min(1, Math.max(0, worst));
}
