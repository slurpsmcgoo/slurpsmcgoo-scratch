import { describe, expect, it } from 'vitest';
import { applyHomography, computeHomography, invert3, UNIT_SQUARE } from '../src/render/homography.ts';
import type { Pt } from '../src/config.ts';

describe('corner-pin homography', () => {
  it('is the identity for an unwarped screen', () => {
    const h = computeHomography(UNIT_SQUARE, UNIT_SQUARE);
    for (const p of [[0.2, 0.7], [0.5, 0.5], [1, 0]] as Pt[]) {
      const [x, y] = applyHomography(h, p);
      expect(x).toBeCloseTo(p[0], 9);
      expect(y).toBeCloseTo(p[1], 9);
    }
  });

  it('maps the unit square exactly onto dragged corners, and back', () => {
    const corners: Pt[] = [[0.08, 0.04], [0.93, 0.1], [0.88, 0.97], [0.12, 0.9]];
    const h = computeHomography(UNIT_SQUARE, corners);
    const inv = invert3(h);
    UNIT_SQUARE.forEach((p, i) => {
      const [x, y] = applyHomography(h, p);
      expect(x).toBeCloseTo(corners[i]![0], 9);
      expect(y).toBeCloseTo(corners[i]![1], 9);
    });
    const [u, v] = applyHomography(inv, applyHomography(h, [0.3, 0.6]));
    expect(u).toBeCloseTo(0.3, 9);
    expect(v).toBeCloseTo(0.6, 9);
  });

  it('keeps straight lines straight (a true perspective map, not a bilinear one)', () => {
    const h = computeHomography(UNIT_SQUARE, [[0.1, 0.1], [0.9, 0.2], [0.8, 0.8], [0.2, 0.9]]);
    const a = applyHomography(h, [0, 0.5]);
    const b = applyHomography(h, [0.5, 0.5]);
    const c = applyHomography(h, [1, 0.5]);
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    expect(Math.abs(cross)).toBeLessThan(1e-12);
  });

  it('rejects a degenerate quad', () => {
    expect(() => computeHomography(UNIT_SQUARE, [[0, 0], [0, 0], [0, 0], [0, 0]])).toThrow();
  });
});
