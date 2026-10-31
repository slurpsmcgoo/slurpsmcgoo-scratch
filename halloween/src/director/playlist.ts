// The show layer: which scene is on. Rotates through the playlist while the
// walk is empty, obeys operator commands, skips scenes whose required sensors
// are down, and never picks a scene that crashed earlier in the night.

import type { ShowConfig } from '../config.ts';
import type { DirectorState, SceneRequirements, SensorHealth } from '../types.ts';

export interface SceneInfo {
  id: string;
  requires: SceneRequirements;
}

export const FALLBACK_SCENE = 'shadowWalker';

export function isEligible(req: SceneRequirements, health: SensorHealth): boolean {
  if ((req.camera || req.pose) && health.camera !== 'ok') return false;
  if (req.audio && health.audio !== 'ok') return false;
  return true;
}

export class Playlist {
  private active: string | null = null;
  private activeSinceMs = 0;
  private disabled = new Set<string>();
  private byId: Map<string, SceneInfo>;

  constructor(
    scenes: SceneInfo[],
    private cfg: ShowConfig['show'],
  ) {
    this.byId = new Map(scenes.map((s) => [s.id, s]));
  }

  setConfig(cfg: ShowConfig['show']): void {
    this.cfg = cfg;
  }

  get activeId(): string | null {
    return this.active;
  }

  get disabledIds(): string[] {
    return [...this.disabled];
  }

  /** Playlist order, limited to scenes that exist. */
  private order(): string[] {
    const list = this.cfg.playlist.filter((id) => this.byId.has(id));
    return list.length ? list : [...this.byId.keys()];
  }

  eligible(health: SensorHealth): string[] {
    return this.order().filter((id) => !this.disabled.has(id) && isEligible(this.byId.get(id)!.requires, health));
  }

  private bestFallback(health: SensorHealth, after: string | null): string | null {
    const el = this.eligible(health);
    if (el.length === 0) return this.disabled.has(FALLBACK_SCENE) || !this.byId.has(FALLBACK_SCENE) ? null : FALLBACK_SCENE;
    if (after === null) return el[0]!;
    const order = this.order();
    const start = order.indexOf(after);
    for (let i = 1; i <= order.length; i++) {
      const id = order[(start + i) % order.length]!;
      if (el.includes(id)) return id;
    }
    return el[0]!;
  }

  private set(id: string | null, nowMs: number): string | null {
    if (id === this.active) return null;
    this.active = id;
    this.activeSinceMs = nowMs;
    return id;
  }

  /** Returns the new scene id if the active scene should change, else null. */
  update(nowMs: number, health: SensorHealth, state: DirectorState, walkEmpty: boolean): string | null {
    if (this.active === null) {
      const start = this.cfg.startScene;
      const pick = !this.disabled.has(start) && this.byId.has(start) && isEligible(this.byId.get(start)!.requires, health)
        ? start
        : this.bestFallback(health, null);
      return pick === null ? null : this.set(pick, nowMs);
    }
    const current = this.byId.get(this.active);
    if (!current || this.disabled.has(this.active) || !isEligible(current.requires, health)) {
      const next = this.bestFallback(health, this.active);
      if (next !== this.active) return this.set(next, nowMs) ?? null;
      return null;
    }
    // On a fallback scene that isn't in the playlist (the camera dropped out of
    // a one-scene show): go back as soon as a playlist scene can run again.
    if (!this.order().includes(this.active)) {
      const back = this.bestFallback(health, null);
      if (back !== null && back !== this.active && this.order().includes(back)) return this.set(back, nowMs);
    }
    // rotateEveryS 0 keeps the current scene until the operator changes it.
    const rotate = this.cfg.rotateEveryS > 0 && nowMs - this.activeSinceMs >= this.cfg.rotateEveryS * 1000;
    if (rotate && state === 'idle' && walkEmpty) {
      const next = this.bestFallback(health, this.active);
      this.activeSinceMs = nowMs;
      if (next && next !== this.active) return this.set(next, nowMs);
    }
    return null;
  }

  step(direction: 1 | -1, nowMs: number, health: SensorHealth): string | null {
    const el = this.eligible(health);
    if (el.length === 0) return null;
    const i = this.active ? el.indexOf(this.active) : -1;
    const next = el[(i + direction + el.length) % el.length]!;
    return this.set(next, nowMs);
  }

  choose(id: string, nowMs: number, health: SensorHealth): string | null {
    if (!this.eligible(health).includes(id)) return null;
    return this.set(id, nowMs);
  }

  /** A scene that throws is disabled for the rest of the night. */
  disable(id: string): void {
    this.disabled.add(id);
  }
}
