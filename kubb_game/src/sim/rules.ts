// The rules of kubb as a pure reducer over GameState. Physics decides where
// things end up (sim/physics.ts); this decides what that means.

import { CFG, STANDING_COS } from '../config.ts';
import type { Action, GameEvent, GameState, Piece, Player, Pose, SettledResult, TeamId, Vec3 } from '../types.ts';
import { QUAT_IDENTITY, dist2xz, rotate, upY, yawQuat } from './math.ts';
import { HALF_W, KING_HOME, KUBB, baselineZ, forward, inHalf, other, stakePositions } from './pitch.ts';
import { batonsForTurn } from './setup.ts';

export type Act = 'throwKubb' | 'throwBaton' | 'raise' | 'penalty' | 'practice';

export interface Actor {
  player: Player;
  team: TeamId;
  act: Act;
}

export function isUpright(p: Pose): boolean {
  return upY(p.q) > STANDING_COS;
}

export function teamPlayers(s: GameState, t: TeamId): Player[] {
  return s.players.filter((p) => p.team === t);
}

function rotationPlayer(s: GameState, t: TeamId): Player | undefined {
  const list = teamPlayers(s, t);
  return list.length ? list[s.rotation[t] % list.length] : undefined;
}

/** Who must act next, and how. Null when the game is over. */
export function currentActor(s: GameState): Actor | null {
  const T = s.turn;
  const O = other(T);
  let team: TeamId;
  let act: Act;
  switch (s.phase) {
    case 'over':
      return null;
    case 'practice':
      team = 0;
      act = 'practice';
      break;
    case 'kubbThrow':
      team = T;
      act = 'throwKubb';
      break;
    case 'batonThrow':
      team = T;
      act = 'throwBaton';
      break;
    case 'raise':
      team = O;
      act = 'raise';
      break;
    case 'penalty':
      team = O;
      act = 'penalty';
      break;
  }
  const player = s.phase === 'practice' ? s.players[0] : rotationPlayer(s, team);
  return player ? { player, team, act } : null;
}

/** Kubbs the turn's team still has to throw this turn (penalty kubbs excluded). */
export function kubbsToThrow(s: GameState): Piece[] {
  return s.pieces.filter((p) => p.status === 'inHand' && !s.penaltyQueue.includes(p.id));
}

/** True when every kubb defended by the other team is down, so the king may be thrown at. */
export function kingShotAllowed(s: GameState, team: TeamId = s.turn): boolean {
  const O = other(team);
  return !s.pieces.some((p) => p.kind === 'kubb' && p.side === O && (p.status === 'standing' || p.status === 'landed'));
}

/** The z of the line the current thrower stands behind. */
export function throwLineZ(s: GameState): number {
  const T = s.phase === 'practice' ? 0 : s.turn;
  if (s.phase !== 'batonThrow') return baselineZ(T);
  if (CFG.rules.kingShotFromBaseline && kingShotAllowed(s)) return baselineZ(T);
  return s.throwLine ?? baselineZ(T);
}

export function throwingTeam(s: GameState): TeamId {
  return s.phase === 'practice' ? 0 : s.turn;
}

function finite(v: number[]): boolean {
  return v.every((n) => Number.isFinite(n));
}

/** Null if the action is legal now, otherwise why not. */
export function validateAction(s: GameState, a: Action): string | null {
  const actor = currentActor(s);
  if (!actor) return 'the game is over';
  if (a.type === 'drink') {
    if (!s.beer) return 'beer mode is off';
    if (!s.players.some((p) => p.id === a.player)) return 'no such player';
    return null;
  }
  if (!s.practice && a.player !== actor.player.id) return `it is ${actor.player.name}'s turn`;
  if (a.type === 'throw') {
    const it = a.intent;
    if (!finite([...it.p, ...it.q, ...it.v, ...it.w])) return 'bad numbers in throw';
    if (actor.act === 'throwKubb') {
      if (it.kind !== 'kubb') return 'throw a kubb first';
      if (!kubbsToThrow(s).some((p) => p.id === it.kubbId)) return 'that kubb is not in hand';
    } else if (actor.act === 'throwBaton') {
      if (it.kind !== 'baton') return 'throw a baton';
    } else if (actor.act === 'practice') {
      if (it.kubbId !== undefined) return 'practice kubbs have no id';
    } else {
      return 'not a throwing phase';
    }
    const T = throwingTeam(s);
    const depth = (it.p[2] - throwLineZ(s)) * forward(T);
    if (depth > 0.5 || depth < -2) return 'release from behind the line';
    if (Math.abs(it.p[0]) > HALF_W + 0.6) return 'release from within the pitch width';
    const [vx, vy, vz] = it.v;
    if (vx * vx + vy * vy + vz * vz > 30 * 30) return 'too fast';
    return null;
  }
  if (a.type === 'raise') {
    if (actor.act !== 'raise') return 'nothing to raise';
    if (a.end !== 0 && a.end !== 1) return 'bad end';
    if (!s.raiseQueue.includes(a.kubbId)) return 'that kubb is not waiting to be raised';
    return null;
  }
  if (actor.act !== 'penalty') return 'no penalty kubb to place';
  if (s.penaltyQueue[0] !== a.kubbId) return 'place the next penalty kubb';
  if (!Number.isFinite(a.x) || !Number.isFinite(a.z) || !validPenaltySpot(s, other(s.turn), a.x, a.z)) return 'not a legal spot';
  return null;
}

