import { initPhysics } from '../src/sim/physics.ts';
import { createGame } from '../src/sim/setup.ts';
import type { BotSkill, GameState, Player, TeamId } from '../src/types.ts';

export async function ready(): Promise<void> {
  await initPhysics();
}

export function player(id: string, team: TeamId, kind: 'human' | 'bot' = 'human', skill: BotSkill = 'hard'): Player {
  return { id, name: id, team, kind, skill, owner: 'local', look: 0 };
}

/** Two players a side, all bots unless told otherwise. */
export function game(opts: { kind?: 'human' | 'bot'; skill?: BotSkill; setting?: string; practice?: boolean } = {}): GameState {
  const k = opts.kind ?? 'bot';
  const s = opts.skill ?? 'hard';
  return createGame([player('a1', 0, k, s), player('b1', 1, k, s), player('a2', 0, k, s), player('b2', 1, k, s)], {
    setting: opts.setting,
    practice: opts.practice,
  });
}
