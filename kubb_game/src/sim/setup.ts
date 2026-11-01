// A new game: baseline kubbs and the king in place, team `first` to throw.

import { CFG } from '../config.ts';
import type { GameState, Piece, Player, TeamId } from '../types.ts';
import { QUAT_IDENTITY } from './math.ts';
import { KING_HOME, baselineSpots } from './pitch.ts';

export function initialPieces(): Piece[] {
  const pieces: Piece[] = [];
  let n = 0;
  for (const team of [0, 1] as TeamId[]) {
    for (const spot of baselineSpots(team)) {
      pieces.push({
        id: `k${n++}`,
        kind: 'kubb',
        p: [...spot],
        q: [...QUAT_IDENTITY],
        status: 'standing',
        role: 'baseline',
        side: team,
        home: [...spot],
      });
    }
  }
  pieces.push({
    id: 'king',
    kind: 'king',
    p: [...KING_HOME],
    q: [...QUAT_IDENTITY],
    status: 'standing',
    role: 'field',
    side: 0,
    home: [...KING_HOME],
  });
  return pieces;
}

export function batonsForTurn(turnNumber: number): number {
  return CFG.rules.openingBatons[turnNumber] ?? CFG.rules.batonsPerTurn;
}

export function createGame(
  players: Player[],
  opts: { first?: TeamId; practice?: boolean; setting?: string; beer?: boolean } = {},
): GameState {
  const practice = opts.practice ?? false;
  return {
    seq: 0,
    practice,
    setting: opts.setting ?? 'park',
    players: players.map((p) => ({ ...p })),
    rotation: [0, 0],
    turn: opts.first ?? 0,
    turnNumber: 0,
    phase: practice ? 'practice' : 'batonThrow',
    pieces: initialPieces(),
    batons: [],
    batonsLeft: practice ? CFG.rules.batonsPerTurn : batonsForTurn(0),
    throwLine: null,
    kubbAttempt: 0,
    raiseQueue: [],
    penaltyQueue: [],
    winner: null,
    events: [],
    beer: opts.beer ?? false,
    clock: 0,
    drinks: {},
  };
}
