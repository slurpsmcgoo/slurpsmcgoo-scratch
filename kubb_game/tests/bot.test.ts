// Computer players, and whole games played by them headlessly: the end-to-end
// test of rules + physics + throw model.

import { beforeAll, describe, expect, it } from 'vitest';
import { botAction } from '../src/bot/bot.ts';
import { applyAction } from '../src/game/session.ts';
import { createRng } from '../src/sim/rng.ts';
import { currentActor, isUpright } from '../src/sim/rules.ts';
import { createGame } from '../src/sim/setup.ts';
import type { BotSkill, GameState } from '../src/types.ts';
import { game, player, ready } from './helpers.ts';

beforeAll(ready);

function playGame(s: GameState, seed: number, maxActions = 1500): { s: GameState; actions: number } {
  const rng = createRng(seed);
  let actions = 0;
  while (s.phase !== 'over' && actions < maxActions) {
    const actor = currentActor(s)!;
    s = applyAction(s, botAction(s, actor.player, rng, `a${actions}`));
    actions++;
  }
  return { s, actions };
}

describe('bots', () => {
  it('a hard bot usually hits a baseline kubb at 8 m', () => {
    const rng = createRng(1);
    let hits = 0;
    const tries = 20;
    for (let i = 0; i < tries; i++) {
      const s = game();
      const a = botAction(s, currentActor(s)!.player, rng, `h${i}`);
      const after = applyAction(s, a);
      if (after.pieces.some((p) => p.side === 1 && p.kind === 'kubb' && !isUpright(p))) hits++;
    }
    expect(hits / tries).toBeGreaterThan(0.3);
  });

  it.each([
    ['park', 'hard', 11],
    ['park', 'medium', 12],
    ['moon', 'hard', 13],
    ['ocean', 'hard', 14],
  ] as const)('two teams of bots finish a game (%s, %s)', (setting, skill: BotSkill, seed) => {
    const s0 = createGame([player('a1', 0, 'bot', skill), player('b1', 1, 'bot', skill), player('a2', 0, 'bot', skill)], { setting });
    const { s, actions } = playGame(s0, seed);
    expect(s.phase).toBe('over');
    expect(s.winner).not.toBeNull();
    expect(actions).toBeGreaterThan(10);
    // Sanity: nothing ends up below the ground or flung far away.
    for (const p of s.pieces) {
      if (p.status === 'inHand') continue;
      expect(p.p[1]).toBeGreaterThan(-0.01);
      expect(Math.abs(p.p[0])).toBeLessThan(15);
    }
  });
});
