// Loudness, adaptive baseline and shout detection, as pure functions over a
// stream of (time, dB) samples so they can be unit-tested without a microphone.
//
// A shout is a sudden jump: loudness reaches `shoutRiseDb` above the baseline
// and was near the baseline within the last `shoutWindowMs`. Steady noise
// rises slowly (and the baseline follows it), so it never triggers.

import type { ShowConfig } from '../config.ts';

type AudioConfig = ShowConfig['audio'];

/** RMS of a block of samples (-1..1) in dBFS, floored. */
export function rmsDb(samples: Float32Array, floorDb: number): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms > 0 ? Math.max(floorDb, 20 * Math.log10(rms)) : floorDb;
}

export interface LevelUpdate {
  levelDb: number;
  baselineDb: number;
  shoutDb: number | null; // set on the sample where a shout is detected
}

export class LevelTracker {
  private baseline: number | null = null;
  private recent: { t: number; db: number }[] = [];
  private lockoutUntil = -Infinity;
  private lastT: number | null = null;

  constructor(private cfg: AudioConfig) {}

  setConfig(cfg: AudioConfig): void {
    this.cfg = cfg;
  }

  update(tMs: number, db: number): LevelUpdate {
    const c = this.cfg;
    const dt = this.lastT === null ? 0 : Math.max(0, (tMs - this.lastT) / 1000);
    this.lastT = tMs;
    if (this.baseline === null) this.baseline = db;

    this.recent.push({ t: tMs, db });
    while (this.recent.length && this.recent[0]!.t < tMs - c.shoutWindowMs) this.recent.shift();

    const base = this.baseline;
    let shoutDb: number | null = null;
    if (tMs >= this.lockoutUntil && db >= base + c.shoutRiseDb) {
      const quietBefore = this.recent.some((s) => s.db <= base + c.shoutRiseDb / 2);
      if (quietBefore) {
        shoutDb = db;
        this.lockoutUntil = tMs + c.shoutLockoutS * 1000;
      }
    }

    // The baseline adapts slowly; loud moments pull it up ten times slower
    // than quiet ones pull it down, so a crowd talking doesn't hide a shout.
    const loud = db > base + c.shoutRiseDb / 2;
    const tau = c.baselineTimeS * (loud ? 10 : 1);
    if (dt > 0) this.baseline = base + (db - base) * (1 - Math.exp(-dt / tau));

    return { levelDb: db, baselineDb: this.baseline, shoutDb };
  }
}

/**
 * Onset strength for the beat tracker: spectral flux, the average rise in dB
 * across the spectrum since the previous frame (falls count as zero). Kicks,
 * claps, bass notes and hi-hats all register; steady sounds don't. Bins below
 * `bassHz` count double, since the kick drum carries the beat in dance music.
 * `prev` and `cur` are AnalyserNode-style magnitude spectra in dB.
 */
export function spectralFlux(prev: Float32Array, cur: Float32Array, binHz: number, maxHz: number, bassHz: number, floorDb: number): number {
  const n = Math.min(cur.length, prev.length, Math.ceil(maxHz / binHz));
  let sum = 0;
  let weight = 0;
  for (let i = 1; i < n; i++) {
    const w = i * binHz < bassHz ? 2 : 1;
    const d = Math.max(cur[i]!, floorDb) - Math.max(prev[i]!, floorDb);
    if (d > 0) sum += w * d;
    weight += w;
  }
  return weight ? sum / weight : 0;
}
