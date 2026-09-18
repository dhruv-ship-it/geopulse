import * as core from '../index';

/**
 * The core's public surface is what WP3's service layer and WP6b's eval harness compile against.
 * Pinning it makes a dropped or accidentally-widened export a failure here rather than a broken
 * build somewhere else, the same way `@geopulse/spatial` pins its own.
 */
describe('correlation core public API', () => {
  it('exports the window, both connectivity implementations, the lifecycle, and the contract', () => {
    expect(Object.keys(core).sort()).toEqual(
      [
        'CorrelationWindow',
        'IncidentLifecycle',
        'NaiveConnectivity',
        'TimeAwareConnectivity',
        'canonicalise',
        'describePartition'
      ].sort()
    );
  });

  it('correlates through the entry point alone', () => {
    // Z-1 and Z-2 are adjacent; Z-3 is on its own. All three degrade, then Z-1 expires.
    const window = new core.CorrelationWindow({ windowMs: 60000, compactionIntervalMs: 0 });
    const connectivity = new core.TimeAwareConnectivity({
      neighboursOf: (zoneId) =>
        zoneId === 'Z-1' ? ['Z-2'] : zoneId === 'Z-2' ? ['Z-1'] : []
    });

    const t0 = 1768478400000;
    for (const zoneId of ['Z-1', 'Z-2', 'Z-3']) {
      window.admit(zoneId, t0);
      connectivity.activate(zoneId);
    }
    expect(core.describePartition(connectivity.components())).toBe('Z-1+Z-2 | Z-3');

    window.admit('Z-2', t0 + 30000); // Z-2 keeps degrading, Z-1 does not
    connectivity.activate('Z-2');
    connectivity.compact(window.sweep(t0 + 60000));

    expect(core.describePartition(connectivity.components())).toBe('Z-2');
  });
});