/** Penalty kubbs go anywhere in the half, a baton length from the king and stakes, not on another piece. */
export function validPenaltySpot(s: GameState, team: TeamId, x: number, z: number): boolean {
  if (!inHalf(team, x, z, KUBB[0] / 2)) return false;
  const c = CFG.rules.penaltyClearance;
  const spot: Vec3 = [x, 0, z];
  for (const st of [...stakePositions(), KING_HOME]) if (dist2xz(spot, st) < c * c) return false;
  for (const p of s.pieces) {
    if ((p.status === 'standing' || p.status === 'landed') && dist2xz(spot, p.p) < 0.11 * 0.11) return false;
  }
  return true;
}

/** Horizontal direction of a piece's long axis (unit), or null if it points up. */
function longAxisXZ(p: Pose): [number, number] | null {
  const a = rotate(p.q, [0, 1, 0]);
  const len = Math.sqrt(a[0] * a[0] + a[2] * a[2]);
  return len < 0.3 ? null : [a[0] / len, a[2] / len];
}

/** The two spots a landed kubb can be raised to: keeping one end or the other on the ground. */
export function raiseCandidates(k: Piece): [Vec3, Vec3] {
  const axis = longAxisXZ(k);
  const off = (KUBB[1] - KUBB[0]) / 2;
  const m = KUBB[0] / 2;
  const clampIn = (x: number, z: number): Vec3 => {
    const lo = k.side === 0 ? baselineZ(0) + m : m;
    const hi = k.side === 0 ? -m : baselineZ(1) - m;
    return [Math.min(HALF_W - m, Math.max(-HALF_W + m, x)), KUBB[1] / 2, Math.min(hi, Math.max(lo, z))];
  };
  if (!axis) {
    const c = clampIn(k.p[0], k.p[2]);
    return [c, [...c]];
  }
  return [clampIn(k.p[0] + axis[0] * off, k.p[2] + axis[1] * off), clampIn(k.p[0] - axis[0] * off, k.p[2] - axis[1] * off)];
}

/** Stand a piece back up: baseline kubbs and the king at home, field kubbs where they lie. */
function reraise(p: Piece): void {
  p.status = 'standing';
  if (p.role === 'baseline' || p.kind === 'king') {
    p.p = [...p.home];
    p.q = [...QUAT_IDENTITY];
    return;
  }
  const axis = longAxisXZ(p);
  p.p = [p.p[0], KUBB[1] / 2, p.p[2]];
  p.q = axis ? yawQuat(axis[0], axis[1]) : [...QUAT_IDENTITY];
}

function advanceRotation(s: GameState, t: TeamId): void {
  const n = teamPlayers(s, t).length || 1;
  s.rotation[t] = (s.rotation[t] + 1) % n;
}

function teamName(t: TeamId): string {
  return CFG.teams[t]!.name;
}

function event(s: GameState, e: GameEvent): void {
  s.events.push(e);
}

function clonePose(p: Pose): Pose {
  return { p: [...p.p], q: [...p.q] };
}

export function applyThrowResult(s0: GameState, a: Action & { type: 'throw' }, r: SettledResult): GameState {
  const s = structuredClone(s0);
  s.seq++;
  s.events = [];
  s.clock += CFG.beer.minutesPerThrow;
  const it = a.intent;
  const wasStanding = new Set(s.pieces.filter((p) => p.status === 'standing').map((p) => p.id));
  for (const p of s.pieces) {
    const pose = r.pieces[p.id];
    if (pose) {
      p.p = [...pose.p];
      p.q = [...pose.q];
    }
  }
  s.batons = r.batons.map(clonePose);
  if (it.kind === 'baton') s.batons.push(clonePose(r.thrown));
  const fell = s.pieces.filter((p) => wasStanding.has(p.id) && !isUpright(p));

  if (s.phase === 'practice') practiceResult(s, a, r, fell);
  else if (s.phase === 'kubbThrow') kubbThrowResult(s, a, r, fell);
  else batonResult(s0, s, fell);
  return s;
}

