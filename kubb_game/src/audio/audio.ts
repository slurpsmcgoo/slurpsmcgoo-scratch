// Synthesised sound. Wood clacks are a few decaying sine partials plus a noise
// click; thuds are low-passed noise. The park adds birds and wind. On the moon
// there's no air to carry sound, so you only hear muffled thumps (as if through
// your boots), your suit's breathing, and radio beeps when the turn changes.

import { CFG } from '../config.ts';
import type { Impact } from '../types.ts';

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private ambience: AudioNode[] = [];
  private birdTimer = 3;
  private surface: 'grass' | 'regolith' | 'sand' = 'grass';
  volume = CFG.audio.master;

  /** Browsers only allow audio after a user gesture: call from one. */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startAmbience();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  setSurface(s: 'grass' | 'regolith' | 'sand'): void {
    if (s === this.surface) return;
    this.surface = s;
    this.startAmbience();
  }

  private noiseSource(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = Math.random();
    return src;
  }

  private startAmbience(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    for (const n of this.ambience) {
      try {
        (n as AudioScheduledSourceNode).stop?.();
      } catch {
        // already stopped
      }
      n.disconnect();
    }
    this.ambience = [];
    const src = this.noiseSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    if (this.surface === 'sand') {
      // Under water: a deep, slow rumble.
      filter.type = 'lowpass';
      filter.frequency.value = 180;
      gain.gain.value = 0.05;
      lfo.frequency.value = 0.12;
      lfoGain.gain.value = 0.03;
    } else if (this.surface === 'regolith') {
      // Suit breathing: band-passed noise swelling every ~4 s.
      filter.type = 'bandpass';
      filter.frequency.value = 900;
      filter.Q.value = 0.7;
      gain.gain.value = 0.012;
      lfo.frequency.value = 0.25;
      lfoGain.gain.value = 0.011;
    } else {
      // Wind through trees.
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      gain.gain.value = 0.03;
      lfo.frequency.value = 0.08;
      lfoGain.gain.value = 0.02;
    }
    lfo.connect(lfoGain).connect(gain.gain);
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    lfo.start();
    this.ambience.push(src, filter, gain, lfo, lfoGain);
  }

  impact(i: Impact): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const loud = Math.min(1, i.strength / 6);
    if (this.surface === 'regolith') {
      this.thump(t, loud * 0.5, 180);
      return;
    }
    if (this.surface === 'sand') {
      // Water carries sound well but dulls the top end.
      this.thump(t, loud * 0.8, i.surface === 'wood' ? 650 : 260);
      return;
    }
    if (i.surface === 'wood') this.clack(t, loud);
    else this.thump(t, loud * 0.7, 380);
  }

  private clack(t: number, loud: number): void {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = 0.55 * loud;
    out.connect(this.master!);
    const base = 700 + Math.random() * 500;
    for (const [mult, amp, decay] of [
      [1, 1, 0.09],
      [2.3, 0.5, 0.05],
      [3.9, 0.3, 0.03],
    ] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = base * mult * (0.97 + Math.random() * 0.06);
      g.gain.setValueAtTime(amp, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + decay + 0.02);
    }
    const n = this.noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 3000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.015);
    n.connect(f).connect(g).connect(out);
    n.start(t);
    n.stop(t + 0.03);
  }

  private thump(t: number, loud: number, cutoff: number): void {
    const ctx = this.ctx!;
    const n = this.noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9 * loud, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    n.connect(f).connect(g).connect(this.master!);
    n.start(t);
    n.stop(t + 0.15);
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.1);
    og.gain.setValueAtTime(0.5 * loud, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(og).connect(this.master!);
    o.start(t);
    o.stop(t + 0.14);
  }

  whoosh(speed: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.surface !== 'grass') return;
    const t = ctx.currentTime;
    const n = this.noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(1600, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12 * Math.min(1, speed / 10), t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    n.connect(f).connect(g).connect(this.master);
    n.start(t);
    n.stop(t + 0.4);
  }

  /** Turn change: a soft chime, Quindar radio tones on the moon, a sonar ping under water. */
  turnChime(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    if (this.surface === 'sand') {
      for (const [delay, vol] of [[0, 0.08], [0.45, 0.03], [0.9, 0.012]] as const) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 1180;
        g.gain.setValueAtTime(0.0001, t + delay);
        g.gain.exponentialRampToValueAtTime(vol, t + delay + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.9);
        o.connect(g).connect(this.master);
        o.start(t + delay);
        o.stop(t + delay + 1);
      }
      return;
    }
    const tones = this.surface === 'regolith' ? [2525] : [784, 1175];
    tones.forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      const start = t + i * 0.12;
      const len = this.surface === 'regolith' ? 0.25 : 0.4;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(this.surface === 'regolith' ? 0.05 : 0.08, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, start + len);
      o.connect(g).connect(this.master!);
      o.start(start);
      o.stop(start + len + 0.05);
    });
  }

  /** Pfsst: a can opening. */
  canCrack(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const click = ctx.createOscillator();
    const cg = ctx.createGain();
    click.frequency.value = 2200;
    cg.gain.setValueAtTime(0.08, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    click.connect(cg).connect(this.master);
    click.start(t);
    click.stop(t + 0.03);
    const n = this.noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 3500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + 0.01);
    g.gain.exponentialRampToValueAtTime(this.surface === 'grass' ? 0.12 : 0.04, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    n.connect(f).connect(g).connect(this.master);
    n.start(t);
    n.stop(t + 0.5);
  }

  cheer(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    [523, 659, 784, 1047].forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + i * 0.1);
      g.gain.exponentialRampToValueAtTime(0.09, t + i * 0.1 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.1 + 0.6);
      o.connect(g).connect(this.master!);
      o.start(t + i * 0.1);
      o.stop(t + i * 0.1 + 0.7);
    });
  }

  update(dt: number): void {
    if (!this.ctx) return;
    if (this.surface === 'sand') {
      this.birdTimer -= dt;
      if (this.birdTimer <= 0) {
        this.birdTimer = 0.6 + Math.random() * 2.5;
        this.bloop();
      }
      return;
    }
    if (this.surface !== 'grass') return;
    this.birdTimer -= dt;
    if (this.birdTimer > 0) return;
    const [lo, hi] = CFG.audio.birdsEveryS;
    this.birdTimer = lo! + Math.random() * (hi! - lo!);
    this.bird();
  }

  /** A bubble rising past: a quick upward sweep. */
  private bloop(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f = 300 + Math.random() * 500;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 2.5, t + 0.06);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.02, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 0.1);
  }

  private bird(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const notes = 2 + Math.floor(Math.random() * 4);
    const base = 2600 + Math.random() * 1600;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 2 - 1;
    pan.connect(this.master!);
    for (let i = 0; i < notes; i++) {
      const s = t + i * (0.09 + Math.random() * 0.05);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.25), s);
      o.frequency.exponentialRampToValueAtTime(base * (1.15 + Math.random() * 0.3), s + 0.06);
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.025, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.07);
      o.connect(g).connect(pan);
      o.start(s);
      o.stop(s + 0.09);
    }
  }
}
