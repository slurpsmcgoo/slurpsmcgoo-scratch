// Sound-reactive ambient lighting, drawn over whichever scene is showing
// (key L toggles it):
//   - Fireflies drift around the window, dim when the walk is quiet and
//     brightening and multiplying as people talk and laugh.
//   - A warm, flickering candle glow swells up from the bottom corners with
//     the same chatter.
//   - A sudden loud sound (clap, squeal, shout) sets off a lightning flash with
//     a bolt; gentle mode makes it a soft glow with no bolt.
// Everything is added on top with 'lighter' blending, so black stays black.
// Lightning is a double flash at most once every few seconds, far below the
// three-flashes-a-second limit for photosensitive viewers.

import type { ShowConfig } from '../config.ts';
import type { AudienceState, DirectorContext } from '../types.ts';
import { clamp, fbm1, makeRng, noise1, withAlpha } from './helpers.ts';
import { SoundMood } from './soundMood.ts';

type AmbientConfig = ShowConfig['ambient'];

interface Firefly {
  seed: number;
  x: number;
  y: number;
  wake: number; // liveliness at which this one lights up
}

interface Bolt {
  pts: [number, number][];
  branches: [number, number][][];
}

const FLASH_S = 0.9;

/** Flash brightness over time: two quick strikes, then a fading afterglow. */
function flashCurve(t: number): number {
  if (t < 0 || t > FLASH_S) return 0;
  if (t < 0.06) return t / 0.06;
  if (t < 0.14) return 1 - ((t - 0.06) / 0.08) * 0.75;
  if (t < 0.2) return 0.25 + ((t - 0.14) / 0.06) * 0.55;
  return 0.8 * (1 - (t - 0.2) / (FLASH_S - 0.2)) ** 2;
}

export class AmbientLighting {
  enabled: boolean;
  private mood: SoundMood;
  private t = 0;
  private flashT = Infinity;
  private gentleFlash = false;
  private bolt: Bolt | null = null;
  private flies: Firefly[] = [];
  private sprite: HTMLCanvasElement;
  private glowSprite: HTMLCanvasElement;
  private rng = makeRng(31);
  private on = 0; // fades the whole layer in and out (toggle, audio lost)

  constructor(private cfg: AmbientConfig) {
    this.enabled = cfg.enabled;
    this.mood = new SoundMood(cfg);
    this.sprite = document.createElement('canvas');
    this.glowSprite = document.createElement('canvas');
    this.paintSprites();
    this.makeFlies();
  }

  setConfig(cfg: AmbientConfig): void {
    const countChanged = cfg.fireflyCount !== this.cfg.fireflyCount;
    const colorChanged = cfg.fireflyColor !== this.cfg.fireflyColor || cfg.glowColor !== this.cfg.glowColor;
    this.cfg = cfg;
    this.mood.setConfig(cfg);
    if (countChanged) this.makeFlies();
    if (colorChanged) this.paintSprites();
  }