function practiceResult(s: GameState, a: Action & { type: 'throw' }, r: SettledResult, fell: Piece[]): void {
  for (const p of fell) {
    if (p.id.startsWith('x')) s.pieces = s.pieces.filter((q) => q !== p);
    else p.status = 'down';
  }
  if (fell.length) event(s, { type: 'knocked', text: `${fell.length} down` });
  if (a.intent.kind === 'kubb') {
    const k: Piece = {
      id: `x${s.seq}`,
      kind: 'kubb',
      p: [...r.thrown.p],
      q: [...r.thrown.q],
      status: 'landed',
      role: 'field',
      side: 1,
      home: [...r.thrown.p],
    };
    if (inHalf(1, k.p[0], k.p[2])) {
      const [c] = raiseCandidates(k);
      const axis = longAxisXZ(k);
      k.p = c;
      k.q = axis ? yawQuat(axis[0], axis[1]) : [...QUAT_IDENTITY];
      k.status = 'standing';
      s.pieces.push(k);
      event(s, { type: 'landed', text: 'In!' });
    } else {
      event(s, { type: 'rethrow', text: 'Out of bounds' });
    }
    return;
  }
  s.batonsLeft--;
  if (s.batonsLeft <= 0) {
    s.batonsLeft = CFG.rules.batonsPerTurn;
    s.batons = [];
    for (const p of s.pieces) if (p.status === 'down') reraise(p);
    event(s, { type: 'turn', text: 'Batons collected' });
  }
}

function kubbThrowResult(s: GameState, a: Action & { type: 'throw' }, r: SettledResult, fell: Piece[]): void {
  const T = s.turn;
  const O = other(T);
  const k = s.pieces.find((p) => p.id === a.intent.kubbId)!;
  k.p = [...r.thrown.p];
  k.q = [...r.thrown.q];
  for (const p of fell) if (p !== k) reraise(p);
  if (fell.some((p) => p !== k)) event(s, { type: 'reraised', text: 'Knocked kubbs stood back up' });

  if (inHalf(O, k.p[0], k.p[2])) {
    k.status = 'landed';
    k.role = 'field';
    k.side = O;
    s.raiseQueue.push(k.id);
    s.kubbAttempt = 0;
    event(s, { type: 'landed', text: 'In!', team: T });
  } else if (s.kubbAttempt < CFG.rules.kubbRethrows) {
    s.kubbAttempt++;
    k.status = 'inHand';
    event(s, { type: 'rethrow', text: 'Out — throw it again', team: T });
  } else {
    s.kubbAttempt = 0;
    k.status = 'inHand';
    k.role = 'field';
    k.side = O;
    s.penaltyQueue.push(k.id);
    event(s, { type: 'penaltyKubb', text: `Out twice — ${teamName(O)} places it`, team: T });
  }
  advanceRotation(s, T);
  if (kubbsToThrow(s).length === 0) {
    s.phase = s.raiseQueue.length ? 'raise' : s.penaltyQueue.length ? 'penalty' : 'batonThrow';
  }
}

function batonResult(s0: GameState, s: GameState, fell: Piece[]): void {
  const T = s.turn;
  const O = other(T);
  const kingShot = kingShotAllowed(s0, T);
  const fromBaseline = throwLineZ(s0) === baselineZ(T);
  const fieldLeft = s.pieces.some(
    (p) => p.kind === 'kubb' && p.role === 'field' && p.side === O && p.status === 'standing' && isUpright(p),
  );
  let knocked = 0;
  for (const p of fell) {
    if (p.kind === 'king') {
      if (kingShot && (fromBaseline || !CFG.rules.kingShotFromBaseline)) {
        s.winner = T;
        event(s, { type: 'win', text: `${teamName(T)} toppled the king and wins!`, team: T });
      } else {
        s.winner = O;
        event(s, { type: 'win', text: `King knocked early — ${teamName(O)} wins`, team: O });
      }
      p.status = 'down';
    } else if (p.side === O && p.role === 'field') {
      p.status = 'down';
      knocked++;
    } else if (p.side === O && p.role === 'baseline') {
      if (CFG.rules.baselineBeforeFieldPenalty && fieldLeft) {
        reraise(p);
        event(s, { type: 'baselinePenalty', text: 'Field kubbs first — baseline kubb stood back up', team: T });
      } else {
        p.status = 'down';
        knocked++;
      }
    } else {
      reraise(p);
    }
  }
  if (knocked) event(s, { type: 'knocked', text: knocked === 1 ? 'Kubb down!' : `${knocked} kubbs down!`, team: T });
  s.batonsLeft--;
  advanceRotation(s, T);
  if (s.winner !== null) s.phase = 'over';
  else if (s.batonsLeft <= 0) endTurn(s);
}

