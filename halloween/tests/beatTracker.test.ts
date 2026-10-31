// The beat tracker on synthesized music, analyzed the way the microphone path
// does it: 1024-sample Blackman-windowed FFT spectra in dB (like an
// AnalyserNode with no smoothing), spectral flux every ~10 ms with timer jitter.

import { describe, expect, it } from 'vitest';
import { BeatTracker } from '../src/sensors/beatTracker.ts';
import { spectralFlux } from '../src/sensors/audioAnalysis.ts';
import { loadConfig, seeded } from './helpers.ts';

const music = { ...loadConfig().music, leadMs: 0 };
const RATE = 24000; // half of 48 kHz with half the FFT size: the same 21 ms window and 47 Hz bins as the microphone path
const FFT = 512;

// ---------------------------------------------------------------- synthesis

interface Song {
  bpm: number;
  seconds: number;
  startS?: number;
}

/** A disco groove: four-on-the-floor kick, claps on 2 and 4, octave bass on the eighths, off-beat hats, a chord pad. */
function disco(out: Float32Array, song: Song, rng: () => number, gain = 0.5): number[] {
  const beat = 60 / song.bpm;
  const t0 = song.startS ?? 0;
  const kicks: number[] = [];
  const add = (startS: number, durS: number, f: (t: number) => number) => {
    const a = Math.max(0, Math.round(startS * RATE));
    const b = Math.min(out.length, Math.round((startS + durS) * RATE));
    for (let i = a; i < b; i++) out[i]! += gain * f(i / RATE - startS);
  };
  // Pad: a held minor chord, gently swelling.
  add(t0, song.seconds, (t) => 0.06 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 261.6 * t) + Math.sin(2 * Math.PI * 329.6 * t)) * (0.8 + 0.2 * Math.sin(t)));
  for (let k = 0; k * beat < song.seconds; k++) {
    const s = t0 + k * beat + (rng() - 0.5) * 0.008; // a human-ish 4 ms of slop
    kicks.push(s * 1000);
    // Kick: a falling sine thump.
    add(s, 0.25, (t) => Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 14));
    // Clap on 2 and 4: a burst of noise.
    if (k % 2 === 1) add(s, 0.12, () => (rng() * 2 - 1) * 0.5);
    // Octave bass: low on the beat, high on the "and".
    const root = [55, 55, 49, 41.2][Math.floor(k / 4) % 4]!;
    add(s, beat / 2 * 0.9, (t) => 0.5 * Math.sign(Math.sin(2 * Math.PI * root * t)) * Math.exp(-t * 6) * 0.6);
    add(s + beat / 2, beat / 2 * 0.9, (t) => 0.5 * Math.sign(Math.sin(2 * Math.PI * root * 2 * t)) * Math.exp(-t * 6) * 0.6);
    // Hi-hat on the off-beat: short bright noise.
    let prev = 0;
    add(s + beat / 2, 0.05, (t) => {
      const n = rng() * 2 - 1;
      const hp = n - prev; // crude high-pass
      prev = n;
      return 0.25 * hp * Math.exp(-t * 60);
    });
  }
  return kicks;
}

/** Talking and laughing: bursts of filtered noise at random times. */
function chatter(out: Float32Array, rng: () => number, gain = 0.3): void {
  let t = 0;
  while (t < out.length / RATE) {
    const dur = 0.08 + rng() * 0.4;
    const pitch = 120 + rng() * 180;
    const a = Math.round(t * RATE);
    for (let i = a; i < Math.min(out.length, a + dur * RATE); i++) {
      const tt = (i - a) / RATE;
      out[i]! += gain * Math.sin(2 * Math.PI * pitch * tt * (1 + 0.1 * Math.sin(tt * 20))) * Math.sin((Math.PI * tt) / dur) * (0.6 + 0.4 * rng());
    }
    t += dur + rng() * 0.5;
  }
}

