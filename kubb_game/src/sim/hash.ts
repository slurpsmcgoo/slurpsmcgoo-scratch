// Hash of a game state, so peers can check they simulated the same thing.

import type { GameState } from '../types.ts';

export function hashState(s: GameState): string {
  const { events: _events, ...rest } = s;
  const text = JSON.stringify(rest);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
