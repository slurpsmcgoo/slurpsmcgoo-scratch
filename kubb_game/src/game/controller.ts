// GameController: who acts next and where their action comes from. Local
// humans act through input, bots are run here (locally, or on the network
// host), remote players' actions arrive over the network. Every action goes
// through the session, and to the network when there is one.

import { botAction } from '../bot/bot.ts';
import { bacOf, botWantsDrink, drunkEffects } from './bac.ts';
import { CFG } from '../config.ts';
import { currentActor, validateAction, type Actor } from '../sim/rules.ts';
import type { Action, GameState, Player } from '../types.ts';
import { GameSession, type SessionEvent } from './session.ts';

/** What a player is doing before they throw, for other peers' avatars. */
export interface AimInfo {
  player: string;
  /** Where they stand along the line. */
  x: number;
  /** Horizontal aim direction. */
  dir: [number, number];
  /** 0..1, how far the arm is drawn back. */
  windup: number;
}

/** The network as the controller sees it. */
export interface NetPort {
  readonly isHost: boolean;
  /** `seq`: the state seq the action is applied to (the host numbers what it relays). */
  sendAction(a: Action, seq: number): void;
  sendAim(aim: AimInfo): void;
  /** True while the network has queued work (the host relaying, welcoming, handing over players); bots wait. */
  hasPendingWork?(): boolean;
}

export type ControllerEvent = SessionEvent | { type: 'botWindup'; player: Player; action: Action } | { type: 'aim'; aim: AimInfo };

/** Distributes Omit over the Action union. */
export type ActionInput = Action extends infer A ? (A extends Action ? Omit<A, 'id' | 'player'> : never) : never;

const WINDUP_S = 0.5;

export class GameController {
  readonly session: GameSession;
  readonly clientId: string;
  net: NetPort | null;
  readonly remoteAims = new Map<string, AimInfo>();
  /** Bots wait their think time; set to false to have bots act at once (tests). */
  botDelays = true;
  /** False stops computer players taking turns (tests, debugging); throws in flight still finish. */
  bots = true;
  paused = false;
  private counter = 0;
  private mine = new Set<string>();
  private botWait = -1;
  private botPending: { action: Action; t: number } | null = null;
  private listeners = new Set<(e: ControllerEvent) => void>();

  constructor(state: GameState, clientId: string, net: NetPort | null = null) {
    this.session = new GameSession(state);
    this.clientId = clientId;
    this.net = net;
    this.session.on((e) => this.emit(e));
  }

  get state(): GameState {
    return this.session.state;
  }

  on(fn: (e: ControllerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ControllerEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  isLocal(p: Player): boolean {
    return p.owner === this.clientId;
  }

  /** The player to act now, or null while a throw is in flight or the game is over. */
  actor(): Actor | null {
    if (this.session.busy) return null;
    return currentActor(this.session.state);
  }

  /** The actor, if it's a human at this computer. */
  localHuman(): Actor | null {
    const a = this.actor();
    return a && a.player.kind === 'human' && this.isLocal(a.player) ? a : null;
  }

  private botsRunHere(): boolean {
    return !this.net || this.net.isHost;
  }

  /** A local human acts. Returns an error if it isn't allowed right now. */
  act(input: ActionInput): string | null {
    const actor = this.localHuman();
    if (!actor) return 'not your turn';
    return this.submit({ ...input, id: `${this.clientId}:${this.counter++}`, player: actor.player.id } as Action);
  }

  private submit(a: Action): string | null {
    // A drink may be ordered mid-throw: it queues behind the throw instead of being refused.
    const err = a.type === 'drink' ? validateAction(this.state, a) : this.session.check(a);
    if (err) return err;
    this.mine.add(a.id);
    // Network first: applying can emit events (the host's sync) that must follow the action.
    this.net?.sendAction(a, this.session.nextSeq);
    this.session.submit(a);
    return null;
  }

  /** Beer mode: the local player whose turn it is (or this computer's first human) opens a can. */
  drink(): string | null {
    const actor = this.localHuman();
    const p = actor?.player ?? this.state.players.find((x) => x.kind === 'human' && this.isLocal(x));
    if (!p) return 'no player here';
    return this.submit({ type: 'drink', id: `${this.clientId}:${this.counter++}`, player: p.id });
  }

  /** The local player beer mode is about: whoever is acting here, or this computer's first human. */
  localDrinker(): Player | null {
    const actor = this.localHuman();
    return actor?.player ?? this.state.players.find((x) => x.kind === 'human' && this.isLocal(x)) ?? null;
  }

  /** An action from the network, in the host's order. */
  receive(a: Action, seq?: number): void {
    // Already part of a state we took from the host.
    if (seq !== undefined && seq < this.session.nextSeq) {
      this.mine.delete(a.id);
      return;
    }
    if (this.mine.delete(a.id)) return; // already applied when we made it
    this.session.submit(a);
  }

  /** Take the host's state (resync or late join). */
  resync(s: GameState): void {
    this.session.replaceState(s);
  }

  receiveAim(aim: AimInfo): void {
    this.remoteAims.set(aim.player, aim);
    this.emit({ type: 'aim', aim });
  }

  sendAim(aim: AimInfo): void {
    this.net?.sendAim(aim);
  }

  update(dt: number): void {
    if (this.paused) return;
    this.session.update(dt);
    this.runBots(dt);
  }

  private runBots(dt: number): void {
    if (!this.bots || !this.botsRunHere() || this.net?.hasPendingWork?.()) return;
    if (this.botPending) {
      this.botPending.t -= dt;
      if (this.botPending.t <= 0) {
        const a = this.botPending.action;
        this.botPending = null;
        this.submit(a);
      }
      return;
    }
    const actor = this.actor();
    if (!actor || actor.player.kind !== 'bot') {
      this.botWait = -1;
      return;
    }
    if (this.botWait < 0) this.botWait = this.botDelays ? CFG.bot[actor.player.skill].thinkS : 0;
    this.botWait -= dt;
    if (this.botWait > 0) return;
    this.botWait = -1;
    // Beer mode: bots have a drink when they feel like one, then act on a later frame.
    if (botWantsDrink(this.state, actor.player.id, actor.player.skill, Math.random())) {
      this.submit({ type: 'drink', id: `${this.clientId}:b${this.counter++}`, player: actor.player.id });
      return;
    }
    const drunk = this.state.beer ? drunkEffects(bacOf(this.state, actor.player.id).bac) : undefined;
    const a = botAction(this.state, actor.player, botRandom(), `${this.clientId}:b${this.counter++}`, drunk);
    if (a.type === 'throw' && this.botDelays) {
      this.botPending = { action: a, t: WINDUP_S };
      this.emit({ type: 'botWindup', player: actor.player, action: a });
    } else {
      this.submit(a);
    }
  }

  dispose(): void {
    this.session.dispose();
    this.listeners.clear();
  }
}

/** Bots outside tests don't need repeatable noise. */
function botRandom() {
  return {
    next: Math.random,
    gauss() {
      let s = 0;
      for (let i = 0; i < 6; i++) s += Math.random();
      return (s - 3) / Math.sqrt(0.5);
    },
  };
}
