import { cellToParent, getResolution } from 'h3-js';
import { H3_COARSE_RESOLUTION, H3_RESOLUTION, cellsFor } from '../cells';

// Moved here with the module itself, from stream-processor's redisWriter test. The cells and
// the neighbour graph built over them are one definition of geometry and are tested together.
describe('spatial cells', () => {
  it('produces cells at the configured detection and partition resolutions', () => {
    const cells = cellsFor(28.6139, 77.209);
    expect(getResolution(cells.h3Cell)).toBe(H3_RESOLUTION);
    expect(getResolution(cells.h3CoarseCell)).toBe(H3_COARSE_RESOLUTION);
  });

  it('nests the fine cell inside the coarse cell, which is what makes the coarse cell a valid partition key', () => {
    const cells = cellsFor(-33.8688, 151.2093);
    expect(cellToParent(cells.h3Cell, H3_COARSE_RESOLUTION)).toBe(cells.h3CoarseCell);
  });

  it('is deterministic for the same coordinate', () => {
    expect(cellsFor(51.5074, -0.1278)).toEqual(cellsFor(51.5074, -0.1278));
  });

  it('places nearby coordinates in the same coarse cell and distant ones in different cells', () => {
    const delhi = cellsFor(28.6139, 77.209);
    const nearDelhi = cellsFor(28.62, 77.215);
    const sydney = cellsFor(-33.8688, 151.2093);

    expect(nearDelhi.h3CoarseCell).toBe(delhi.h3CoarseCell);
    expect(sydney.h3CoarseCell).not.toBe(delhi.h3CoarseCell);
  });

  it('accepts an explicit resolution, which is how the neighbour graph pins its own geometry', () => {
    const cells = cellsFor(28.6139, 77.209, 7, 4);
    expect(getResolution(cells.h3Cell)).toBe(7);
    expect(getResolution(cells.h3CoarseCell)).toBe(4);
  });
});
