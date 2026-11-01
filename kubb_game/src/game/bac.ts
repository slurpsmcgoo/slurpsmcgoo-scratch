// Beer mode: a simple blood-alcohol model and what it does to a player.
//
// Time is the game's own clock (minutes that advance with each throw and
// placement), so every peer computes the same BAC. Each can goes into the
// stomach and is absorbed gradually (first order), and the body clears alcohol
// at a constant rate. The lag between drinking and feeling it is what makes the
// sweet spot easy to overshoot. Simulated, for fun.

import { CFG } from '../config.ts';
import type { GameState } from '../types.ts';

export interface Bac {
  /** Blood alcohol, % (0.08 is 0.08 %). */
  bac: number;
  /** Still in the stomach, in the same units: how much more is coming. */
  pending: number;
  /** Change over the last game minute. */
  trend: number;
  cans: number;
}

const B = CFG.beer;

export function bacOf(s: GameState, playerId: string): Bac {
  const drinks = s.drinks?.[playerId] ?? [];
  let stomach = 0;
  let blood = 0;
  let prev = 0;
  let next = 0;
  const end = s.clock ?? 0;
  const absorb = 1 - Math.exp(-B.absorbPerMinute);
  for (let t = 0; t < end; t += 1) {
    while (next < drinks.length && drinks[next]! <= t) {
      stomach += B.dosePerCan;
      next++;
    }
    const a = stomach * absorb;
    stomach -= a;
    prev = blood;
    blood = Math.max(0, blood + a - B.eliminationPerMinute);
  }
  while (next < drinks.length) {
    stomach += B.dosePerCan;
    next++;
  }
  return { bac: blood, pending: stomach, trend: blood - prev, cans: drinks.length };
}

export interface DrunkEffects {
  /** 0..1, peaking in the sweet spot. */
  flow: number;
  /** 0 below the sweet spot's top, growing past it. */
  impairment: number;
}

export function drunkEffects(bac: number): DrunkEffects {
  const d = (bac - B.sweetSpot) / B.sweetHalfWidth;
  const flow = Math.max(0, 1 - d * d);
  const impairment = Math.max(0, Math.min(2, (bac - (B.sweetSpot + B.sweetHalfWidth * 0.6)) / B.impairmentPer));
  return { flow, impairment };
}

/** Plain words for the HUD. */
export function drunkLabel(bac: number): string {
  const e = drunkEffects(bac);
  if (e.flow > 0.5) return 'In the zone';
  if (e.impairment > 1.2) return 'Way too much';
  if (e.impairment > 0.4) return 'Wobbly';
  if (bac > B.sweetSpot) return 'Tipsy';
  if (bac > 0.02) return 'Warming up';
  return 'Sober';
}

/** Should a computer player have another? Each skill aims for a different buzz; easy ones overdo it. */
export function botWantsDrink(s: GameState, playerId: string, skill: 'easy' | 'medium' | 'hard', roll: number): boolean {
  if (!s.beer) return false;
  const last = s.drinks?.[playerId]?.at(-1);
  if (last !== undefined && s.clock - last < B.botCooldownMinutes) return false;
  const b = bacOf(s, playerId);
  const target = B.botTarget[skill];
  // Count what's still in the stomach, with some bots more patient than others.
  const projected = b.bac + b.pending * (skill === 'easy' ? 0.4 : 0.9);
  return projected < target && roll < 0.6;
}
