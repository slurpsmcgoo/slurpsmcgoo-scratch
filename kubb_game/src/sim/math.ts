// Vector and quaternion helpers for the sim. Plain arithmetic and sqrt only
// (both exactly rounded in IEEE 754), so results match on every platform.

import type { Quat, Vec3 } from '../types.ts';

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

export function rotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

/** World-space y component of the body's local up axis. */
export function upY(q: Quat): number {
  return 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
}

export function dist2xz(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dz = a[2] - b[2];
  return dx * dx + dz * dz;
}

export function distXZ(a: Vec3, b: Vec3): number {
  return Math.sqrt(dist2xz(a, b));
}

/**
 * Rotation about +y that turns +z towards the horizontal direction (dx, dz),
 * from half-angle identities so it needs no trigonometry.
 */
export function yawQuat(dx: number, dz: number): Quat {
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-9) return [...QUAT_IDENTITY];
  const c = dz / len; // cos(yaw)
  const s = dx / len; // sin(yaw)
  const ch = Math.sqrt(Math.max(0, (1 + c) / 2));
  let sh = Math.sqrt(Math.max(0, (1 - c) / 2));
  if (s < 0) sh = -sh;
  return [0, sh, 0, ch];
}
