import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from '../src/perception/oneEuro.ts';
import { seeded } from './helpers.ts';

const PARAMS = { minCutoff: 1, beta: 0.3, dCutoff: 1 };

describe('OneEuroFilter', () => {
  it('passes a constant through unchanged', () => {
    const f = new OneEuroFilter(PARAMS);
    for (let i = 0; i < 30; i++) expect(f.filter(0.4, i / 15)).toBeCloseTo(0.4, 10);
  });

  it('removes most jitter from a still point', () => {
    const f = new OneEuroFilter(PARAMS);
    const rng = seeded(3);
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      const v = 0.5 + (rng() - 0.5) * 0.02;
      raw.push(v);
      out.push(f.filter(v, i / 15));
    }
    const sd = (xs: number[]) => {
      const tail = xs.slice(50);
      const m = tail.reduce((a, b) => a + b, 0) / tail.length;
      return Math.sqrt(tail.reduce((a, b) => a + (b - m) ** 2, 0) / tail.length);
    };
    expect(sd(out)).toBeLessThan(sd(raw) * 0.5);
  });

  it('follows fast motion with little lag', () => {
    const f = new OneEuroFilter(PARAMS);
    let last = 0;
    for (let i = 0; i <= 15; i++) last = f.filter(i / 15, i / 15); // moving 1 unit/s
    expect(1 - last).toBeLessThan(0.1);
  });

  it('ignores samples with non-increasing timestamps', () => {
    const f = new OneEuroFilter(PARAMS);
    f.filter(0, 1);
    expect(f.filter(10, 1)).toBe(0);
  });
});
