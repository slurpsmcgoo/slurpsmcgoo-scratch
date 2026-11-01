// Computer players. A bot picks a target, solves the throw that would hit it,
// then misses by a little: aim and power noise scale with difficulty.

import { CFG, DEG } from '../config.ts';
import { createRng, type Rng } from '../sim/rng.ts';
import { HALF_W, KUBB, baselineZ, forward, other } from '../sim/pitch.ts';
import { currentActor, kubbsToThrow, raiseCandidates, throwLineZ, validPenaltySpot } from '../sim/rules.ts';
import { makeIntent, mediumOf, releasePoint, solveSpeed, type Medium } from '../throw/model.ts';
import type { DrunkEffects } from '../game/bac.ts';
import type { Action, GameState, Piece, Player, Vec3 } from '../types.ts';

export function botRng(s: GameState, salt = 0): Rng {
  return createRng((s.seq + 1) * 7919 + s.turnNumber * 104729 + salt);
}

/** Pick what a bot does now. The state must have this player as the current actor. */
export function botAction(s: GameState, player: Player, rng: Rng, actionId: string, drunk?: DrunkEffects): Action {
  const actor = currentActor(s);
  const base = { id: actionId, player: player.id };
  // Beer mode: in the zone a bot is steadier; past it, much shakier.
  const B = CFG.beer;
  const noise = drunk ? (1 + drunk.impairment * B.botNoisePerImpairment) * (1 - drunk.flow * B.botFlowSharpen) : 1;
  const skill = { aimDeg: CFG.bot[player.skill].aimDeg * noise, speedPct: CFG.bot[player.skill].speedPct * noise };
  if (!actor) throw new Error('game over');

  if (actor.act === 'raise') {
    const k = s.pieces.find((p) => p.id === s.raiseQueue[0])!;
    const [c0, c1] = raiseCandidates(k);
    // Raise towards our own baseline: further from the throwers.
    const thrower = baselineZ(s.turn);
    const end: 0 | 1 = Math.abs(c0[2] - thrower) >= Math.abs(c1[2] - thrower) ? 0 : 1;
    return { ...base, type: 'raise', kubbId: k.id, end };
  }

  if (actor.act === 'penalty') {
    const [x, z] = penaltySpot(s, rng);
    return { ...base, type: 'placePenalty', kubbId: s.penaltyQueue[0]!, x, z };
  }

  const team = actor.team;
  const fwd = forward(team);
  if (actor.act === 'throwKubb') {
    const k = kubbsToThrow(s)[0]!;
    const O = other(team);
    // Just over the centre line, near kubbs already thrown this turn so they may stack.
    const landed = s.pieces.filter((p) => p.status === 'landed' && p.side === O);
    const tx = landed.length ? landed[0]!.p[0] + rng.gauss() * 0.15 : (rng.next() - 0.5) * 2.4;
    const tz = fwd * (CFG.bot.kubbTargetPastMidline + rng.next() * 0.4);
    const from = releasePoint(s, tx * 0.7);
    return { ...base, type: 'throw', intent: aimedIntent('kubb', from, [tx, 0.04, tz], CFG.bot.kubbLoftDeg * DEG, mediumOf(s), skill, rng, k.id) };
  }

  const target = pickTarget(s, team);
  const from = releasePoint(s, target.p[0] * 0.6);
  const dx = target.p[0] - from[0];
  const dz = target.p[2] - from[2];
  const len = Math.hypot(dx, dz) || 1;
  const short = CFG.bot.aimShort;
  const aim: Vec3 = [target.p[0] - (dx / len) * short, target.kind === 'king' ? 0.12 : 0.06, target.p[2] - (dz / len) * short];
  return { ...base, type: 'throw', intent: aimedIntent('baton', from, aim, CFG.bot.batonLoftDeg * DEG, mediumOf(s), skill, rng) };
}

function aimedIntent(
  kind: 'baton' | 'kubb',
  from: Vec3,
  target: Vec3,
  loft: number,
  m: Medium,
  skill: { aimDeg: number; speedPct: number },
  rng: Rng,
  kubbId?: string,
) {
  const speed = solveSpeed(from, target, loft, m) ?? CFG.throw.maxSpeed;
  const yawErr = rng.gauss() * skill.aimDeg * DEG;
  const dx = target[0] - from[0];
  const dz = target[2] - from[2];
  const c = Math.cos(yawErr);
  const sn = Math.sin(yawErr);
  const dir: [number, number] = [dx * c - dz * sn, dx * sn + dz * c];
  const v = speed * (1 + (rng.gauss() * skill.speedPct) / 100);
  return makeIntent({ kind, kubbId, from, dir, loft, speed: v });
}

/** Nearest standing field kubb, else nearest baseline kubb, else the king. */
export function pickTarget(s: GameState, team: 0 | 1): Piece {
  const O = other(team);
  const line = throwLineZ(s);
  const standing = s.pieces.filter((p) => p.kind === 'kubb' && p.side === O && p.status === 'standing');
  const field = standing.filter((p) => p.role === 'field');
  const pool = field.length ? field : standing;
  if (!pool.length) return s.pieces.find((p) => p.kind === 'king')!;
  // Highest of a stack first (it falls easiest), then nearest to the line.
  return [...pool].sort((a, b) => Math.abs(a.p[2] - line) - Math.abs(b.p[2] - line) || b.p[1] - a.p[1])[0]!;
}

function penaltySpot(s: GameState, rng: Rng): [number, number] {
  const O = other(s.turn);
  const c = CFG.rules.penaltyClearance;
  const side = rng.next() < 0.5 ? -1 : 1;
  const zIn = baselineZ(O) + forward(O) * (c + 0.12);
  const candidates: [number, number][] = [
    [side * (HALF_W - c - 0.08), zIn],
    [-side * (HALF_W - c - 0.08), zIn],
  ];
  for (let i = 0; i < 40; i++) {
    candidates.push([(rng.next() - 0.5) * 2 * (HALF_W - KUBB[0]), baselineZ(O) + forward(O) * (0.2 + rng.next() * 3.5)]);
  }
  for (const [x, z] of candidates) if (validPenaltySpot(s, O, x, z)) return [x, z];
  return [0, baselineZ(O) / 2];
}
