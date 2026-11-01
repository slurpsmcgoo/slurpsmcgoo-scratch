// Ready-made situations for checking the game in a browser:
// __kubb.scenario('raise') etc. from the console. You play team Red (0).

import { createGame } from '../sim/setup.ts';
import type { GameState, Player } from '../types.ts';

export const SCENARIOS = ['raise', 'penalty', 'kingShot', 'advantage', 'kubbThrow'] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export function scenario(name: ScenarioName, owner: string, setting = 'park'): GameState {
  const players: Player[] = [
    { id: 'p0', name: 'You', team: 0, kind: 'human', skill: 'medium', owner, look: 1 },
    { id: 'p1', name: 'Astrid', team: 1, kind: 'bot', skill: 'hard', owner, look: 4 },
  ];
  const s = createGame(players, { setting, first: 1 });
  const piece = (id: string) => s.pieces.find((p) => p.id === id)!;
  s.turnNumber = 2;
  switch (name) {
    case 'raise':
      // Astrid is about to throw two kubbs into your half; you raise them.
      for (const id of ['k6', 'k7']) piece(id).status = 'inHand';
      s.phase = 'kubbThrow';
      break;
    case 'penalty': {
      // A kubb Astrid threw out twice: you place it.
      const k = piece('k6');
      k.status = 'inHand';
      k.role = 'field';
      k.side = 0;
      s.penaltyQueue = ['k6'];
      s.phase = 'penalty';
      break;
    }
    case 'kingShot':
      // Every Blue kubb is down: your turn, throw at the king.
      s.turn = 0;
      s.pieces = s.pieces.filter((p) => p.side !== 1 || p.kind === 'king');
      s.phase = 'batonThrow';
      s.batonsLeft = 6;
      break;
    case 'advantage': {
      // A field kubb left standing in your half moves your throw line up to it; a Blue field kubb stands in their half.
      s.turn = 0;
      const k = piece('k1');
      k.role = 'field';
      k.side = 1;
      k.p = [0.4, 0.075, 1.6];
      const own = piece('k2');
      own.role = 'field';
      own.side = 0;
      own.p = [-0.6, 0.075, -1.8];
      s.throwLine = -1.8;
      s.phase = 'batonThrow';
      s.batonsLeft = 6;
      break;
    }
    case 'kubbThrow':
      // You throw two kubbs into Blue's half.
      s.turn = 0;
      for (const id of ['k1', 'k2']) piece(id).status = 'inHand';
      s.phase = 'kubbThrow';
      break;
  }
  return s;
}