/**
 * A 1950s/60s novelty-rock shuffle (Monster Mash, Purple People Eater): the
 * eighths swing (the "and" lands two-thirds through the beat), a loud backbeat
 * snare on 2 and 4, a soft kick, a walking bass, boogie piano chords on the
 * swung eighths, and a sung melody. Returns the beat times.
 */
function shuffle(out: Float32Array, song: Song, rng: () => number, gain = 0.5): number[] {
  const beat = 60 / song.bpm;
  const t0 = song.startS ?? 0;
  const beats: number[] = [];
  const add = (startS: number, durS: number, f: (t: number) => number) => {
    const a = Math.max(0, Math.round(startS * RATE));
    const b = Math.min(out.length, Math.round((startS + durS) * RATE));
    for (let i = a; i < b; i++) out[i]! += gain * f(i / RATE - startS);
  };
  const walk = [98, 123.5, 146.8, 164.8, 174.6, 164.8, 146.8, 123.5];
  const melody = [392, 440, 392, 349, 330, 349, 392, 294];
  for (let k = 0; k * beat < song.seconds; k++) {
    const s = t0 + k * beat + (rng() - 0.5) * 0.012;
    beats.push(s * 1000);
    if (k % 2 === 0) add(s, 0.15, (t) => 0.4 * Math.sin(2 * Math.PI * (60 + 60 * Math.exp(-t * 30)) * t) * Math.exp(-t * 20));
    else add(s, 0.18, (t) => (0.7 * (rng() * 2 - 1) + 0.3 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 18));
    const f = walk[k % walk.length]!;
    add(s, beat * 0.95, (t) => 0.45 * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t)) * Math.exp(-t * 5));
    for (const off of [0, (2 / 3) * beat]) {
      let prev = 0;
      add(s + off, 0.04, () => {
        const n = rng() * 2 - 1;
        const hp = n - prev;
        prev = n;
        return 0.18 * hp;
      });
      const root = [196, 196, 261.6, 196][Math.floor(k / 4) % 4]!;
      add(s + off, beat * 0.3, (t) => 0.12 * (Math.sin(2 * Math.PI * root * t) + Math.sin(2 * Math.PI * root * 1.26 * t) + Math.sin(2 * Math.PI * root * 1.5 * t)) * Math.exp(-t * 12));
    }
    if (k % 2 === 0) {
      const m = melody[Math.floor(k / 2) % melody.length]!;
      add(s, beat * 2, (t) => 0.2 * Math.sin(2 * Math.PI * m * t * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t))) * Math.min(1, t * 20) * Math.exp(-t * 0.8));
    }
  }
  return beats;
}

/** An old mono recording: no deep bass, no sparkle (band-pass ~150 Hz to 3.5 kHz). */
function oldRecording(x: Float32Array): void {
  const hp = Math.exp((-2 * Math.PI * 150) / RATE);
  const lp = Math.exp((-2 * Math.PI * 3500) / RATE);
  let low = 0;
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    low = (1 - hp) * x[i]! + hp * low;
    y = (1 - lp) * (x[i]! - low) + lp * y;
    x[i] = y;
  }
}

/** Through a window: muffled (one-pole low-pass), quieter, plus room hiss. */
function throughGlass(x: Float32Array, rng: () => number): void {
  const a = Math.exp((-2 * Math.PI * 700) / RATE);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y = (1 - a) * x[i]! + a * y;
    x[i] = y * 0.3 + (rng() * 2 - 1) * 0.004;
  }
}

// ---------------------------------------------------------------- analysis (like AnalyserNode)

function fftDb(frame: Float32Array): Float32Array {
  const n = frame.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / n) + 0.08 * Math.cos((4 * Math.PI * i) / n); // Blackman
    re[i] = frame[i]! * w;
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2]! * wr - im[i + k + len / 2]! * wi;
        const ai = re[i + k + len / 2]! * wi + im[i + k + len / 2]! * wr;
        re[i + k + len / 2] = re[i + k]! - ar;
        im[i + k + len / 2] = im[i + k]! - ai;
        re[i + k] = re[i + k]! + ar;
        im[i + k] = im[i + k]! + ai;
      }
    }
  }
  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) out[i] = 20 * Math.log10(Math.hypot(re[i]!, im[i]!) / n + 1e-12);
  return out;
}

