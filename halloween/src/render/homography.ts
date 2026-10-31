// Perspective mapping (homography) between two quadrilaterals, used by the
// four-corner pin. Matrices are row-major 3x3 stored as 9 numbers.

import type { Pt } from '../config.ts';

export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Solves the 8x8 linear system for the homography mapping `src[i]` to `dst[i]`. */
export function computeHomography(src: Pt[], dst: Pt[]): Mat3 {
  if (src.length !== 4 || dst.length !== 4) throw new Error('homography needs 4 point pairs');
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]!;
    const [u, v] = dst[i]!;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(a, b);
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

/** Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) throw new Error('degenerate quad');
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const rowC = m[col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = m[r]!;
      const f = row[col]! / rowC[col]!;
      for (let k = col; k <= n; k++) row[k] = row[k]! - f * rowC[k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('singular matrix');
  const s = 1 / det;
  return [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}

export function applyHomography(m: Mat3, p: Pt): Pt {
  const [x, y] = p;
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

export const UNIT_SQUARE: Pt[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
