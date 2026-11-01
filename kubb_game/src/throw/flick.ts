// Reads a flick gesture: press, pull back (down the screen), push forward (up)
// and let go. The forward speed over the last few tens of milliseconds sets the
// power; sideways speed bends the direction. Works the same for mouse,
// trackpad and touch, because it only sees pointer positions and times.

import { CFG } from '../config.ts';

export interface FlickResult {
  /** Forward speed at release, in screen heights per second. */
  forward: number;
  /** Sideways speed at release (+ = right), in screen heights per second. */
  lateral: number;
  /** Did the pointer go back far enough first to count as a throw? */
  pulledBack: boolean;
}

interface Sample {
  x: number;
  y: number;
  t: number;
}

export class FlickTracker {
  private samples: Sample[] = [];
  private startY = 0;
  private maxBack = 0;
  active = false;

  constructor(private screenHeight: number) {}

  begin(x: number, y: number, t: number, screenHeight = this.screenHeight): void {
    this.screenHeight = screenHeight;
    this.samples = [{ x, y, t }];
    this.startY = y;
    this.maxBack = 0;
    this.active = true;
  }

  move(x: number, y: number, t: number): void {
    if (!this.active) return;
    this.samples.push({ x, y, t });
    this.maxBack = Math.max(this.maxBack, y - this.startY);
    const cutoff = t - 400;
    while (this.samples.length > 2 && this.samples[0]!.t < cutoff) this.samples.shift();
  }

  /** How far back the pointer is now, 0..1 of a third of the screen (for the wind-up animation). */
  pull(): number {
    const last = this.samples[this.samples.length - 1];
    if (!last) return 0;
    return Math.max(0, Math.min(1, (last.y - this.startY) / (this.screenHeight / 3)));
  }

  /** The furthest the pointer went back, 0..1 of `fullAt` screen heights (spin from wind-up). */
  maxPull(fullAt: number): number {
    return Math.max(0, Math.min(1, this.maxBack / (this.screenHeight * fullAt)));
  }

  /** Current forward speed estimate, for the live power readout. */
  current(t: number): FlickResult {
    return this.estimate(t);
  }

  end(t: number): FlickResult {
    const r = this.estimate(t);
    this.active = false;
    return r;
  }

  private estimate(t: number): FlickResult {
    const win = CFG.throw.flick.windowMs;
    const recent = this.samples.filter((s) => s.t >= t - win);
    const pts = recent.length >= 2 ? recent : this.samples.slice(-2);
    const pulledBack = this.maxBack >= CFG.throw.flick.minPullBackPx;
    if (pts.length < 2) return { forward: 0, lateral: 0, pulledBack };
    // Least-squares slope of position over time: steadier than first-to-last.
    const n = pts.length;
    let mt = 0;
    let mx = 0;
    let my = 0;
    for (const s of pts) {
      mt += s.t / n;
      mx += s.x / n;
      my += s.y / n;
    }
    let stt = 0;
    let stx = 0;
    let sty = 0;
    for (const s of pts) {
      const dt = s.t - mt;
      stt += dt * dt;
      stx += dt * (s.x - mx);
      sty += dt * (s.y - my);
    }
    if (stt < 1e-6) return { forward: 0, lateral: 0, pulledBack };
    const h = this.screenHeight || 1;
    const vx = ((stx / stt) * 1000) / h;
    const vy = ((sty / stt) * 1000) / h;
    return { forward: Math.max(0, -vy), lateral: vx, pulledBack };
  }
}

/** Throw speed (m/s) for a flick's forward speed; `scale` is the setting's speedScale. */
export function flickSpeed(forward: number, scale = 1): number {
  return Math.min(CFG.throw.maxSpeed * scale, forward * CFG.throw.flick.gain * scale);
}

/** Direction change (radians, + = right) for a flick's sideways speed. */
export function flickBend(f: FlickResult): number {
  if (f.forward <= 0) return 0;
  const max = (CFG.throw.flick.maxLateralDeg * Math.PI) / 180;
  const a = Math.atan2(f.lateral, f.forward) * CFG.throw.flick.lateralGain;
  return Math.max(-max, Math.min(max, a));
}