  /**
   * Pre-renders the firefly (bright core and soft halo) and the candle glow
   * (a quarter disc, drawn scaled and flipped into each bottom corner), so each
   * is one drawImage per frame instead of a fresh gradient.
   */
  private paintSprites(): void {
    const paint = (cv: HTMLCanvasElement, size: number, cx: number, cy: number, color: string, stops: [number, number][]) => {
      cv.width = cv.height = size;
      const g = cv.getContext('2d')!;
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, size / (cx === 0 ? 1 : 2));
      for (const [at, a] of stops) grad.addColorStop(at, withAlpha(color, a));
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
    };
    paint(this.sprite, 64, 32, 32, this.cfg.fireflyColor, [[0, 1], [0.12, 1], [0.2, 0.5], [1, 0]]);
    paint(this.glowSprite, 256, 0, 256, this.cfg.glowColor, [[0, 1], [0.5, 0.35], [1, 0]]);
  }

  get liveliness(): number {
    return this.mood.liveliness;
  }

  private makeFlies(): void {
    this.flies = Array.from({ length: this.cfg.fireflyCount }, (_, i) => ({
      seed: i * 13.7 + this.rng() * 5,
      x: this.rng(),
      y: 0.25 + this.rng() * 0.7,
      wake: i < 3 ? 0 : this.rng() * 0.8, // a few are always awake, the rest need noise
    }));
  }

  private makeBolt(w: number, h: number): Bolt {
    const r = this.rng;
    const pts: [number, number][] = [];
    let x = w * (0.15 + r() * 0.7);
    let y = 0;
    const end = h * (0.45 + r() * 0.25);
    while (y < end) {
      pts.push([x, y]);
      y += h * (0.03 + r() * 0.05);
      x += (r() - 0.5) * w * 0.06;
    }
    pts.push([x, y]);
    const branches: [number, number][][] = [];
    for (let i = 2; i < pts.length - 2; i += 3) {
      if (r() < 0.5) continue;
      let [bx, by] = pts[i]!;
      const dir = r() < 0.5 ? -1 : 1;
      const b: [number, number][] = [[bx, by]];
      for (let k = 0; k < 3; k++) {
        bx += dir * w * (0.015 + r() * 0.03);
        by += h * (0.02 + r() * 0.04);
        b.push([bx, by]);
      }
      branches.push(b);
    }
    return { pts, branches };
  }

  update(dt: number, audience: AudienceState, director: DirectorContext, sceneId: string | null): void {
    this.t += dt;
    this.flashT += dt;
    const audioOk = audience.health.audio === 'ok';
    const active = this.enabled && !(sceneId !== null && this.cfg.skipScenes.includes(sceneId));
    this.on += ((active && audioOk ? 1 : 0) - this.on) * (1 - Math.exp(-dt / 0.5));
    const flash = this.mood.update(dt, audience.audio, audioOk);
    if (flash && active) {
      this.flashT = 0;
      this.gentleFlash = director.intensity === 'gentle';
      this.bolt = this.gentleFlash ? null : this.makeBolt(this.size.width, this.size.height);
    }
  }

  private size = { width: 1920, height: 1080 };

  /** Draws on top of the scene. `ctx` is the logical canvas (w × h). */
  render(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.size = { width: w, height: h };
    if (this.on < 0.01) return;
    const c = this.cfg;
    const live = this.mood.liveliness;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = this.on;

    // Candle glow from the bottom corners, flickering.
    const glow = c.glowStrength * live;
    if (glow > 0.005) {
      for (const side of [0, 1]) {
        const flicker = 0.75 + 0.25 * fbm1(this.t * 6 + side * 40);
        const r = h * (0.55 + 0.25 * live) * flicker;
        ctx.globalAlpha = this.on * clamp(glow * flicker, 0, 1);
        if (side === 0) ctx.drawImage(this.glowSprite, 0, h - r, r, r);
        else {
          ctx.save();
          ctx.translate(w, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(this.glowSprite, 0, h - r, r, r);
          ctx.restore();
        }
      }
    }

    // Fireflies: slow wandering paths, each pulsing on its own rhythm.
    for (const f of this.flies) {
      const awake = clamp((live - f.wake) / 0.2, 0, 1);
      const bright = Math.max(c.fireflyIdle * (f.wake === 0 ? 1 : 0.4), awake);
      const pulse = 0.55 + 0.45 * Math.sin(this.t * (1.3 + (f.seed % 1.1)) + f.seed);
      const a = bright * pulse;
      if (a < 0.02) continue;
      const x = (f.x + 0.08 * noise1(this.t * 0.05 + f.seed) + 0.04 * Math.sin(this.t * 0.3 + f.seed)) * w;
      const y = (f.y + 0.06 * noise1(this.t * 0.04 + f.seed * 2) + 0.03 * Math.cos(this.t * 0.4 + f.seed)) * h;
      const s = c.fireflySize * (1 + live * 0.6);
      ctx.globalAlpha = this.on * a;
      ctx.drawImage(this.sprite, x - s * 2, y - s * 2, s * 4, s * 4);
    }

    // Lightning.
    const fl = flashCurve(this.flashT);
    if (fl > 0.002) {
      const strength = c.flashStrength * (this.gentleFlash ? 0.35 : 1);
      ctx.globalAlpha = this.on;
      ctx.fillStyle = withAlpha(this.gentleFlash ? c.glowColor : c.flashColor, clamp(fl * strength, 0, 1));
      ctx.fillRect(0, 0, w, h);
      if (this.bolt && this.flashT < 0.3) {
        ctx.globalAlpha = this.on * clamp(fl * 1.2, 0, 1);
        ctx.strokeStyle = c.boltColor;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (const [lw, a] of [[18, 0.25], [7, 0.6], [3, 1]] as const) {
          ctx.lineWidth = lw;
          ctx.strokeStyle = withAlpha(c.boltColor, a);
          ctx.beginPath();
          for (const line of [this.bolt.pts, ...this.bolt.branches]) {
            line.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          }
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
}
