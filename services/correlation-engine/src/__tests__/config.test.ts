import { describeConfig, loadConfig } from '../config';

describe('loadConfig', () => {
  it('falls back to the documented defaults on an empty environment', () => {
    const config = loadConfig({});
    expect(config.kafkaBroker).toBe('localhost:9092');
    expect(config.degradationsTopic).toBe('zone.degradations');
    expect(config.incidentsTopic).toBe('zone.incidents');
    expect(config.correlationWindowMs).toBe(120000);
    expect(config.compactionIntervalMs).toBe(5000);
    expect(config.incidentMinZones).toBe(3);
    expect(config.incidentCloseGraceMs).toBe(60000);
    expect(config.metricsPort).toBe(9093);
  });

  it('pins the correlation geometry the core defaults to', () => {
    // The core reads these same variables so it can stand alone for its property tests; the
    // service always passes its own resolved values in. This asserts the two agree, because a
    // silent disagreement would mean the numbers in benchmarks/ describe a different engine
    // from the one running.
    const config = loadConfig({});
    const { CorrelationWindow, IncidentLifecycle } = require('../core');
    expect(new CorrelationWindow().geometry).toEqual({
      windowMs: config.correlationWindowMs,
      compactionIntervalMs: config.compactionIntervalMs
    });
    expect(new IncidentLifecycle().geometry).toEqual({
      minZones: config.incidentMinZones,
      closeGraceMs: config.incidentCloseGraceMs
    });
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig({
      KAFKA_BROKER: 'broker:19092',
      CORRELATION_WINDOW_MS: '300000',
      INCIDENT_MIN_ZONES: '5',
      CORRELATION_FROM_BEGINNING: 'false',
      METRICS_PORT: '9999'
    });
    expect(config.kafkaBroker).toBe('broker:19092');
    expect(config.correlationWindowMs).toBe(300000);
    expect(config.incidentMinZones).toBe(5);
    expect(config.fromBeginning).toBe(false);
    expect(config.metricsPort).toBe(9999);
  });

  it.each([['true', true], ['1', true], ['false', false], ['0', false]])(
    'reads %s as %s',
    (raw, expected) => {
      expect(loadConfig({ CORRELATION_FROM_BEGINNING: raw }).fromBeginning).toBe(expected);
    }
  );

  it('treats an empty string as unset rather than as zero', () => {
    expect(loadConfig({ INCIDENT_MIN_ZONES: '' }).incidentMinZones).toBe(3);
    expect(loadConfig({ CORRELATION_FROM_BEGINNING: '' }).fromBeginning).toBe(true);
  });

  it.each([
    ['INCIDENT_MIN_ZONES', 'three', /must be an integer/],
    ['CORRELATION_FROM_BEGINNING', 'yes', /must be true or false/],
    ['CORRELATION_WINDOW_MS', '0', /must be positive/],
    ['INCIDENT_MIN_ZONES', '0', /at least 1/],
    ['INCIDENT_CLOSE_GRACE_MS', '-1', /non-negative/],
    ['CORRELATION_MAX_BATCH_SIZE', '0', /at least 1/],
    ['ZONE_REFRESH_INTERVAL_MS', '-5', /non-negative/],
    ['CLOSED_INCIDENT_TTL_SECONDS', '-1', /non-negative/]
  ])('rejects %s=%s', (name, value, message) => {
    expect(() => loadConfig({ [name]: value })).toThrow(message);
  });

  it('rejects a compaction interval at or above the correlation window', () => {
    // A member can outlive its deadline by up to one compaction interval. At this setting the
    // slop is the same size as the window, and "correlation window" stops meaning anything.
    expect(() =>
      loadConfig({ CORRELATION_WINDOW_MS: '10000', COMPACTION_INTERVAL_MS: '10000' })
    ).toThrow(/must be below/);
  });

  it('allows a zero compaction interval — exact expiry, at the cost of a scan per batch', () => {
    expect(loadConfig({ COMPACTION_INTERVAL_MS: '0' }).compactionIntervalMs).toBe(0);
  });

  it('defaults the reconcile grid to the compaction interval', () => {
    expect(loadConfig({ COMPACTION_INTERVAL_MS: '2000' }).reconcileTickMs).toBe(2000);
  });

  it('keeps a usable reconcile grid when the compaction interval is zero', () => {
    // A zero compaction interval says "sweep exactly, on every batch". That is a statement about
    // expiry precision and not about how often to announce anything, and a grid of zero would not
    // be a cadence at all.
    const config = loadConfig({ COMPACTION_INTERVAL_MS: '0' });
    expect(config.compactionIntervalMs).toBe(0);
    expect(config.reconcileTickMs).toBe(5000);
  });

  it('lets the reconcile grid be set apart from the compaction interval', () => {
    const config = loadConfig({ COMPACTION_INTERVAL_MS: '1000', RECONCILE_TICK_MS: '30000' });
    expect(config.compactionIntervalMs).toBe(1000);
    expect(config.reconcileTickMs).toBe(30000);
  });

  it('rejects a reconcile grid at or above the correlation window', () => {
    // At that setting an incident can be born and expire without ever being described.
    expect(() =>
      loadConfig({ CORRELATION_WINDOW_MS: '30000', RECONCILE_TICK_MS: '30000' })
    ).toThrow(/must be below/);
  });

  it('rejects a non-positive reconcile grid', () => {
    expect(() => loadConfig({ RECONCILE_TICK_MS: '0' })).toThrow(/must be positive/);
  });
});

describe('describeConfig', () => {
  it('renders the geometry a benchmark has to record alongside its numbers', () => {
    expect(describeConfig(loadConfig({}))).toBe(
      'window=120000ms compaction=5000ms reconcileTick=5000ms minZones=3 ' +
        'closeGrace=60000ms maxBatch=1000'
    );
  });
});
