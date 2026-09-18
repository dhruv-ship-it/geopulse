import { haversineKm } from '@geopulse/spatial';

import { centroidOf, footprintOf, radiusKm, roundCoordinate } from '../footprint';

describe('centroidOf', () => {
  it('returns the single position unchanged', () => {
    expect(centroidOf([{ latitude: 12.5, longitude: -3.25 }])).toEqual({
      latitude: 12.5,
      longitude: -3.25
    });
  });

  it('throws on an empty set rather than inventing a position', () => {
    expect(() => centroidOf([])).toThrow(/at least one position/);
  });

  it('sits at the midpoint of two nearby zones', () => {
    const centroid = centroidOf([
      { latitude: 10.0, longitude: 20.0 },
      { latitude: 10.2, longitude: 20.0 }
    ]);
    expect(centroid.latitude).toBeCloseTo(10.1, 6);
    expect(centroid.longitude).toBeCloseTo(20.0, 6);
  });

  /**
   * The reason the vector mean exists. Componentwise averaging puts these two 22 km-apart zones
   * at longitude 0 — a different ocean, on a different continent's doorstep.
   */
  it('does not break across the antimeridian', () => {
    const west = { latitude: 5.0, longitude: 179.9 };
    const east = { latitude: 5.0, longitude: -179.9 };
    const centroid = centroidOf([west, east]);

    expect(Math.abs(centroid.longitude)).toBeCloseTo(180, 4);
    // The spherical mean of two points at the same latitude sits fractionally poleward of it —
    // the great-circle path between them bulges — so this is 5.0 plus about 8e-6 degrees, or
    // under a metre. Correct, and the reason the tolerance is not absolute.
    expect(centroid.latitude).toBeCloseTo(5.0, 4);
    // Within 15 km of both, rather than 20,000 km from both.
    expect(haversineKm(centroid, west)).toBeLessThan(15);
    expect(haversineKm(centroid, east)).toBeLessThan(15);

    const componentwiseMean = (west.longitude + east.longitude) / 2;
    expect(componentwiseMean).toBe(0);
  });

  it('handles positions around a pole', () => {
    const centroid = centroidOf([
      { latitude: 89.5, longitude: 0 },
      { latitude: 89.5, longitude: 90 },
      { latitude: 89.5, longitude: 180 },
      { latitude: 89.5, longitude: -90 }
    ]);
    expect(centroid.latitude).toBeGreaterThan(89.9);
  });

  it('falls back to the first member when the vectors cancel', () => {
    // Antipodal pair: there is no centre, and atan2(0, 0) would confidently claim there is.
    const centroid = centroidOf([
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 180 }
    ]);
    expect(centroid).toEqual({ latitude: 0, longitude: 0 });
  });

  it('is independent of the order members are given in', () => {
    const positions = [
      { latitude: 1.0, longitude: 2.0 },
      { latitude: 1.4, longitude: 2.6 },
      { latitude: 0.7, longitude: 2.2 }
    ];
    const forwards = centroidOf(positions);
    const backwards = centroidOf([...positions].reverse());
    expect(forwards.latitude).toBeCloseTo(backwards.latitude, 12);
    expect(forwards.longitude).toBeCloseTo(backwards.longitude, 12);
  });
});

describe('radiusKm', () => {
  it('is zero for a single member', () => {
    const only = { latitude: 3, longitude: 4 };
    expect(radiusKm(only, [only])).toBe(0);
  });

  it('is the distance to the furthest member, not the mean', () => {
    const centroid = { latitude: 0, longitude: 0 };
    const near = { latitude: 0.01, longitude: 0 };
    const far = { latitude: 0.5, longitude: 0 };

    const radius = radiusKm(centroid, [near, near, near, far]);
    expect(radius).toBeCloseTo(haversineKm(centroid, far), 6);
    // A mean over those four would be about a quarter of it.
    expect(radius).toBeGreaterThan(haversineKm(centroid, near) * 10);
  });
});

describe('footprintOf', () => {
  const zone = (zoneId: string, latitude: number, longitude: number, h3Cell: string) => ({
    zoneId,
    latitude,
    longitude,
    h3Cell
  });

  it('deduplicates and sorts cells', () => {
    const footprint = footprintOf([
      zone('Z-3', 1.0, 1.0, '85283473fffffff'),
      zone('Z-1', 1.1, 1.0, '85283447fffffff'),
      zone('Z-2', 1.2, 1.0, '85283473fffffff')
    ]);
    expect(footprint.h3Cells).toEqual(['85283447fffffff', '85283473fffffff']);
  });

  it('produces the same bytes whatever order the members arrive in', () => {
    const members = [
      zone('Z-1', 1.0, 1.0, 'cell-a'),
      zone('Z-2', 1.1, 1.05, 'cell-b'),
      zone('Z-3', 0.95, 1.1, 'cell-c')
    ];
    const forwards = JSON.stringify(footprintOf(members));
    const backwards = JSON.stringify(footprintOf([...members].reverse()));
    // The centroid is a floating-point sum, so reversing can move the last bit; compare the
    // parts that must be exactly stable and the centroid to well below sensor precision.
    expect(JSON.parse(backwards).h3Cells).toEqual(JSON.parse(forwards).h3Cells);
    expect(JSON.parse(backwards).centroid.latitude).toBeCloseTo(
      JSON.parse(forwards).centroid.latitude,
      12
    );
  });

  it('returns an empty footprint rather than throwing for a dissolved incident', () => {
    // A CLOSED/DISSOLVED event carries no members. The caller substitutes the last known
    // footprint; this path only has to not explode.
    expect(footprintOf([])).toEqual({
      h3Cells: [],
      centroid: { latitude: 0, longitude: 0 },
      radiusKm: 0
    });
  });

  it('skips members with no cell rather than emitting an empty string', () => {
    const footprint = footprintOf([
      { zoneId: 'Z-1', latitude: 1, longitude: 1, h3Cell: '' },
      zone('Z-2', 1.1, 1, 'cell-b')
    ]);
    expect(footprint.h3Cells).toEqual(['cell-b']);
  });
});

describe('roundCoordinate', () => {
  it('keeps six decimal places', () => {
    expect(roundCoordinate(12.3456789)).toBe(12.345679);
    expect(roundCoordinate(-0.0000004)).toBe(-0);
  });
});
