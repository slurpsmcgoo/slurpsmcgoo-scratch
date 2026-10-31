// Follows the beat of music playing near the microphone, for light shows that
// move in time with it. Pure logic over a stream of (time, onset strength,
// level dB) samples, so it is unit-tested without a microphone.
//
// Onset strength is spectral flux (see audioAnalysis.ts): how much louder the
// spectrum got since the previous sample. It spikes on kicks, claps, bass
// notes and hi-hats alike, so no single hit has to be detected cleanly.
//
// A few times a second, over the last `windowS` seconds of that signal:
//   1. Tempo: autocorrelation. The lag where the signal best matches itself,
//      within [minBpm, maxBpm], is the beat period; how much better it matches
//      there than a sixth of a beat either side is the clarity (0..1). Busy
//      off-beat parts don't move the peak, and swung eighths (two-thirds
//      through the beat, as in a shuffle) don't count against it.
//   2. Phase: the offset at which a comb of beats at that period lines up with
//      the most low-frequency onset energy (kick, bass notes, snare body),
//      weighted toward the most recent beats. Using the low end keeps the clock
//      off the "and", which is mostly hi-hats, claps and piano.
//   3. A beat clock runs at that tempo between analyses and is nudged toward
//      each new estimate, so it keeps time through breaks and fills.
// "Playing" switches on after `confirmS` of clear beat and off only after
// `holdS` without one, so the lights don't flicker in and out.

import type { MusicState } from '../types.ts';
import { NO_MUSIC } from '../world/frame.ts';

export interface BeatConfig {
  minBpm: number;
  maxBpm: number;
  windowS: number;      // seconds of onset signal analyzed
  analyzeEveryMs: number;
  clarityOn: number;    // clarity that counts as a clear beat
  clarityKeep: number;  // lower clarity that keeps "playing" alive once on
  confirmS: number;     // clear beat needed this long before "playing" turns on
  holdS: number;        // keep "playing" this long after the beat goes unclear
  pllGain: number;      // 0..1, how hard each new phase estimate pulls the clock
  leadMs: number;       // report the beat this much early, to cover render and projector delay
  floorDb: number;      // music energy 0 at this level
  fullDb: number;       // music energy 1 at this level
}

const BIN_MS = 10;

/** Removes the slowly varying part of an onset signal (a held chord, a crowd), keeping the rises. */
function rises(x: Float32Array): Float32Array {
  const W = x.length;
  const half = 20;
  const prefix = new Float64Array(W + 1);
  for (let k = 0; k < W; k++) prefix[k + 1] = prefix[k]! + x[k]!;
  const y = new Float32Array(W);
  for (let k = 0; k < W; k++) {
    const a = Math.max(0, k - half);
    const b = Math.min(W, k + half + 1);
    y[k] = Math.max(0, x[k]! - (prefix[b]! - prefix[a]!) / (b - a));
  }
  return y;
}

export class BeatTracker {
  private ring: Float32Array;
  private lowRing: Float32Array;
  private lastBin: number | null = null;
  private nextAnalysisMs = 0;
  private level = -90;

  private periodMs = 500;
  private pendingPeriod: number | null = null;
  private beatT: number | null = null; // time of a beat on the clock
  private beatsAtBeatT = 0;
  private phaseMisses = 0;

  private clearSinceMs: number | null = null;
  private lastClearMs = -Infinity;
  private playing = false;
  /** Latest clarity, 0..1, for the debug overlay. */
  clarity = 0;

  constructor(private cfg: BeatConfig) {
    this.ring = new Float32Array(Math.ceil((cfg.windowS * 1000) / BIN_MS) + 8);
    this.lowRing = new Float32Array(this.ring.length);
  }

  setConfig(cfg: BeatConfig): void {
    const size = Math.ceil((cfg.windowS * 1000) / BIN_MS) + 8;
    if (size !== this.ring.length) {
      this.ring = new Float32Array(size);
      this.lowRing = new Float32Array(size);
      this.lastBin = null;
    }
    this.cfg = cfg;
  }

