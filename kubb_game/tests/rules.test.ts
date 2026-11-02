// Rules tested with scripted throw results: no physics, so each case says
// exactly which pieces fell and where things landed.

import { describe, expect, it } from 'vitest';
import { applyPlace, applyThrowResult, currentActor, kingShotAllowed, raiseCandidates, throwLineZ, validateAction } from '../src/sim/rules.ts';
import type { Action, GameState, Pose, Quat, SettledResult, Vec3 } from '../src/types.ts';
import { game } from './helpers.ts';

const FALLEN: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]; // lying along z
const ALONG_X: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2]; // lying along x

let n = 0;
function throwAction(s: GameState, kind: 'baton' | 'kubb' = 'baton', kubbId?: string): Action & { type: 'throw' } {
  const actor = currentActor(s)!;
  const z = throwLineZ(s) + (s.turn === 0 ? 0.25 : -0.25);
  const intent = { kind, p: [0, 0.75, z] as Vec3, q: [0, 0, 0, 1] as Quat, v: [0, 3, 8] as Vec3, w: [0, 0, 0] as Vec3, ...(kubbId ? { kubbId } : {}) };
  return { type: 'throw', id: `t${n++}`, player: actor.player.id, intent };
}

/** Everything where it was, except `fall` (knocked over in place) and `move` (new poses). */
function result(s: GameState, opts: { fall?: string[]; move?: Record<string, Pose>; thrown?: Pose } = {}): SettledResult {
  const pieces: Record<string, Pose> = {};
  for (const p of s.pieces) {
    if (p.status === 'inHand') continue;
    pieces[p.id] = { p: [...p.p], q: [...p.q] };
    if (opts.fall?.includes(p.id)) pieces[p.id] = { p: [p.p[0], 0.035, p.p[2]], q: FALLEN };
  }
  Object.assign(pieces, opts.move ?? {});
  return { pieces, batons: s.batons, thrown: opts.thrown ?? { p: [0, 0.022, 3], q: FALLEN }, steps: 1, dents: [] };
}

function baton(s: GameState, fall: string[] = []): GameState {
  const a = throwAction(s);
  expect(validateAction(s, a)).toBeNull();
  return applyThrowResult(s, a, result(s, { fall }));
}

/** Throw the next in-hand kubb so it lands at (x, z). */
function kubbTo(s: GameState, x: number, z: number, q: Quat = FALLEN): GameState {
  const id = s.pieces.find((p) => p.status === 'inHand' && !s.penaltyQueue.includes(p.id))!.id;
  const a = throwAction(s, 'kubb', id);
  expect(validateAction(s, a)).toBeNull();
  return applyThrowResult(s, a, result(s, { thrown: { p: [x, 0.035, z], q } }));
}

type PlaceInput = { type: 'raise'; kubbId: string; end: 0 | 1 } | { type: 'placePenalty'; kubbId: string; x: number; z: number };

function place(s: GameState, a: PlaceInput): GameState {
  const full = { ...a, id: `p${n++}`, player: currentActor(s)!.player.id } as Action & { type: 'raise' | 'placePenalty' };
  expect(validateAction(s, full)).toBeNull();
  return applyPlace(s, full);
}

function runOut(s: GameState): GameState {
  const t = s.turn;
  while (s.turn === t && s.phase === 'batonThrow') s = baton(s);
  return s;
}

