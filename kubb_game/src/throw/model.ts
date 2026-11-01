// Building throws. Every input (flick, meter, XR, bot) ends up here: choose a
// release point, a direction, a loft angle and a speed, and get a ThrowIntent
// whose numbers are rounded so every peer simulates exactly the same throw.

import { CFG, DEG, physicsFor } from '../config.ts';
import { throwLineZ, throwingTeam } from '../sim/rules.ts';
import { HALF_W, forward } from '../sim/pitch.ts';
import type { GameState, Quat, TeamId, ThrowIntent, Vec3 } from '../types.ts';

const T = CFG.throw;

export interface ThrowParams {
  kind: 'baton' | 'kubb';
  kubbId?: string;
  from: Vec3;
  /** Horizontal direction (dx, dz); normalised here. */
  dir: [number, number];
  /** Radians above horizontal. */
  loft: number;
  /** m/s. */
  speed: number;
  /** Multiplies the usual end-over-end spin: 0 throws it flat with no turn, 2 is a fast tumble. */
  spin?: number;
}

export function quantize(n: number): number {
  const r = Math.round(n / T.quantum) * T.quantum;
  // Strip float noise from the multiplication so the JSON is short and exact.
  return Number(r.toFixed(4));
}

function q4(q: Quat): Quat {
  return q.map(quantize) as Quat;
}

function axisAngle(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** Turn throw parameters into an intent: end-over-end spin about the horizontal axis across the throw. */
export function makeIntent(p: ThrowParams): ThrowIntent {
  const len = Math.hypot(p.dir[0], p.dir[1]) || 1;
  const dx = p.dir[0] / len;
  const dz = p.dir[1] / len;
  const speed = Math.max(0, Math.min(T.maxSpeed * 1.6, p.speed));
  const c = Math.cos(p.loft);
  const v: Vec3 = [dx * c * speed, Math.sin(p.loft) * speed, dz * c * speed];
  // cross(up, forward): spinning about it carries the top end forward.
  const axis: Vec3 = [dz, 0, -dx];
  const rev = ((p.kind === 'baton' ? T.batonSpinRevPerSec : T.kubbSpinRevPerSec) + T.spinPerSpeed * speed) * (p.spin ?? 1);
  const spin = rev * 2 * Math.PI;
  const q = axisAngle(axis, T.batonStartTiltDeg * DEG);
  const intent: ThrowIntent = {
    kind: p.kind,
    p: p.from.map(quantize) as Vec3,
    q: q4(q),
    v: v.map(quantize) as Vec3,
    w: [axis[0] * spin, 0, axis[2] * spin].map(quantize) as Vec3,
  };
  if (p.kubbId !== undefined) intent.kubbId = p.kubbId;
  return intent;
}

/** Where a player standing at x on the current throw line lets go. */
export function releasePoint(s: GameState, x: number): Vec3 {
  const team = throwingTeam(s);
  const cx = Math.max(-HALF_W, Math.min(HALF_W, x));
  return [cx, T.releaseHeight, throwLineZ(s) + forward(team) * T.releaseForward];
}

export function teamForward(team: TeamId): 1 | -1 {
  return forward(team);
}

/** What a throw flies through: gravity (m/s²) and quadratic drag (1/m; 0 in air). */
export interface Medium {
  g: number;
  drag: number;
}

export function mediumOf(s: GameState): Medium {
  const p = physicsFor(s.setting);
  return { g: p.gravity, drag: p.waterDrag };
}

const FLIGHT_DT = 1 / 120;

/** Integrate a point mass through the medium until it drops below `floor` (or `maxT`). */
function fly(from: Vec3, v: Vec3, m: Medium, floor: number, maxT: number, each?: (p: Vec3) => void): Vec3 {
  let [x, y, z] = from;
  let [vx, vy, vz] = v;
  for (let t = 0; t < maxT; t += FLIGHT_DT) {
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const f = Math.max(0, 1 - m.drag * sp * FLIGHT_DT);
    vx *= f;
    vy = vy * f - m.g * FLIGHT_DT;
    vz *= f;
    const nx = x + vx * FLIGHT_DT;
    const ny = y + vy * FLIGHT_DT;
    const nz = z + vz * FLIGHT_DT;
    if (ny < floor && vy < 0) {
      const u = (y - floor) / (y - ny);
      return [x + (nx - x) * u, floor, z + (nz - z) * u];
    }
    x = nx;
    y = ny;
    z = nz;
    each?.([x, y, z]);
  }
  return [x, y, z];
}

function velocity(dir: [number, number], loft: number, speed: number): Vec3 {
  const len = Math.hypot(dir[0], dir[1]) || 1;
  const c = Math.cos(loft);
  return [(dir[0] / len) * c * speed, Math.sin(loft) * speed, (dir[1] / len) * c * speed];
}

/**
 * Speed that carries a projectile launched at `loft` from `from` through
 * `target`. Exact without drag; with drag, found by bisection. Null when the
 * target can't be reached at that loft.
 */
export function solveSpeed(from: Vec3, target: Vec3, loft: number, m: Medium): number | null {
  const d = Math.hypot(target[0] - from[0], target[2] - from[2]);
  const h = target[1] - from[1];
  if (m.drag <= 0) {
    const c = Math.cos(loft);
    const denom = 2 * c * c * (d * Math.tan(loft) - h);
    if (denom <= 0) return null;
    return Math.sqrt((m.g * d * d) / denom);
  }
  const dir: [number, number] = [target[0] - from[0], target[2] - from[2]];
  const reach = (speed: number) => {
    const end = fly(from, velocity(dir, loft, speed), m, target[1], 20);
    return Math.hypot(end[0] - from[0], end[2] - from[2]);
  };
  let lo = 0.1;
  let hi = 80;
  if (reach(hi) < d) return null;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (reach(mid) < d) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Points along the flight until it reaches the ground (no spin). */
export function arcPoints(from: Vec3, v: Vec3, m: Medium): Vec3[] {
  const pts: Vec3[] = [[...from]];
  let n = 0;
  fly(from, v, m, 0, 8, (p) => {
    if (n++ % 4 === 0) pts.push(p);
  });
  pts.push(landingPoint(from, v, m));
  return pts;
}

/** Where a throw first reaches the ground (no spin). */
export function landingPoint(from: Vec3, v: Vec3, m: Medium): Vec3 {
  if (m.drag <= 0) {
    const t = (v[1] + Math.sqrt(v[1] * v[1] + 2 * m.g * from[1])) / m.g;
    return [from[0] + v[0] * t, 0, from[2] + v[2] * t];
  }
  return fly(from, v, m, 0, 20);
}

/** Speed needed for a reference 8 m throw: ratios of it make input feel the same in every setting. */
function referenceSpeed(m: Medium): number {
  return solveSpeed([0, 0.75, 0], [0, 0.06, 8], 34 * DEG, m) ?? 10;
}

/** Throw speeds for a setting relative to the park, so a flick reaches about as far everywhere. */
export function speedScale(s: GameState): number {
  return referenceSpeed(mediumOf(s)) / referenceSpeed({ g: CFG.physics.gravity, drag: 0 });
}