  /** One analysis sample: onset strength (spectral flux) over the whole spectrum and the low end, and overall level. */
  update(tMs: number, onset: number, lowOnset: number, levelDb: number): void {
    const bin = Math.floor(tMs / BIN_MS);
    const n = this.ring.length;
    if (this.lastBin === null || bin - this.lastBin > n) {
      this.ring.fill(0);
      this.lowRing.fill(0);
      this.lastBin = bin;
    }
    while (this.lastBin < bin) {
      this.lastBin++;
      this.ring[this.lastBin % n] = 0;
      this.lowRing[this.lastBin % n] = 0;
    }
    const i = bin % n;
    this.ring[i] = Math.max(this.ring[i]!, onset);
    this.lowRing[i] = Math.max(this.lowRing[i]!, lowOnset);
    this.level += (levelDb - this.level) * 0.03;

    if (tMs >= this.nextAnalysisMs) {
      this.nextAnalysisMs = tMs + this.cfg.analyzeEveryMs;
      this.analyze(tMs, bin);
    }
  }

  /** The most recent `count` bins of onset signal (oldest first), for the debug overlay. */
  envelope(count: number, ring = this.ring): Float32Array {
    const out = new Float32Array(count);
    if (this.lastBin === null) return out;
    const n = ring.length;
    for (let k = 0; k < count && k < n; k++) out[count - 1 - k] = ring[(((this.lastBin - k) % n) + n) % n]!;
    return out;
  }

  /** Time (ms) of the newest envelope bin. */
  get envelopeEndMs(): number {
    return this.lastBin === null ? 0 : this.lastBin * BIN_MS;
  }

  /** Beat times (ms) on the clock within [fromMs, toMs], for the debug overlay. */
  beatTimes(fromMs: number, toMs: number): number[] {
    if (this.beatT === null || !this.playing) return [];
    const p = this.periodMs;
    const out: number[] = [];
    for (let t = this.beatT + Math.ceil((fromMs - this.beatT) / p) * p; t <= toMs; t += p) out.push(t);
    return out;
  }

