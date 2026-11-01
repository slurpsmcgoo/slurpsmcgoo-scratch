import { describe, expect, it } from 'vitest';
import { CFG } from '../src/config.ts';
import { dispersionRadius, flickOffset, meterOffset, offsetTarget } from '../src/throw/dispersion.ts';

const D = CFG.throw.dispersion;

describe('dispersion throwing', () => {
  it('a comfortable flick lands dead on; faster goes long, slower short, clamped to the circle', () => {
    expect(flickOffset({ forward: D.flickCenter, lateral: 0, pulledBack: true })).toEqual({ along: 0, side: 0 });
    expect(flickOffset({ forward: D.flickCenter + D.flickRange / 2, lateral: 0, pulledBack: true }).along).toBeCloseTo(0.5);
    expect(flickOffset({ forward: 99, lateral: 0, pulledBack: true }).along).toBe(1);
    expect(flickOffset({ forward: 0.01, lateral: 0, pulledBack: true }).along).toBe(-1);
    const corner = flickOffset({ forward: 99, lateral: 99, pulledBack: true });
    expect(Math.hypot(corner.along, corner.side)).toBeCloseTo(1);
  });

  it('drifting right sends the throw to the thrower\'s right, for both teams', () => {
    const o = { along: 0, side: 1 };
    // Team 0 at z = -4 facing +z: right is -x.
    expect(offsetTarget([0, 0.75, -3.75], [0, 0, 4], o, 0.5)[0]).toBeCloseTo(-0.5);
    // Team 1 at z = +4 facing -z: right is +x.
    expect(offsetTarget([0, 0.75, 3.75], [0, 0, -4], o, 0.5)[0]).toBeCloseTo(0.5);
    // Long is further away.
    expect(offsetTarget([0, 0.75, -3.75], [0, 0, 4], { along: 1, side: 0 }, 0.5)[2]).toBeCloseTo(4.5);
  });

  it('the circle grows with distance and drunkenness, and shrinks in the zone', () => {
    const r8 = dispersionRadius(8, 'baton');
    expect(dispersionRadius(4, 'baton')).toBeLessThan(r8);
    expect(dispersionRadius(8, 'kubb')).toBeGreaterThan(r8);
    expect(dispersionRadius(8, 'baton', { impairment: 1 })).toBeGreaterThan(r8 * 1.5);
    expect(dispersionRadius(8, 'baton', { flow: 1 })).toBeLessThan(r8);
  });

  it('a power-meter release at the middle is dead on', () => {
    expect(meterOffset(0.5, 0).along).toBeCloseTo(0);
    expect(meterOffset(1, 0).along).toBeCloseTo(1);
  });
});
