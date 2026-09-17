import { ZoneGenerator } from '../zoneGenerator';
import { LoadGenerator } from '../loadGenerator';
import { ZoneConfig } from '../types';

/**
 * The simulator being deterministic is not a nicety — it is what makes a replay reproducible
 * and what makes every benchmark and eval number taken against it re-derivable. These tests
 * exist to make a regression to Math.random() or a wall-clock read fail loudly.
 */

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

describe('ZoneGenerator', () => {
  it('produces the same zones for the same count, every time', () => {
    expect(ZoneGenerator.generateZones(50)).toEqual(ZoneGenerator.generateZones(50));
  });

  it('keeps every zone inside valid coordinate bounds', () => {
    for (const zone of ZoneGenerator.generateZones(500)) {
      expect(zone.latitude).toBeGreaterThanOrEqual(-85);
      expect(zone.latitude).toBeLessThanOrEqual(85);
      expect(zone.longitude).toBeGreaterThanOrEqual(-180);
      expect(zone.longitude).toBeLessThanOrEqual(180);
      expect(zone.baseLoad).toBeGreaterThanOrEqual(0.05);
      expect(zone.baseLoad).toBeLessThanOrEqual(0.95);
    }
  });

  it('spreads zones over both hemispheres rather than clustering', () => {
    const zones = ZoneGenerator.generateZones(200);
    const north = zones.filter((z) => z.latitude > 0).length;
    expect(north).toBeGreaterThan(50);
    expect(north).toBeLessThan(150);
  });

  it('assigns unique zone ids', () => {
    const zones = ZoneGenerator.generateZones(1000);
    expect(new Set(zones.map((z) => z.zoneId)).size).toBe(1000);
  });
});

describe('LoadGenerator', () => {
  const zone: ZoneConfig = {
    zoneId: 'Z-7',
    latitude: 12.34,
    longitude: 56.78,
    baseLoad: 0.4
  };

  beforeEach(() => LoadGenerator.reset());

  it('produces an identical load sequence for an identical input sequence', () => {
    const run = () => {
      LoadGenerator.reset();
      return [0, 1000, 2000, 3000].map(
        (offset) => LoadGenerator.generateEvent(zone, 'normal', T0 + offset).load
      );
    };

    expect(run()).toEqual(run());
  });

  it('derives load from event time only, not from wall clock', () => {
    LoadGenerator.reset();
    const first = LoadGenerator.generateEvent(zone, 'normal', T0).load;
    LoadGenerator.reset();
    const second = LoadGenerator.generateEvent(zone, 'normal', T0).load;
    expect(second).toBe(first);
  });

  it('uses UTC for the time-of-day pattern, so load does not depend on the host timezone', () => {
    // 02:00 UTC is a night-time hour; 12:00 UTC is a business hour. If the pattern were read
    // in local time these would coincide for some timezones and not others. Asserting they
    // differ in the direction UTC dictates pins the behaviour to UTC.
    const night = Date.UTC(2026, 0, 15, 2, 0, 0);
    const midday = Date.UTC(2026, 0, 15, 12, 0, 0);

    LoadGenerator.reset();
    const nightLoad = LoadGenerator.generateEvent(zone, 'normal', night).load;
    LoadGenerator.reset();
    const middayLoad = LoadGenerator.generateEvent(zone, 'normal', midday).load;

    expect(nightLoad).toBeLessThan(middayLoad);
  });

  it('keeps load within [0, 1] across all scenarios', () => {
    for (const scenario of ['normal', 'spike', 'drop'] as const) {
      LoadGenerator.reset();
      for (let i = 0; i < 200; i++) {
        const { load } = LoadGenerator.generateEvent(zone, scenario, T0 + i * 1000);
        expect(load).toBeGreaterThanOrEqual(0);
        expect(load).toBeLessThanOrEqual(1);
      }
    }
  });

  it('raises load under spike and lowers it under drop, relative to normal', () => {
    LoadGenerator.reset();
    const normal = LoadGenerator.generateEvent(zone, 'normal', T0).load;
    LoadGenerator.reset();
    const spike = LoadGenerator.generateEvent(zone, 'spike', T0).load;
    LoadGenerator.reset();
    const drop = LoadGenerator.generateEvent(zone, 'drop', T0).load;

    expect(spike).toBeGreaterThan(normal);
    expect(drop).toBeLessThan(normal);
  });

  it('never emits an event timestamp ahead of the produced time', () => {
    LoadGenerator.reset();
    for (let i = 0; i < 50; i++) {
      const producedAt = T0 + i * 1000;
      const event = LoadGenerator.generateEvent(zone, 'normal', producedAt);
      expect(event.eventTimestamp).toBeLessThanOrEqual(producedAt);
    }
  });
});