describe('rules', () => {
  it('opens with 2 batons, then 4, then 6', () => {
    let s = game({ kind: 'human' });
    expect(s.batonsLeft).toBe(2);
    s = runOut(s);
    expect(s.turn).toBe(1);
    expect(s.batonsLeft).toBe(4);
    s = runOut(s);
    expect(s.batonsLeft).toBe(6);
  });

  it('rotates throwers within a team', () => {
    let s = game({ kind: 'human' });
    expect(currentActor(s)!.player.id).toBe('a1');
    s = baton(s);
    expect(currentActor(s)!.player.id).toBe('a2');
    s = baton(s);
    expect(currentActor(s)!.player.id).toBe('b1');
  });

  it('rejects the wrong player', () => {
    const s = game({ kind: 'human' });
    const a = { ...throwAction(s), player: 'b1' };
    expect(validateAction(s, a)).toMatch(/turn/);
  });

  it('knocked baseline kubbs go to the other team to throw into the first half', () => {
    let s = game({ kind: 'human' });
    s = baton(s, ['k5', 'k6']);
    expect(s.pieces.find((p) => p.id === 'k5')!.status).toBe('down');
    s = baton(s);
    expect(s.turn).toBe(1);
    expect(s.phase).toBe('kubbThrow');
    expect(s.pieces.filter((p) => p.status === 'inHand').map((p) => p.id)).toEqual(['k5', 'k6']);
    s = kubbTo(s, 0.5, -1.5);
    expect(s.phase).toBe('kubbThrow');
    s = kubbTo(s, -0.8, -2);
    expect(s.phase).toBe('raise');
    expect(currentActor(s)!.team).toBe(0); // the defending team raises
    s = place(s, { type: 'raise', kubbId: 'k5', end: 0 });
    s = place(s, { type: 'raise', kubbId: 'k6', end: 1 });
    expect(s.phase).toBe('batonThrow');
    const k5 = s.pieces.find((p) => p.id === 'k5')!;
    expect(k5).toMatchObject({ status: 'standing', role: 'field', side: 0 });
    expect(k5.p[1]).toBeCloseTo(0.075);
  });

  it('raising keeps either end on the ground', () => {
    let s = game({ kind: 'human' });
    s = runOut(baton(s, ['k5']));
    s = kubbTo(s, 0, -2); // lying along z
    const k = s.pieces.find((p) => p.id === 'k5')!;
    const [c0, c1] = raiseCandidates(k);
    expect(Math.abs(c0[2] - c1[2])).toBeCloseTo(0.08, 3);
    expect(c0[0]).toBeCloseTo(0);
  });

  it('kubbs raised touching each other are stacked', () => {
    let s = game({ kind: 'human' });
    s = runOut(baton(s, ['k5', 'k6']));
    s = kubbTo(s, 0, -2, ALONG_X);
    s = kubbTo(s, 0.03, -2, ALONG_X);
    s = place(s, { type: 'raise', kubbId: 'k5', end: 0 });
    s = place(s, { type: 'raise', kubbId: 'k6', end: 0 });
    const [a, b] = ['k5', 'k6'].map((id) => s.pieces.find((p) => p.id === id)!);
    expect(b!.p[1]).toBeCloseTo(a!.p[1] + 0.15);
    expect(s.events.some((e) => e.type === 'stacked')).toBe(true);
  });

  it('a kubb out twice becomes a penalty kubb the defenders place', () => {
    let s = game({ kind: 'human' });
    s = runOut(baton(s, ['k5']));
    s = kubbTo(s, 3.5, -2); // out (sideline)
    expect(s.phase).toBe('kubbThrow');
    expect(s.events[0]!.type).toBe('rethrow');
    s = kubbTo(s, 0, 0.5); // out (wrong half)
    expect(s.phase).toBe('penalty');
    expect(currentActor(s)!.team).toBe(0);
    const bad = { type: 'placePenalty' as const, kubbId: 'k5', x: 0.1, z: -0.1, id: 'x', player: currentActor(s)!.player.id };
    expect(validateAction(s, bad)).toMatch(/legal/); // too close to the king
    s = place(s, { type: 'placePenalty', kubbId: 'k5', x: 2, z: -3.4 });
    expect(s.phase).toBe('batonThrow');
    expect(s.pieces.find((p) => p.id === 'k5')).toMatchObject({ status: 'standing', side: 0, role: 'field' });
  });

  it('a baseline kubb knocked before the field kubbs is stood back up', () => {
    let s = game({ kind: 'human' });
    s = runOut(baton(s, ['k5']));
    s = kubbTo(s, 0, -2);
    s = place(s, { type: 'raise', kubbId: 'k5', end: 0 });
    s = baton(s, ['k0']); // team 1 hits team 0's baseline kubb with k5 standing in the field
    const k0 = s.pieces.find((p) => p.id === 'k0')!;
    expect(k0.status).toBe('standing');
    expect(k0.p).toEqual(k0.home);
    expect(s.events.some((e) => e.type === 'baselinePenalty')).toBe(true);
    s = baton(s, ['k5', 'k1']); // field kubb and baseline kubb in one throw: both count
    expect(s.pieces.find((p) => p.id === 'k1')!.status).toBe('down');
  });

  it('field kubbs left standing give the other team an advantage line', () => {
    let s = game({ kind: 'human' });
    s = runOut(baton(s, ['k5']));
    s = kubbTo(s, 0, -1.5);
    s = place(s, { type: 'raise', kubbId: 'k5', end: 0 });
    s = runOut(s); // team 1 misses everything
    expect(s.turn).toBe(0);
    expect(s.throwLine).not.toBeNull();
    expect(throwLineZ(s)).toBeCloseTo(s.pieces.find((p) => p.id === 'k5')!.p[2]);
  });

  it('knocking the king early loses', () => {
    let s = game({ kind: 'human' });
    s = baton(s, ['king']);
    expect(s.phase).toBe('over');
    expect(s.winner).toBe(1);
  });

  it('knocking the king after all kubbs wins', () => {
    let s = game({ kind: 'human' });
    s.pieces = s.pieces.filter((p) => p.side !== 1 || p.kind === 'king');
    expect(kingShotAllowed(s)).toBe(true);
    s = baton(s, ['king']);
    expect(s.winner).toBe(0);
  });

  it('the king shot is from the baseline even with an advantage line', () => {
    let s = game({ kind: 'human' });
    s.pieces = s.pieces.filter((p) => p.side !== 1 || p.kind === 'king');
    s.throwLine = -1;
    expect(throwLineZ(s)).toBe(-4);
  });
});