  private analyze(tMs: number, bin: number): void {
    const c = this.cfg;
    const W = Math.min(this.ring.length - 8, Math.round((c.windowS * 1000) / BIN_MS));
    const x = this.envelope(W);
    // Need a couple of seconds of signal before judging anything.
    let filled = 0;
    for (const v of x) if (v > 0) filled++;
    if (filled < W * 0.25) return this.judge(tMs, 0);

    const y = rises(x);

    // Autocorrelation over the lags of interest and their doubles.
    const lagMin = Math.floor(60000 / c.maxBpm / BIN_MS);
    const lagMax = Math.ceil(60000 / c.minBpm / BIN_MS);
    const r = new Float32Array(lagMax * 2 + 2);
    for (let L = 0; L < r.length; L++) {
      let s = 0;
      for (let k = L; k < W; k++) s += y[k]! * y[k - L]!;
      r[L] = s / (W - L);
    }
    if (r[0]! <= 0) return this.judge(tMs, 0);
    // A beat can straddle two bins, so look at a lag and its neighbors.
    const rn = (L: number) => Math.max(r[L - 1] ?? 0, r[L]!, r[L + 1] ?? 0) / r[0]!;

    // A real beat also lines up at twice its period; a slight preference for ~120 BPM breaks ties.
    const score = (L: number) => {
      const bpm = 60000 / (L * BIN_MS);
      const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.5) ** 2);
      return (rn(L) + 0.5 * rn(2 * L)) * (0.85 + 0.15 * prior);
    };
    let best = lagMin;
    for (let L = lagMin + 1; L <= lagMax; L++) if (score(L) > score(best)) best = L;
    // Fractional period from the raw autocorrelation around the peak.
    let lag = best;
    {
      const a = r[best - 1]!;
      const b = r[best]!;
      const d = r[best + 1]!;
      const den = a - 2 * b + d;
      if (den < 0) lag = best + Math.max(-0.5, Math.min(0.5, (0.5 * (a - d)) / den));
    }
    // Clarity: how much better the signal matches itself one beat later than a
    // quarter-beat either side. A beat makes a sharp peak; talking and crowd
    // noise are bursty but smooth, matching about equally at every lag.
    const raw = (L: number) => r[Math.max(0, Math.min(r.length - 1, Math.round(L)))]! / r[0]!;
    const clarity = Math.max(0, Math.min(1, rn(best) - 0.5 * (raw(best * (5 / 6)) + raw(best * (7 / 6)))));

    // Phase: where a comb of beats at this period catches the most onset energy,
    // mostly from the low end.
    const low = rises(this.envelope(W, this.lowRing));
    const z = new Float32Array(W);
    for (let k = 0; k < W; k++) z[k] = low[k]! + 0.25 * y[k]!;
    const P = lag;
    let bestPhase = 0;
    let bestSum = -1;
    for (let phi = 0; phi < Math.ceil(P); phi++) {
      let s = 0;
      let w = 1;
      for (let k = 0; ; k++) {
        const idx = W - 1 - phi - Math.round(k * P);
        if (idx < 1) break;
        s += w * (z[idx]! + 0.5 * (z[idx - 1]! + (idx + 1 < W ? z[idx + 1]! : 0)));
        w *= 0.9;
      }
      if (s > bestSum) [bestSum, bestPhase] = [s, phi];
    }
    const lastBeatMs = (bin - bestPhase) * BIN_MS + BIN_MS / 2;

    this.judge(tMs, clarity);
    if (clarity >= c.clarityKeep) {
      this.adoptPeriod(P * BIN_MS);
      this.adoptPhase(lastBeatMs);
    }
  }

  private adoptPeriod(p: number): void {
    if (Math.abs(p - this.periodMs) / this.periodMs < 0.04) {
      this.periodMs += (p - this.periodMs) * 0.3;
      this.pendingPeriod = null;
      return;
    }
    // A big change must show up twice in a row (a new song), not once (a fill).
    if (!this.playing || (this.pendingPeriod !== null && Math.abs(p - this.pendingPeriod) / p < 0.04)) {
      this.periodMs = p;
      this.pendingPeriod = null;
    } else this.pendingPeriod = p;
  }

  private adoptPhase(beatMs: number): void {
    const p = this.periodMs;
    if (this.beatT === null || !this.playing) {
      this.moveClock(beatMs);
      return;
    }
    const k = Math.round((beatMs - this.beatT) / p);
    const predicted = this.beatT + k * p;
    let err = beatMs - predicted;
    if (err > p / 2) err -= p;
    if (err < -p / 2) err += p;
    if (Math.abs(err) > p * 0.2) {
      // Far off: snap only if it happens again (the clock really drifted).
      if (++this.phaseMisses >= 2) {
        this.moveClock(predicted + err);
        this.phaseMisses = 0;
      } else this.moveClock(predicted);
      return;
    }
    this.phaseMisses = 0;
    this.moveClock(predicted + err * this.cfg.pllGain);
  }

  /** Moves the reference beat, keeping the beat count continuous. */
  private moveClock(beatMs: number): void {
    if (this.beatT !== null) this.beatsAtBeatT += Math.round((beatMs - this.beatT) / this.periodMs);
    this.beatT = beatMs;
  }

  private judge(tMs: number, clarity: number): void {
    const c = this.cfg;
    this.clarity = clarity;
    const audible = this.level > c.floorDb;
    if (audible && clarity >= c.clarityOn) {
      this.clearSinceMs ??= tMs;
      this.lastClearMs = tMs;
    } else if (audible && this.playing && clarity >= c.clarityKeep) {
      this.lastClearMs = tMs;
    } else if (clarity < c.clarityKeep) {
      this.clearSinceMs = null;
    }
    if (!this.playing && this.clearSinceMs !== null && tMs - this.clearSinceMs >= c.confirmS * 1000) {
      this.playing = true;
      this.beatsAtBeatT = 0;
    }
    if (this.playing && tMs - this.lastClearMs > c.holdS * 1000) {
      this.playing = false;
      this.clearSinceMs = null;
    }
  }

  /** The beat clock and music level as they should be shown at time `tMs`. */
  state(tMs: number): MusicState {
    const c = this.cfg;
    const bpm = 60000 / this.periodMs;
    if (this.beatT === null || !this.playing) return { ...NO_MUSIC, bpm };
    const pos = (tMs + c.leadMs - this.beatT) / this.periodMs;
    const whole = Math.floor(pos);
    const energy = Math.max(0, Math.min(1, (this.level - c.floorDb) / Math.max(1, c.fullDb - c.floorDb)));
    return { playing: true, bpm, beat: this.beatsAtBeatT + whole, phase: pos - whole, energy };
  }
}
