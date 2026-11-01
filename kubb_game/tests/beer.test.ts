// Beer mode: the BAC model, the drink action, and bots that drink.

import { beforeAll, describe, expect, it } from 'vitest';
import { CFG } from '../src/config.ts';
import { bacOf, botWantsDrink, drunkEffects } from '../src/game/bac.ts';
import { GameController } from '../src/game/controller.ts';
import { applyAction } from '../src/game/session.ts';
import { validateAction } from '../src/sim/rules.ts';
import { createGame } from '../src/sim/setup.ts';
import type { GameState } from '../src/types.ts';
import { player, ready } from './helpers.ts';

beforeAll(ready);

/** A state with this player's cans at these minutes, at game minute `now`. */
function at(now: number, cans: number[]): GameState {
  const s = createGame([player('a', 0), player('b', 1)], { beer: true });
  s.clock = now;
  s.drinks = { a: cans };
  return s;
}

describe('BAC model', () => {
  it('a can takes a while to hit, then wears off', () => {
    const early = bacOf(at(2, [0]), 'a').bac;
    const peakish = bacOf(at(30, [0]), 'a').bac;
    const later = bacOf(at(200, [0]), 'a').bac;
    expect(early).toBeLessThan(peakish * 0.5);
    expect(peakish).toBeGreaterThan(CFG.beer.dosePerCan * 0.4);
    expect(later).toBeLessThan(peakish * 0.6);
    expect(bacOf(at(2, [0]), 'a').pending).toBeGreaterThan(0.01);
  });

  it('the sweet spot is reachable with a few cans', () => {
    const cans = [0, 4, 8, 12];
    let best = 0;
    for (let t = 0; t < 120; t++) best = Math.max(best, drunkEffects(bacOf(at(t, cans), 'a').bac).flow);
    expect(best).toBeGreaterThan(0.8);
  });

  it('a couple more overshoots it, after a delay', () => {
    const cans = [0, 2, 4, 6, 8, 10, 12];
    // Right after the last can it still looks fine...
    expect(drunkEffects(bacOf(at(13, cans), 'a').bac).impairment).toBe(0);
    // ...but it keeps climbing.
    let worst = 0;
    for (let t = 13; t < 120; t++) worst = Math.max(worst, drunkEffects(bacOf(at(t, cans), 'a').bac).impairment);
    expect(worst).toBeGreaterThan(0.5);
  });
});

describe('drink action', () => {
  it('anyone may drink at any time, as fast as they like, only in beer mode', () => {
    let s = createGame([player('a', 0), player('b', 1)], { beer: true, first: 0 });
    const drink = (p: string, id: string) => ({ type: 'drink' as const, id, player: p });
    expect(validateAction(s, drink('b', '1'))).toBeNull(); // not b's turn: fine
    s = applyAction(s, drink('b', '1'));
    expect(s.drinks.b).toEqual([0]);
    s = applyAction(s, drink('b', '2'));
    expect(s.drinks.b).toEqual([0, 0]);
    const off = createGame([player('a', 0), player('b', 1)]);
    expect(validateAction(off, drink('a', '3'))).toMatch(/off/);
  });

  it('bots drink during a beer-mode game and still finish it', () => {
    const s0 = createGame([player('a', 0, 'bot', 'easy'), player('b', 1, 'bot', 'hard')], { beer: true, first: 0 });
    const ctl = new GameController(s0, 'local');
    ctl.botDelays = false;
    ctl.session.timeScale = 1000;
    for (let i = 0; i < 20000 && ctl.state.phase !== 'over'; i++) ctl.update(0.05);
    expect(ctl.state.phase).toBe('over');
    expect((ctl.state.drinks.a ?? []).length).toBeGreaterThan(0);
    expect((ctl.state.drinks.b ?? []).length).toBeGreaterThan(0);
    expect(ctl.state.clock).toBeGreaterThan(5);
  });

  it('easy bots aim for a bigger buzz than hard ones', () => {
    // About 0.08 %: past a hard bot's target, short of an easy one's.
    const s = at(60, [0, 5, 10, 15, 20, 25]);
    s.drinks.b = s.drinks.a!;
    expect(bacOf(s, 'a').bac).toBeGreaterThan(CFG.beer.botTarget.hard);
    expect(botWantsDrink(s, 'a', 'easy', 0)).toBe(true);
    expect(botWantsDrink(s, 'b', 'hard', 0)).toBe(false);
  });
});
