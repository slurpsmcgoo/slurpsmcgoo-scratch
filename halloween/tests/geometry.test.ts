import { describe, expect, it } from 'vitest';
import {
  distanceFromFootY,
  distanceFromShoulders,
  estimateDistance,
  fitTilt,
  rowForPoint,
  toVisitorX,
  widthAtDistance,
  zoneFor,
} from '../src/perception/geometry.ts';
import type { Landmark } from '../src/types.ts';
import { loadConfig } from './helpers.ts';

const cfg = loadConfig();
const g = cfg.geometry;
const tilt = fitTilt(g);

describe('geometry', () => {
  it('flips camera x into visitor view unless the feed is already mirrored', () => {
    expect(toVisitorX(0.2, false)).toBeCloseTo(0.8);
    expect(toVisitorX(0.2, true)).toBeCloseTo(0.2);
  });

  it('fits a tilt that reproduces the calibration marks', () => {
    for (const m of g.calibrationMarks) {
      expect(distanceFromFootY(m.footY, g, tilt)!).toBeCloseTo(m.distanceM, 1);
    }
  });

  it('distance from feet inverts the ground projection', () => {
    for (const d of [1.5, 2, 3, 5, 8]) {
      const y = rowForPoint(d, 0, g, tilt);
      expect(distanceFromFootY(y, g, tilt)!).toBeCloseTo(d, 6);
    }
  });

  it('gives no distance for feet at or above the horizon', () => {
    expect(distanceFromFootY(0.05, g, tilt)).toBeNull();
  });

  it('a child and an adult on the same spot get the same distance', () => {
    const feetAt = (d: number, heightM: number): Landmark[] => {
      const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
      lm[0] = { x: 0.5, y: rowForPoint(d, heightM * 0.93, g, tilt), visibility: 0.9 };
      for (const i of [27, 28, 29, 30]) lm[i] = { x: 0.5, y: rowForPoint(d, 0.03, g, tilt), visibility: 0.9 };
      return lm;
    };
    const child = estimateDistance(feetAt(3, 1.1), g, tilt)!;
    const adult = estimateDistance(feetAt(3, 1.85), g, tilt)!;
    expect(child.method).toBe('feet');
    expect(child.distanceM).toBeCloseTo(adult.distanceM, 6);
  });

  it('falls back to shoulder width when feet are hidden', () => {
    const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
    for (const i of [27, 28, 29, 30]) lm[i] = { x: 0.5, y: 1.2, visibility: 0.1 };
    const w = widthAtDistance(g.shoulderWidthM, 2.5, g);
    lm[11] = { x: 0.5 - w / 2, y: 0.3, visibility: 0.9 };
    lm[12] = { x: 0.5 + w / 2, y: 0.3, visibility: 0.9 };
    const est = estimateDistance(lm, g, tilt)!;
    expect(est.method).toBe('shoulders');
    expect(est.distanceM).toBeCloseTo(2.5, 6);
    expect(distanceFromShoulders(0, g)).toBeNull();
  });

  it('assigns zones with hysteresis at the boundaries', () => {
    const z = { nearM: 2, midM: 4.5, hysteresisM: 0.2 };
    expect(zoneFor(1.5, z)).toBe('near');
    expect(zoneFor(3, z)).toBe('mid');
    expect(zoneFor(6, z)).toBe('far');
    // Standing just past a boundary keeps the old zone.
    expect(zoneFor(2.1, z, 'near')).toBe('near');
    expect(zoneFor(2.3, z, 'near')).toBe('mid');
    expect(zoneFor(1.9, z, 'mid')).toBe('mid');
    expect(zoneFor(1.7, z, 'mid')).toBe('near');
    expect(zoneFor(4.6, z, 'mid')).toBe('mid');
    expect(zoneFor(4.4, z, 'far')).toBe('far');
    expect(zoneFor(4.2, z, 'far')).toBe('mid');
  });
});
