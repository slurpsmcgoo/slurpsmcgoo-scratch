// Pitch geometry. Team 0's baseline is at z = -length/2 and it throws towards
// +z; team 1's baseline is at +length/2. The king stands at the origin.

import { CFG } from '../config.ts';
import type { TeamId, Vec3 } from '../types.ts';

export const HALF_W = CFG.pitch.width / 2;
export const HALF_L = CFG.pitch.length / 2;
export const KUBB = CFG.pieces.kubb.size;
export const KING = CFG.pieces.king.size;

export function other(t: TeamId): TeamId {
  return t === 0 ? 1 : 0;
}

export function baselineZ(t: TeamId): number {
  return t === 0 ? -HALF_L : HALF_L;
}

/** +1 for team 0 (throws towards +z), -1 for team 1. */
export function forward(t: TeamId): 1 | -1 {
  return t === 0 ? 1 : -1;
}

/** Inside team t's half, centre line and edges included. */
export function inHalf(t: TeamId, x: number, z: number, margin = 0): boolean {
  if (x < -HALF_W + margin || x > HALF_W - margin) return false;
  return t === 0 ? z >= -HALF_L + margin && z <= -margin : z >= margin && z <= HALF_L - margin;
}

export function stakePositions(): Vec3[] {
  return [
    [-HALF_W, 0, -HALF_L],
    [HALF_W, 0, -HALF_L],
    [-HALF_W, 0, HALF_L],
    [HALF_W, 0, HALF_L],
    [-HALF_W, 0, 0],
    [HALF_W, 0, 0],
  ];
}

/** Baseline kubb spots for team t, evenly spaced between the corner stakes. */
export function baselineSpots(t: TeamId): Vec3[] {
  const n = CFG.pitch.baselineKubbs;
  const spots: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    spots.push([-HALF_W + (CFG.pitch.width * (i + 1)) / (n + 1), KUBB[1] / 2, baselineZ(t)]);
  }
  return spots;
}

export const KING_HOME: Vec3 = [0, KING[1] / 2, 0];
