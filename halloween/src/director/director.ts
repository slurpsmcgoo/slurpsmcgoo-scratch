// The encounter state machine: the one place that decides when to notice,
// engage, scare and cool down. Scenes only decide how each state looks.
//
//   idle ──someone appears──▶ noticed ──close or lingers──▶ engaged
//     ▲                                                       │ at door, shout, or remote
//     │                                                       ▼
//   (walk empty) ◀── cooldown ◀────────scare ends──────────  scare
//                       └──────────people remain──▶ engaged
//
// Any state drops to idle when the walk stays empty for a few seconds, and the
// remote's scare button jumps to scare from any state. Time comes in as an
// argument and randomness through an injected function, so tests are exact.

import type { ShowConfig } from '../config.ts';
import type { AudienceState, DirectorContext, DirectorState, Person, Zone } from '../types.ts';

export interface Transition {
  from: DirectorState;
  to: DirectorState;
  atMs: number;
}

const ZONE_RANK: Record<Zone, number> = { far: 0, mid: 1, near: 2 };
const atLeast = (z: Zone, min: Zone) => ZONE_RANK[z] >= ZONE_RANK[min];

export class Director {
  private state: DirectorState = 'idle';
  private enteredMs = 0;
  private encounterStartMs = 0;
  private emptySinceMs: number | null = null;
  private scareAtMs: number | null = null;
  private scareFromShout = false;
  private focusId: number | null = null;
  private intensity: DirectorContext['intensity'] = 'normal';
  private paused = false;
  private pendingScareNow = false;

  constructor(
    private cfg: ShowConfig['director'],
    private rng: () => number = Math.random,
  ) {}

  setConfig(cfg: ShowConfig['director']): void {
    this.cfg = cfg;
  }

  get context(): DirectorContext {
    return { state: this.state, stateEnteredMs: this.enteredMs, focusPersonId: this.focusId, intensity: this.intensity };
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get scheduledScareMs(): number | null {
    return this.scareAtMs;
  }

  scareNow(): void {
    this.pendingScareNow = true;
  }

  setPaused(on: boolean): void {
    this.paused = on;
  }

  setIntensity(level: DirectorContext['intensity']): void {
    this.intensity = level;
  }

  private cooldownMs(): number {
    const f = this.intensity === 'gentle' ? this.cfg.gentleCooldownFactor : 1;
    return this.cfg.cooldownS * f * 1000;
  }

  private go(to: DirectorState, nowMs: number, out: Transition[]): void {
    if (to === this.state) return;
    out.push({ from: this.state, to, atMs: nowMs });
    this.state = to;
    this.enteredMs = nowMs;
    if (to === 'noticed') this.encounterStartMs = nowMs;
    if (to !== 'engaged') {
      this.scareAtMs = null;
      this.scareFromShout = false;
    }
    if (to === 'idle') this.focusId = null;
  }

  private scheduleScare(nowMs: number, fromShout: boolean): void {
    if (this.scareAtMs !== null) return;
    const { scareDelayMinS: lo, scareDelayMaxS: hi } = this.cfg;
    this.scareAtMs = nowMs + (lo + (hi - lo) * this.rng()) * 1000;
    this.scareFromShout = fromShout;
  }

  /** Keeps attention on one person; switches only when they leave or someone is clearly nearer. */
  private updateFocus(people: Person[], nearest: Person | null): void {
    const current = people.find((p) => p.id === this.focusId);
    if (!current) {
      this.focusId = nearest?.id ?? null;
      return;
    }
    if (nearest && nearest.id !== current.id && nearest.distanceM < current.distanceM - this.cfg.focusSwitchMarginM) {
      this.focusId = nearest.id;
    }
  }

  /**
   * Advances the machine. Call every frame with the latest audience; its
   * events should be present only on the first call after a perception tick.
   */
  update(nowMs: number, a: AudienceState, scareDurationS: number): Transition[] {
    const out: Transition[] = [];
    const present = a.people.length > 0;
    if (present) this.emptySinceMs = null;
    else this.emptySinceMs ??= nowMs;
    const emptyLong = this.emptySinceMs !== null && nowMs - this.emptySinceMs >= this.cfg.emptyResetS * 1000;
    const shout = this.cfg.scareOnShout && a.events.some((e) => e.type === 'shout');
    this.updateFocus(a.people, a.nearest);
    const nearestZone = a.nearest?.zone ?? 'far';

    // Operator override beats everything, including pause.
    if (this.pendingScareNow) {
      this.pendingScareNow = false;
      this.go('scare', nowMs, out);
      return out;
    }

    if (this.paused) {
      if (this.state !== 'scare') this.go('idle', nowMs, out);
      else if (nowMs - this.enteredMs >= scareDurationS * 1000) this.go('idle', nowMs, out);
      return out;
    }

    switch (this.state) {
      case 'idle':
        if (shout) {
          // A shout counts as someone being there, even with no camera.
          this.go('engaged', nowMs, out);
          this.scheduleScare(nowMs, true);
        } else if (present) {
          this.go('noticed', nowMs, out);
        }
        break;

      case 'noticed':
        if (shout) {
          this.go('engaged', nowMs, out);
          this.scheduleScare(nowMs, true);
        } else if (!present && emptyLong) {
          this.go('idle', nowMs, out);
        } else if (present && (atLeast(nearestZone, this.cfg.engageZone) || nowMs - this.encounterStartMs >= this.cfg.lingerS * 1000)) {
          this.go('engaged', nowMs, out);
        }
        break;

      case 'engaged':
        if (emptyLong && !this.scareFromShout) {
          this.go('idle', nowMs, out);
          break;
        }
        if (shout) this.scheduleScare(nowMs, true);
        else if (present && atLeast(nearestZone, this.cfg.scareZone)) this.scheduleScare(nowMs, false);
        if (this.scareAtMs !== null && nowMs >= this.scareAtMs) this.go('scare', nowMs, out);
        break;

      case 'scare':
        if (nowMs - this.enteredMs >= scareDurationS * 1000) this.go('cooldown', nowMs, out);
        break;

      case 'cooldown':
        if (emptyLong) this.go('idle', nowMs, out);
        else if (nowMs - this.enteredMs >= this.cooldownMs()) this.go(present ? 'engaged' : 'idle', nowMs, out);
        break;
    }
    return out;
  }
}
