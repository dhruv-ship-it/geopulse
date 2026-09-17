import { Prng } from '../prng';
import { haversineKm, destinationPoint, normaliseLongitude, EARTH_RADIUS_KM } from '../geo';

describe('Prng', () => {
  it('reproduces an identical sequence for an identical seed', () => {
    const draw = () => {
      const prng = new Prng(42);
      return Array.from({ length: 200 }, () => prng.nextUint32());
    };
    expect(draw()).toEqual(draw());
  });

  it('produces a different sequence for a different seed', () => {
    const a = new Prng(42);
    const b = new Prng(43);
    const left = Array.from({ length: 50 }, () => a.nextUint32());
    const right = Array.from({ length: 50 }, () => b.nextUint32());
    expect(left).not.toEqual(right);
  });

  it('gives each named stream its own sequence, so adding a draw to one cannot shift another', () => {
    // This is the property that keeps "same seed, same run" true across edits to the scenario
    // builders. Without sub-streams, inserting one extra draw into the regional builder would
    // silently re-roll every zone the noise builder picks.
    const zones = Prng.forStream(7, 'zone-layout');
    const noise = Prng.forStream(7, 'noise');
    expect(zones.nextUint32()).not.toBe(noise.nextUint32());

    const again = Prng.forStream(7, 'noise');
    expect(again.nextUint32()).toBe(Prng.forStream(7, 'noise').nextUint32());
  });

  it('stays inside its stated ranges', () => {
    const prng = new Prng(1234);
    for (let i = 0; i < 5000; i++) {
      const f = prng.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);

      const n = prng.nextIntInclusive(3, 9);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(9);
    }
  });

  it('shuffles without mutating the caller array, and deterministically', () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const a = Prng.forStream(9, 'x').shuffled(input);
    const b = Prng.forStream(9, 'x').shuffled(input);

    expect(a).toEqual(b);
    expect(input).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect([...a].sort((l, r) => l - r)).toEqual(input);
  });

  it('rejects a non-integer seed rather than silently truncating it', () => {
    expect(() => new Prng(1.5)).toThrow(/seed/);
  });
});

describe('geo', () => {
  it('measures a known distance to within a fraction of a percent', () => {
    // Berlin -> Hamburg, ~255 km by great circle.
    const km = haversineKm(
      { latitude: 52.52, longitude: 13.405 },
      { latitude: 53.55, longitude: 9.993 }
    );
    expect(km).toBeGreaterThan(250);
    expect(km).toBeLessThan(260);
  });

  it('is symmetric and zero on itself', () => {
    const a = { latitude: 12.3, longitude: -45.6 };
    const b = { latitude: -7.8, longitude: 170.1 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
    expect(haversineKm(a, a)).toBe(0);
  });

  it('places a destination at exactly the requested distance, on every bearing', () => {
    const origin = { latitude: 52.31, longitude: 13.04 };
    for (const bearing of [0, 41, 90, 180, 270, 359]) {
      const moved = destinationPoint(origin, bearing, 120);
      expect(haversineKm(origin, moved)).toBeCloseTo(120, 6);
    }
  });

  it('moves north for bearing 0 and east for bearing 90', () => {
    const origin = { latitude: 0, longitude: 0 };
    expect(destinationPoint(origin, 0, 100).latitude).toBeGreaterThan(0);
    expect(destinationPoint(origin, 90, 100).longitude).toBeGreaterThan(0);
  });

  it('keeps longitude in range when a front crosses the antimeridian', () => {
    const moved = destinationPoint({ latitude: 0, longitude: 179.5 }, 90, 200);
    expect(moved.longitude).toBeGreaterThanOrEqual(-180);
    expect(moved.longitude).toBeLessThan(180);
    expect(moved.longitude).toBeLessThan(0); // wrapped past +180
    expect(normaliseLongitude(540)).toBeCloseTo(-180, 9);
  });

  it('travels a quarter of the circumference to reach the pole from the equator', () => {
    const quarter = (Math.PI / 2) * EARTH_RADIUS_KM;
    const pole = destinationPoint({ latitude: 0, longitude: 0 }, 0, quarter);
    expect(pole.latitude).toBeCloseTo(90, 6);
  });
});
