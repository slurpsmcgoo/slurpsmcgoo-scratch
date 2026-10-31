// Runs the active scene with isolation and crossfades. Each scene's update and
// render run inside try/catch; a scene that throws is reported and the show
// moves on. Scene changes fade out to black, swap, then fade back in.

import type { AudienceState, DirectorContext, DirectorState, Scene, SceneContext } from '../types.ts';


export class SceneRunner {
  readonly canvas = document.createElement('canvas');
  /** The logical canvas's context, for layers drawn over the scene (ambient lighting). */
  readonly ctx: CanvasRenderingContext2D;
  private scenes = new Map<string, { scene: Scene; sc: SceneContext; ready: boolean; failed: boolean }>();
  private activeId: string | null = null;
  private pendingId: string | null = null;
  private fade = 1;        // 0 = black, 1 = fully visible
  private fadingOut = false;

  constructor(
    private onSceneError: (id: string, err: unknown) => void,
    size: { width: number; height: number },
  ) {
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
  }

  /**
   * Changes the logical canvas size (landscape ↔ portrait). Every scene is
   * initialized again for the new size; scenes keep nothing else between.
   */
  setSize(size: { width: number; height: number }): void {
    if (size.width === this.canvas.width && size.height === this.canvas.height) return;
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    for (const entry of this.scenes.values()) {
      if (entry.failed) continue;
      entry.sc.width = size.width;
      entry.sc.height = size.height;
      entry.ready = false;
      entry.scene.init(entry.sc).then(
        () => (entry.ready = true),
        (err) => {
          entry.failed = true;
          this.onSceneError(entry.scene.id, err);
        },
      );
    }
  }

  get active(): Scene | null {
    return this.activeId ? this.scenes.get(this.activeId)?.scene ?? null : null;
  }

  get list(): Scene[] {
    return [...this.scenes.values()].map((s) => s.scene);
  }

  async register(scene: Scene, config: Record<string, unknown>): Promise<void> {
    const sc: SceneContext = { ctx: this.ctx, width: this.canvas.width, height: this.canvas.height, config: { ...config } };
    const entry = { scene, sc, ready: false, failed: false };
    this.scenes.set(scene.id, entry);
    try {
      await scene.init(sc);
      entry.ready = true;
    } catch (err) {
      entry.failed = true;
      this.onSceneError(scene.id, err);
    }
  }

  /**
   * Applies a reloaded show.json. The config object is updated in place, so
   * scenes that kept a reference to it see new values on their next frame.
   */
  setSceneConfigs(sections: Record<string, Record<string, unknown>>): void {
    for (const [id, entry] of this.scenes) {
      const next = sections[id] ?? {};
      for (const k of Object.keys(entry.sc.config)) delete entry.sc.config[k];
      Object.assign(entry.sc.config, next);
      if (typeof next.scareDurationS === 'number') entry.scene.scareDurationS = next.scareDurationS;
    }
  }

  /** Starts a crossfade through black to `id` (null shows black). */
  switchTo(id: string | null, immediate = false): void {
    if (id === this.activeId && !this.fadingOut) return;
    if (immediate || this.activeId === null) {
      this.activeId = id;
      this.pendingId = null;
      this.fadingOut = false;
      this.fade = immediate ? 1 : 0;
      return;
    }
    this.pendingId = id;
    this.fadingOut = true;
  }

  get switching(): boolean {
    return this.fadingOut;
  }

  notifyStateChange(from: DirectorState, to: DirectorState, director: DirectorContext): void {
    const entry = this.activeId ? this.scenes.get(this.activeId) : undefined;
    if (!entry?.ready || entry.failed || !entry.scene.onStateChange) return;
    try {
      entry.scene.onStateChange(from, to, director);
    } catch (err) {
      entry.failed = true;
      this.onSceneError(entry.scene.id, err);
    }
  }

  frame(dt: number, audience: AudienceState, director: DirectorContext, crossfadeS: number, brightness: number): void {
    const half = Math.max(0.01, crossfadeS / 2);
    if (this.fadingOut) {
      this.fade -= dt / half;
      if (this.fade <= 0) {
        this.fade = 0;
        this.fadingOut = false;
        this.activeId = this.pendingId;
        this.pendingId = null;
        // The new scene joins mid-encounter in whatever state the director is in.
        if (director.state !== 'idle') this.notifyStateChange('idle', director.state, director);
      }
    } else if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / half);
    }

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const entry = this.activeId ? this.scenes.get(this.activeId) : undefined;
    // A scene that threw once is never called again; the show moves on without it.
    if (entry?.ready && !entry.failed) {
      try {
        entry.scene.update(dt, audience, director);
        ctx.save();
        entry.scene.render(entry.sc);
        ctx.restore();
      } catch (err) {
        ctx.restore();
        entry.failed = true;
        this.onSceneError(entry.scene.id, err);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }

    const level = this.fade * brightness;
    if (level < 1) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1 - level;
      ctx.filter = 'none';
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalAlpha = 1;
    }
  }
}
