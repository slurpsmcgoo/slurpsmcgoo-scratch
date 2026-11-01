// Throwing by dispersion: you aim at a point, your body roughly knows the power
// for it, and the flick decides where inside a circle around that point the
// throw goes. A flick faster than a comfortable middle speed goes long, slower
// goes short; sideways drift goes left or right. Getting close is easy, getting
// it exact is the skill.

import { CFG } from '../config.ts';
import type { Vec3 } from '../types.ts';
import type { FlickResult } from './flick.ts';

/** Offset inside the unit disc: `along` + is long, `side` + is the thrower's right. */
export interface DiscOffset {
  along: number;
  side: number;
}

export interface Modifiers {
  /** 0..1+: drunkenness past the sweet spot widens the circle. */
  impairment?: number;
  /** 0..1: in the zone, the circle tightens. */
  flow?: number;
}

/** Radius (m) of the circle a throw can land in, aimed `distance` metres away. */
export function dispersionRadius(distance: number, kind: 'baton' | 'kubb', mod: Modifiers = {}): number {
  const d = CFG.throw.dispersion;
  const r = (d.base + d.perMeter * distance) * (kind === 'kubb' ? d.kubbScale : 1);
  return r * (1 + (mod.impairment ?? 0) * d.impairedGrowth) * (1 - (mod.flow ?? 0) * d.flowShrink);
}

function clampDisc(o: DiscOffset): DiscOffset {
  const len = Math.hypot(o.along, o.side);
  return len > 1 ? { along: o.along / len, side: o.side / len } : o;
}

/** Where in the circle a flick puts the throw. */
export function flickOffset(f: FlickResult): DiscOffset {
  const d = CFG.throw.dispersion;
  const along = (f.forward - d.flickCenter) / d.flickRange;
  const angle = f.forward > 0 ? Math.atan2(f.lateral, f.forward) : 0;
  const side = angle / ((d.lateralFullDeg * Math.PI) / 180);
  return clampDisc({ along: Math.max(-1, Math.min(1, along)), side: Math.max(-1, Math.min(1, side)) });
}

/** Where in the circle a power-meter release puts the throw (0.5 is dead on). */
export function meterOffset(power: number, sideJitter: number): DiscOffset {
  return clampDisc({ along: power * 2 - 1, side: sideJitter });
}

/** The point on the ground the throw is sent to. */
export function offsetTarget(from: Vec3, aim: Vec3, o: DiscOffset, radius: number): Vec3 {
  const dx = aim[0] - from[0];
  const dz = aim[2] - from[2];
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  // The thrower's right, for either team: (-uz, ux).
  return [aim[0] + (ux * o.along - uz * o.side) * radius, aim[1], aim[2] + (uz * o.along + ux * o.side) * radius];
}
