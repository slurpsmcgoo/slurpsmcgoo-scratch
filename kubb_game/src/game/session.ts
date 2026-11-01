// GameSession: the live game. It holds the state, applies actions in order,
// and runs the ThrowSim for a throw in real time (update) or all at once
// (runUntilIdle, for tests and headless bots). Local play, the network host and
// network clients all drive the same class.

import { simulateThrow, ThrowSim } from '../sim/physics.ts';
import { applyPlace, applyThrowResult, validateAction } from '../sim/rules.ts';
import { CFG } from '../config.ts';
import type { Action, GameState, Impact } from '../types.ts';

export type SessionEvent =
  | { type: 'throwStart'; action: Action & { type: 'throw' } }
  | { type: 'applied'; action: Action; prev: GameState; state: GameState }
  | { type: 'rejected'; action: Action; reason: string }
  | { type: 'replaced'; state: GameState }
  | { type: 'impact'; impact: Impact };

export class GameSession {
  state: GameState;
  sim: ThrowSim | null = null;
  current: (Action & { type: 'throw' }) | null = null;
  timeScale = 1;
  private queue: Action[] = [];
  private acc = 0;
  private pendingReplace: GameState | null = null;
  private listeners = new Set<(e: SessionEvent) => void>();

  constructor(state: GameState) {
    this.state = state;
  }

  on(fn: (e: SessionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SessionEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  /** True while a throw is in flight or actions are waiting. */
  get busy(): boolean {
    return this.sim !== null || this.queue.length > 0;
  }

  /** The seq the next submitted action will be applied as (counting the throw in flight and the queue). */
  get nextSeq(): number {
    return this.state.seq + (this.sim ? 1 : 0) + this.queue.length;
  }

  /** Apply now if idle, otherwise after the current throw. Returns an error for an action illegal right now. */
  submit(a: Action): string | null {
    if (this.busy) {
      this.queue.push(a);
      return null;
    }
    return this.start(a);
  }

  /** Can this action be applied right now? */
  check(a: Action): string | null {
    if (this.busy) return 'wait for the throw to finish';
    return validateAction(this.state, a);
  }

  private start(a: Action): string | null {
    const err = validateAction(this.state, a);
    if (err) {
      this.emit({ type: 'rejected', action: a, reason: err });
      return err;
    }
    if (a.type === 'throw') {
      this.sim = new ThrowSim(this.state, a.intent);
      this.sim.collectImpacts = true;
      this.current = a;
      this.acc = 0;
      this.emit({ type: 'throwStart', action: a });
    } else {
      const prev = this.state;
      this.state = applyPlace(prev, a);
      this.emit({ type: 'applied', action: a, prev, state: this.state });
    }
    return null;
  }

  /** Advance real time: steps the throw in flight at the physics rate. */
  update(dt: number): void {
    if (this.sim) {
      this.acc += Math.min(dt, 0.1) * this.timeScale;
      const h = CFG.physics.timestep;
      while (this.acc >= h && this.sim && !this.sim.done) {
        this.sim.step();
        this.acc -= h;
      }
      for (const impact of this.sim.drainImpacts()) this.emit({ type: 'impact', impact });
      if (this.sim.done) this.finishThrow();
    }
    this.drain();
  }

  private finishThrow(): void {
    const sim = this.sim!;
    const a = this.current!;
    const result = sim.result();
    sim.free();
    this.sim = null;
    this.current = null;
    const prev = this.state;
    this.state = applyThrowResult(prev, a, result);
    this.emit({ type: 'applied', action: a, prev, state: this.state });
    if (this.pendingReplace) {
      const s = this.pendingReplace;
      this.pendingReplace = null;
      this.replaceState(s);
    }
  }

  private drain(): void {
    while (!this.sim && this.queue.length) this.start(this.queue.shift()!);
  }

  /** Finish everything now, without real time (tests, headless). */
  runUntilIdle(): void {
    for (;;) {
      if (this.sim) {
        this.sim.collectImpacts = false;
        this.sim.run();
        this.finishThrow();
      } else if (this.queue.length) {
        this.start(this.queue.shift()!);
      } else {
        return;
      }
    }
  }

  /** Take an authoritative state (network resync, practice reset). Waits for a throw in flight. */
  replaceState(s: GameState): void {
    if (this.sim) {
      this.pendingReplace = s;
      return;
    }
    this.queue = [];
    this.state = s;
    this.emit({ type: 'replaced', state: s });
  }

  dispose(): void {
    this.sim?.free();
    this.sim = null;
    this.listeners.clear();
  }
}

/** Apply one action to a state headlessly. */
export function applyAction(s: GameState, a: Action): GameState {
  const err = validateAction(s, a);
  if (err) throw new Error(err);
  if (a.type === 'throw') return applyThrowResult(s, a, simulateThrow(s, a.intent));
  return applyPlace(s, a);
}