/** Runs the tracker over audio, sampling every ~10 ms with timer jitter. Calls `probe` after each sample. */
function listen(b: BeatTracker, audio: Float32Array, rng: () => number, probe?: (tMs: number) => void): void {
  let prev: Float32Array = new Float32Array(FFT / 2).fill(-200);
  for (let t = 25; t < (audio.length / RATE) * 1000; t += 10 + (rng() - 0.5) * 6) {
    const end = Math.round((t / 1000) * RATE);
    if (end < FFT) continue;
    const frame = audio.subarray(end - FFT, end);
    const spec = fftDb(frame);
    let sq = 0;
    for (const v of frame) sq += v * v;
    const levelDb = 10 * Math.log10(sq / FFT + 1e-12);
    b.update(
      t,
      spectralFlux(prev, spec, RATE / FFT, music.fluxMaxHz, music.fluxBassHz, music.fluxFloorDb),
      spectralFlux(prev, spec, RATE / FFT, music.fluxLowMaxHz, 0, music.fluxFloorDb),
      levelDb,
    );
    prev = spec;
    probe?.(t);
  }
}

const offBeat = (phase: number) => Math.min(phase, 1 - phase);

// ---------------------------------------------------------------- tests

describe('BeatTracker on synthesized music', () => {
  it('locks onto a YMCA-tempo disco groove and stays on the kick', () => {
    const rng = seeded(1);
    const audio = new Float32Array(RATE * 20);
    const kicks = disco(audio, { bpm: 127, seconds: 20 }, rng);
    const b = new BeatTracker(music);
    let lockedAt: number | null = null;
    listen(b, audio, rng, (t) => {
      if (lockedAt === null && b.state(t).playing) lockedAt = t;
    });
    expect(lockedAt).not.toBeNull();
    expect(lockedAt!).toBeLessThan(6000);
    const end = kicks.findLast((k) => k < 19_500)!;
    const s = b.state(end);
    expect(Math.abs(s.bpm - 127)).toBeLessThan(1.5);
    expect(offBeat(s.phase)).toBeLessThan(0.08); // within ~40 ms of the kick
  });

  it('stays locked for the whole song, with no dropouts (the lights must not flicker in and out)', () => {
    const rng = seeded(2);
    const audio = new Float32Array(RATE * 40);
    disco(audio, { bpm: 127, seconds: 40 }, rng);
    const b = new BeatTracker(music);
    let locked = false;
    let drops = 0;
    listen(b, audio, rng, (t) => {
      const p = b.state(t).playing;
      if (locked && !p) drops++;
      locked ||= p;
    });
    expect(locked).toBe(true);
    expect(drops).toBe(0);
  });

  it('still works heard through a window, with people chattering on the walk', () => {
    const rng = seeded(3);
    const audio = new Float32Array(RATE * 25);
    const kicks = disco(audio, { bpm: 127, seconds: 25 }, rng);
    chatter(audio, rng, 0.4);
    throughGlass(audio, rng);
    const b = new BeatTracker(music);
    let locked = false;
    let drops = 0;
    listen(b, audio, rng, (t) => {
      const p = b.state(t).playing;
      if (locked && !p) drops++;
      locked ||= p;
    });
    expect(locked).toBe(true);
    expect(drops).toBe(0);
    const s = b.state(kicks.findLast((k) => k < 24_500)!);
    expect(Math.abs(s.bpm - 127)).toBeLessThan(2);
    expect(offBeat(s.phase)).toBeLessThan(0.1);
  });

  // Monster Mash and Purple People Eater: swung eighths, backbeat snare, walking bass, an old mono sound.
  for (const [name, bpm, glass] of [
    ['a clean Monster Mash-style shuffle', 137, false],
    ['a Purple People Eater-style shuffle through a window, with chatter', 128, true],
    ['a Monster Mash-style shuffle through a window, with chatter', 137, true],
    ['a fast shuffle through a window, with chatter', 150, true],
  ] as const) {
    it(`locks onto ${name} without dropping out`, () => {
      const rng = seeded(bpm + (glass ? 1 : 0));
      const audio = new Float32Array(RATE * 30);
      const beats = shuffle(audio, { bpm, seconds: 30 }, rng);
      oldRecording(audio);
      if (glass) {
        chatter(audio, rng, 0.4);
        throughGlass(audio, rng);
      }
      const b = new BeatTracker(music);
      let lockedAt: number | null = null;
      let drops = 0;
      listen(b, audio, rng, (t) => {
        const p = b.state(t).playing;
        if (lockedAt !== null && !p) drops++;
        if (lockedAt === null && p) lockedAt = t;
      });
      expect(lockedAt).not.toBeNull();
      expect(lockedAt!).toBeLessThan(8000);
      expect(drops).toBe(0);
      const s = b.state(beats.findLast((k) => k < 29_500)!);
      expect(Math.abs(s.bpm - bpm)).toBeLessThan(2);
      expect(offBeat(s.phase)).toBeLessThan(0.1); // on the beat, not the swung "and"
    });
  }

  it('follows a change of song to a new tempo', () => {
    const rng = seeded(4);
    const audio = new Float32Array(RATE * 30);
    disco(audio, { bpm: 110, seconds: 14 }, rng);
    const kicks = disco(audio, { bpm: 128, seconds: 16, startS: 14 }, rng);
    const b = new BeatTracker(music);
    listen(b, audio, rng);
    const s = b.state(kicks.findLast((k) => k < 29_500)!);
    expect(s.playing).toBe(true);
    expect(Math.abs(s.bpm - 128)).toBeLessThan(2);
    expect(offBeat(s.phase)).toBeLessThan(0.1);
  });

  it('does not hear a beat in chatter alone, or in silence', () => {
    const rng = seeded(5);
    const talk = new Float32Array(RATE * 20);
    chatter(talk, rng, 0.4);
    const b = new BeatTracker(music);
    let ever = false;
    listen(b, talk, rng, (t) => (ever ||= b.state(t).playing));
    expect(ever).toBe(false);

    const quiet = new Float32Array(RATE * 10);
    for (let i = 0; i < quiet.length; i++) quiet[i] = (rng() * 2 - 1) * 0.002;
    const q = new BeatTracker(music);
    listen(q, quiet, rng);
    expect(q.state(10_000).playing).toBe(false);
  });

  it('lets go a few seconds after the music stops, and counts beats up from the start', () => {
    const rng = seeded(6);
    const audio = new Float32Array(RATE * 25);
    disco(audio, { bpm: 120, seconds: 12 }, rng);
    const b = new BeatTracker(music);
    let firstBeat: number | null = null;
    listen(b, audio, rng, (t) => {
      const s = b.state(t);
      if (s.playing && firstBeat === null) firstBeat = s.beat;
    });
    expect(firstBeat).not.toBeNull();
    expect(firstBeat!).toBeLessThanOrEqual(1);
    expect(b.state(25_000).playing).toBe(false);
  });

  it('reports the beat leadMs early, to cover render and projector delay', () => {
    const rng = seeded(7);
    const audio = new Float32Array(RATE * 12);
    const kicks = disco(audio, { bpm: 120, seconds: 12 }, rng);
    const plain = new BeatTracker(music);
    const lead = new BeatTracker({ ...music, leadMs: 100 });
    listen(plain, audio, seeded(9));
    listen(lead, audio, seeded(9));
    const k = kicks.findLast((x) => x < 11_500)!;
    const d = lead.state(k).phase - plain.state(k).phase;
    expect(((d % 1) + 1) % 1).toBeCloseTo(100 / 500, 1);
  });
});
