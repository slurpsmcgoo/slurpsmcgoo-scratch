import { describe, expect, it } from 'vitest';
import { DEG } from '../src/config.ts';
import { FlickTracker, flickBend, flickSpeed } from '../src/throw/flick.ts';
import { arcPoints, landingPoint, makeIntent, quantize, solveSpeed } from '../src/throw/model.ts';
import type { Vec3 } from '../src/types.ts';

describe('throw model', () => {
  it('rounds every number to the quantum', () => {
    const it = makeIntent({ kind: 'baton', from: [0.123456, 0.75, -3.7512345], dir: [0.1, 1], loft: 0.6, speed: 8.7654321 });
    for (const n of [...it.p, ...it.q, ...it.v, ...it.w]) expect(n).toBe(quantize(n));
    expect(JSON.stringify(it)).not.toMatch(/\d{6,}/);
  });

  it('spins end over end, carrying the top forward', () => {
    const it = makeIntent({ kind: 'baton', from: [0, 0.75, -4], dir: [0, 1], loft: 0.5, speed: 8 });
    expect(it.w[0]).toBeGreaterThan(0); // about +x when throwing towards +z
    expect(it.w[1]).toBe(0);
    expect(Math.abs(it.w[2])).toBe(0);
  });

  it('with drag, solveSpeed still lands on the target', () => {
    const m = { g: 3.6, drag: 0.09 };
    const from: Vec3 = [0, 0.75, -3.75];
    const loft = 35 * DEG;
    const speed = solveSpeed(from, [0.5, 0, 4], loft, m)!;
    const d = Math.hypot(0.5, 7.75);
    const land = landingPoint(from, [(0.5 / d) * Math.cos(loft) * speed, Math.sin(loft) * speed, (7.75 / d) * Math.cos(loft) * speed], m);
    expect(land[0]).toBeCloseTo(0.5, 1);
    expect(land[2]).toBeCloseTo(4, 1);
    expect(speed).toBeGreaterThan(solveSpeed(from, [0.5, 0, 4], loft, { g: 3.6, drag: 0 })!);
  });

  it('spin scales the end-over-end rotation', () => {
    const base = { kind: 'baton' as const, from: [0, 0.75, -4] as Vec3, dir: [0, 1] as [number, number], loft: 0.5, speed: 8 };
    const w1 = makeIntent(base).w[0];
    expect(makeIntent({ ...base, spin: 2 }).w[0]).toBeCloseTo(w1 * 2, 3);
    expect(makeIntent({ ...base, spin: 0.5 }).w[0]).toBeCloseTo(w1 / 2, 3);
  });

  it('pull-back depth is measured for spin', () => {
    const f = new FlickTracker(1000);
    f.begin(0, 500, 0);
    f.move(0, 660, 100);
    f.move(0, 300, 200);
    expect(f.maxPull(0.32)).toBeCloseTo(0.5);
  });

  it.each([9.81, 1.62])('solveSpeed lands on the target (g = %s)', (g) => {
    const from: Vec3 = [0, 0.75, -3.75];
    const target: Vec3 = [1, 0, 3];
    const loft = 35 * DEG;
    const m = { g, drag: 0 };
    const speed = solveSpeed(from, target, loft, m)!;
    const d = Math.hypot(1, 6.75);
    const v: Vec3 = [(1 / d) * Math.cos(loft) * speed, Math.sin(loft) * speed, (6.75 / d) * Math.cos(loft) * speed];
    const land = landingPoint(from, v, m);
    expect(land[0]).toBeCloseTo(1, 2);
    expect(land[2]).toBeCloseTo(3, 2);
    const arc = arcPoints(from, v, m);
    expect(arc[arc.length - 1]![1]).toBe(0);
  });
});

describe('flick', () => {
  function flick(points: [number, number, number][]) {
    const f = new FlickTracker(1000);
    const [x0, y0, t0] = points[0]!;
    f.begin(x0, y0, t0);
    for (const [x, y, t] of points.slice(1)) f.move(x, y, t);
    return f.end(points[points.length - 1]![2]);
  }

  it('measures forward speed at release in screen heights per second', () => {
    const pts: [number, number, number][] = [[500, 500, 0]];
    for (let t = 10; t <= 200; t += 10) pts.push([500, 500 + t, t]); // pull back
    for (let t = 210; t <= 400; t += 10) pts.push([500, 700 - (t - 200) * 1.5, t]); // push at 1500 px/s
    const r = flick(pts);
    expect(r.pulledBack).toBe(true);
    expect(r.forward).toBeCloseTo(1.5, 1);
    expect(Math.abs(r.lateral)).toBeLessThan(0.01);
    expect(flickSpeed(r.forward)).toBeGreaterThan(5);
  });

  it('a push with no pull-back does not count', () => {
    const r = flick([
      [500, 500, 0],
      [500, 450, 30],
      [500, 400, 60],
    ]);
    expect(r.pulledBack).toBe(false);
  });

  it('sideways motion bends the throw, within limits', () => {
    const pts: [number, number, number][] = [[500, 500, 0], [500, 600, 100]];
    for (let t = 110; t <= 300; t += 10) pts.push([500 + (t - 100) * 0.5, 600 - (t - 100) * 1.5, t]);
    const r = flick(pts);
    expect(flickBend(r)).toBeGreaterThan(0);
    expect(flickBend(r)).toBeLessThanOrEqual(12 * DEG + 1e-9);
  });
});