function endTurn(s: GameState): void {
  const T = s.turn;
  const O = other(T);
  for (const p of s.pieces) if (p.status === 'down') p.status = 'inHand';
  s.batons = [];
  // Field kubbs left standing in O's half let O throw batons from the one nearest the centre line.
  const left = s.pieces.filter((p) => p.kind === 'kubb' && p.role === 'field' && p.side === O && p.status === 'standing');
  s.throwLine = null;
  for (const p of left) {
    if (s.throwLine === null || Math.abs(p.p[2]) < Math.abs(s.throwLine)) s.throwLine = p.p[2];
  }
  s.turn = O;
  s.turnNumber++;
  s.batonsLeft = batonsForTurn(s.turnNumber);
  s.kubbAttempt = 0;
  s.phase = kubbsToThrow(s).length ? 'kubbThrow' : 'batonThrow';
  event(s, { type: 'turn', text: `${teamName(O)}'s turn`, team: O });
  if (s.throwLine !== null) event(s, { type: 'advantage', text: `${teamName(O)} throws from the advantage line`, team: O });
}

/** Raise or penalty placement. Assumes validateAction passed. */
export function applyPlace(s0: GameState, a: Action & { type: 'raise' | 'placePenalty' | 'drink' }): GameState {
  const s = structuredClone(s0);
  s.seq++;
  s.events = [];
  if (a.type === 'drink') {
    (s.drinks[a.player] ??= []).push(s.clock);
    const p = s.players.find((x) => x.id === a.player);
    event(s, { type: 'drink', text: `${p?.name ?? 'Someone'} cracks a beer`, team: p?.team });
    return s;
  }
  s.clock += CFG.beer.minutesPerPlace;
  const k = s.pieces.find((p) => p.id === a.kubbId)!;
  if (a.type === 'raise') {
    const c = raiseCandidates(k)[a.end];
    const axis = longAxisXZ(k);
    let top: Piece | null = null;
    const touch = CFG.rules.stackTouchDistance;
    for (const p of s.pieces) {
      if (p === k || p.kind !== 'kubb' || p.status !== 'standing') continue;
      if (dist2xz(c, p.p) < touch * touch && (!top || p.p[1] > top.p[1])) top = p;
    }
    if (top) {
      k.p = [top.p[0], top.p[1] + KUBB[1], top.p[2]];
      k.q = [...top.q];
      event(s, { type: 'stacked', text: 'Touching kubbs — stacked' });
    } else {
      k.p = c;
      k.q = axis ? yawQuat(axis[0], axis[1]) : [...QUAT_IDENTITY];
      event(s, { type: 'raised', text: 'Raised' });
    }
    k.status = 'standing';
    s.raiseQueue = s.raiseQueue.filter((id) => id !== k.id);
    if (!s.raiseQueue.length) s.phase = s.penaltyQueue.length ? 'penalty' : 'batonThrow';
  } else {
    k.p = [a.x, KUBB[1] / 2, a.z];
    k.q = [...QUAT_IDENTITY];
    k.status = 'standing';
    k.role = 'field';
    k.side = other(s.turn);
    s.penaltyQueue.shift();
    event(s, { type: 'placed', text: 'Penalty kubb placed' });
    if (!s.penaltyQueue.length) s.phase = 'batonThrow';
  }
  return s;
}

/** Kubbs still standing per side, for the HUD. */
export function standingCounts(s: GameState): { baseline: [number, number]; field: [number, number] } {
  const baseline: [number, number] = [0, 0];
  const field: [number, number] = [0, 0];
  for (const p of s.pieces) {
    if (p.kind !== 'kubb' || p.status !== 'standing') continue;
    if (p.role === 'baseline') baseline[p.side]++;
    else field[p.side]++;
  }
  return { baseline, field };
}
