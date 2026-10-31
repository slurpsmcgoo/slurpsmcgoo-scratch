// A disco ball and a laser show that move to the music on the porch. Drawn
// before (behind) the creatures, so the characters always stay clean on top.
//
// Time comes only from update(dt) and the beat clock in MusicState: the beams
// step, sweep and pulse on the beat, and change pattern every few bars. With
// no music the lasers fade out and the ball just turns slowly.
//
// Every beat is a hit: beams snap to their next position right on the beat and
// hold there, flash bright and fat, then dim until the next one; the first beat
// of each bar hits hardest. Brightness never switches fully off and on, so
// there is no strobing.

import type { MusicState } from '../../types.ts';
import { approach, clamp, easeOutCubic, withAlpha } from '../../render/helpers.ts';

export interface DiscoOptions {
  ballX: number;
  ballY: number;
  ballRadius: number;
  ballIdle: number;        // ball brightness with no music, 0..1
  colors: string[];
  patternBars: number;     // change laser pattern every this many bars
  beamWidth: number;
  beamAlpha: number;
  reflections: number;
  reflectionAlpha: number;
}

type Beam = { x: number; y: number; a: number; color: string }; // a: radians from straight down, + toward screen right

const TAU = Math.PI * 2;
/** Deterministic 0..1 hash, so patterns are the same for the same beat. */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export class DiscoLights {
  /** Continuous beat position (beats since the music started); drives the dancer too. */
  pos = 0;
  /** 0..1, how much the show is "on": follows music presence and loudness. */
  level = 0;
  private bpm = 120;
  private lastMusic: MusicState | null = null;
  private rot = 0;
  private synced = false;

  get playing(): boolean {
    return this.level > 0.15;
  }

  update(dt: number, music: MusicState): void {
    this.bpm = music.bpm;
    this.level = approach(this.level, music.playing ? Math.max(0.45, music.energy) : 0, dt, 0.6);
    this.pos += dt * (this.bpm / 60);
    if (music !== this.lastMusic) {
      // A new tick: pull our smooth clock toward the tracker's beat clock.
      this.lastMusic = music;
      if (music.playing) {
        const target = music.beat + music.phase;
        const err = target - this.pos;
        if (!this.synced || Math.abs(err) > 1.5) this.pos = target;
        else this.pos += err * 0.35;
        this.synced = true;
      } else this.synced = false;
    }
    this.rot += dt * (0.25 + 0.6 * this.level);
  }

  render(ctx: CanvasRenderingContext2D, w: number, h: number, o: DiscoOptions): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const beat = Math.floor(this.pos);
    const ph = this.pos - beat;
    const kick = (1 - ph) ** 3;
    const downbeat = ((beat % 4) + 4) % 4 === 0 ? 1 : 0;
    const bar = Math.floor(this.pos / 4);
    // The beat clock can sit just before zero right after it locks, so wrap
    // negative bars too; fall back to white if no colors are configured.
    const pick = (i: number) => (o.colors.length ? o.colors[((i % o.colors.length) + o.colors.length) % o.colors.length]! : '#ffffff');
    const colorA = pick(bar);
    const colorB = pick(bar + 2);

    if (this.level > 0.01) {
      this.drawReflections(ctx, w, h, o, colorA);
      const hit = kick * (0.75 + 0.25 * downbeat);
      const intensity = this.level * (0.3 + 0.7 * hit);
      for (const b of this.beams(w, o, colorA, colorB)) this.drawBeam(ctx, b, w, h, o, intensity, 1 + 1.2 * hit);
    }
    this.drawBall(ctx, o, beat, ph);
    ctx.restore();
  }

  private beams(w: number, o: DiscoOptions, cA: string, cB: string): Beam[] {
    const pos = this.pos;
    const beat = Math.floor(pos);
    const ph = pos - beat;
    const section = Math.floor(pos / (4 * o.patternBars));
    const pattern = Math.floor(hash(section) * 5);
    const L = { x: 60, y: 30 };
    const R = { x: w - 60, y: 30 };
    const out: Beam[] = [];
    // Positions advance in steps: a quick snap at each beat, then hold.
    const step = beat + easeOutCubic(clamp(ph / 0.18, 0, 1));
    const swing = Math.sin((step * Math.PI) / 2); // one full swing every 4 beats
    switch (pattern) {
      case 0: { // fans sweeping in from both top corners
        for (let i = 0; i < 4; i++) {
          const spread = (i - 1.5) * 0.14;
          out.push({ ...L, a: 0.75 + 0.35 * swing + spread, color: i % 2 ? cA : cB });
          out.push({ ...R, a: -(0.75 + 0.35 * swing) + spread, color: i % 2 ? cB : cA });
        }
        break;
      }
      case 1: { // scissors: the two corners cross and uncross
        for (let i = 0; i < 3; i++) {
          const spread = (i - 1) * 0.06;
          out.push({ ...L, a: 0.65 + 0.45 * swing + spread, color: cA });
          out.push({ ...R, a: -(0.65 - 0.45 * swing) + spread, color: cB });
        }
        break;
      }
      case 2: { // spokes from the ball, clicking round a notch on every beat
        const step = (beat + easeOutCubic(clamp(ph / 0.3, 0, 1))) * (Math.PI / 8);
        for (let i = 0; i < 8; i++) out.push({ x: o.ballX, y: o.ballY, a: step + (i * TAU) / 8, color: i % 2 ? cA : cB });
        break;
      }
      case 3: { // hits: every beat the beams jump to a new pose
        const k = easeOutCubic(clamp(ph / 0.25, 0, 1));
        for (let i = 0; i < 3; i++) {
          const prev = (hash((beat - 1) * 7 + i) - 0.5) * 1.1;
          const next = (hash(beat * 7 + i) - 0.5) * 1.1;
          const a = prev + (next - prev) * k;
          out.push({ ...L, a: 0.7 + a, color: cA });
          out.push({ ...R, a: -0.7 - a, color: cB });
        }
        break;
      }
      default: { // a curtain of beams along the top, rippling
        for (let i = 0; i < 8; i++) {
          const x = w * (0.08 + (i * 0.84) / 7);
          out.push({ x, y: 0, a: 0.4 * Math.sin((step * Math.PI) / 2 + i * 0.7), color: i % 2 ? cA : cB });
        }
      }
    }
    return out;
  }

  private drawBeam(ctx: CanvasRenderingContext2D, b: Beam, w: number, h: number, o: DiscoOptions, intensity: number, fat: number): void {
    const len = Math.hypot(w, h);
    const dx = Math.sin(b.a);
    const dy = Math.cos(b.a);
    const ex = b.x + dx * len;
    const ey = b.y + dy * len;
    // Haze: a thin cone widening away from the emitter.
    const spread = o.beamWidth * 5;
    ctx.fillStyle = withAlpha(b.color, clamp(o.beamAlpha * 0.12 * intensity, 0, 1));
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(ex - dy * spread, ey + dx * spread);
    ctx.lineTo(ex + dy * spread, ey - dx * spread);
    ctx.closePath();
    ctx.fill();
    ctx.lineCap = 'round';
    for (const [lw, a] of [[o.beamWidth * 3 * fat, 0.22], [o.beamWidth * fat, 0.9]] as const) {
      ctx.strokeStyle = withAlpha(b.color, clamp(o.beamAlpha * a * intensity, 0, 1));
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }
  }

  /** Spots of light thrown off the ball, drifting across the window as it turns. */
  private drawReflections(ctx: CanvasRenderingContext2D, w: number, h: number, o: DiscoOptions, color: string): void {
    for (let i = 0; i < o.reflections; i++) {
      const lon = hash(i + 0.5) * TAU + this.rot;
      const facing = Math.cos(lon);
      if (facing <= 0) continue;
      const x = w / 2 + Math.sin(lon) * w * 0.62;
      const y = h * (0.12 + 0.8 * hash(i + 99.5));
      const tint = i % 3 === 0 ? color : '#ffffff';
      ctx.fillStyle = withAlpha(tint, clamp(o.reflectionAlpha * this.level * facing, 0, 1));
      ctx.beginPath();
      ctx.ellipse(x, y, 7 * (0.4 + 0.6 * facing), 7, 0, 0, TAU);
      ctx.fill();
    }
  }

  private drawBall(ctx: CanvasRenderingContext2D, o: DiscoOptions, beat: number, ph: number): void {
    const { ballX: cx, ballY: cy, ballRadius: r } = o;
    const bright = Math.max(o.ballIdle, this.level);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = withAlpha('#9a9aa8', bright);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, cy - r);
    ctx.stroke();
    ctx.fillStyle = '#26262e';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();

    // Mirror tiles, batched by shade.
    const shades: Path2D[] = Array.from({ length: 5 }, () => new Path2D());
    const sparkles: [number, number][] = [];
    const rows = 13;
    const dLat = Math.PI / rows;
    for (let i = 0; i < rows; i++) {
      const lat = -Math.PI / 2 + (i + 0.5) * dLat;
      const cl = Math.cos(lat);
      const count = Math.max(4, Math.round(26 * cl));
      const dLon = TAU / count;
      for (let j = 0; j < count; j++) {
        const lon = j * dLon + this.rot;
        const facing = Math.cos(lon);
        if (facing <= 0.05) continue;
        const x = cx + r * cl * Math.sin(lon);
        const y = cy + r * Math.sin(lat);
        const tw = r * cl * dLon * facing * 0.86;
        const th = r * dLat * 0.86;
        // Lit from the upper left, plus each facet's own random tilt.
        const light = 0.5 * (0.5 - 0.5 * Math.sin(lon) - 0.5 * Math.sin(lat)) + 0.5 * hash(i * 61 + j);
        shades[clamp(Math.floor(light * 5), 0, 4)]!.rect(x - tw / 2, y - th / 2, tw, th);
        if (hash(i * 61 + j + beat * 13) > 0.985) sparkles.push([x, y]);
      }
    }
    shades.forEach((p, k) => {
      const v = Math.round((0.3 + k * 0.17) * 255 * (0.5 + 0.5 * bright));
      ctx.fillStyle = `rgb(${v},${v},${Math.min(255, v + 10)})`;
      ctx.fill(p);
    });

    // Glints on the beat.
    const glint = this.level * (1 - ph) ** 2;
    if (glint > 0.02 && sparkles.length) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = withAlpha('#ffffff', clamp(glint, 0, 1));
      ctx.lineWidth = 2;
      ctx.beginPath();
      const s = r * 0.35 * (0.6 + 0.4 * glint);
      for (const [x, y] of sparkles) {
        ctx.moveTo(x - s, y);
        ctx.lineTo(x + s, y);
        ctx.moveTo(x, y - s);
        ctx.lineTo(x, y + s);
      }
      ctx.stroke();
    }
  }
}
