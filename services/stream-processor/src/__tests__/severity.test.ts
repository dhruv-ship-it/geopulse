import { severityOf } from '../severity';

describe('severityOf', () => {
  it('takes the worse of the two windows the state machine consults', () => {
    // A zone in the steep part of an incident: avg1m has run away, avg5m is still catching up.
    // Reporting 0.78 here would describe the past.
    expect(severityOf(0.95, 0.78)).toBe(0.95);
    // And the other way round, on the way back down.
    expect(severityOf(0.60, 0.82)).toBe(0.82);
  });

  it('is not a mean, which would describe neither window', () => {
    expect(severityOf(0.95, 0.78)).not.toBeCloseTo(0.865);
  });

  it('lands on the same scale as the injected severity, so the eval can compare them', () => {
    // The simulator's anomaly severity maps straight onto load (loadGenerator.applyAnomalies),
    // and a zone sitting at a steady 0.97 core averages to 0.97 in both windows.
    expect(severityOf(0.97, 0.97)).toBe(0.97);
  });

  it('clamps above 1, so a bad sensor reading cannot become a 700% incident severity', () => {
    expect(severityOf(7, 0.5)).toBe(1);
  });

  it('clamps below 0', () => {
    expect(severityOf(-3, -0.2)).toBe(0);
  });

  it('reports 0 rather than NaN, which JSON.stringify would turn into null on the wire', () => {
    expect(severityOf(NaN, NaN)).toBe(0);
    expect(severityOf(Infinity, 0.5)).toBe(0);
  });

  it('is 0 for a zone with empty windows', () => {
    // TimeWindowManager.calculateAverage returns 0 for an empty window.
    expect(severityOf(0, 0)).toBe(0);
  });
});
