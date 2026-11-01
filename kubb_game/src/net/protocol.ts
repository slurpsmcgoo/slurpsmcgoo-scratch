// Messages between the room host and the other peers. Everything is JSON.

import type { AimInfo } from '../game/controller.ts';
import type { Action, BotSkill, GameState, Player, TeamId } from '../types.ts';

export type ToHost =
  | { t: 'hello'; client: string; name: string }
  | { t: 'addPlayer'; name: string; team: TeamId }
  | { t: 'removePlayer'; id: string }
  | { t: 'action'; action: Action }
  | { t: 'aim'; aim: AimInfo };

export type ToClient =
  | { t: 'lobby'; players: Player[]; setting: string; hostName: string; beer: boolean }
  | { t: 'start'; state: GameState }
  /** `seq`: the host's state seq the action applies to. */
  | { t: 'action'; action: Action; seq: number }
  | { t: 'sync'; seq: number; hash: string; state: GameState }
  /** Take this state now: your last action was rejected. */
  | { t: 'resync'; state: GameState }
  | { t: 'aim'; aim: AimInfo }
  | { t: 'error'; text: string };

export interface PlayerSpec {
  name: string;
  team: TeamId;
  kind: 'human' | 'bot';
  skill: BotSkill;
}
