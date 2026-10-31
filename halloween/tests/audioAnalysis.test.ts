import { describe, expect, it } from 'vitest';
import { LevelTracker, rmsDb } from '../src/sensors/audioAnalysis.ts';
import { envelope } from '../src/render/helpers.ts';
import { loadConfig, seeded } from './helpers.ts';

const audio = loadConfig().audio;
const STEP_MS = 1000 / audio.analysisHz;

/** Feeds `seconds` of levels from `levelAt(tMs)`; returns the shouts detected. */
function feed(tracker: LevelTracker, fromMs: number, seconds: number, levelAt: (t: number) => number): number[] {
  const shouts: number[] = [];
  for (let t = fromMs; t < fromMs + seconds * 1000; t += STEP_MS) {
    const u = tracker.update(t, levelAt(t));
    if (u.shoutDb !== null) shouts.push(t);
  }
  return shouts;
}

describe('shout detection', () => {
  it('computes RMS level in dBFS', () => {
    expect(rmsDb(new Float32Array(512).fill(0.5), -90)).toBeCloseTo(-6.02, 1);
    expect(rmsDb(new Float32Array(512), -90)).toBe(-90);
  });

  it('a clap or shout triggers', () => {
    const t = new LevelTracker(audio);
    const rng = seeded(1);
    feed(t, 0, 10, () => -60 + rng() * 4);
    const shouts = feed(t, 10_000, 1, (ms) => (ms > 10_200 && ms < 10_400 ? -25 : -60));
    expect(shouts).toHaveLength(1);
    expect(shouts[0]).toBeGreaterThan(10_200);
    expect(shouts[0]).toBeLessThan(10_200 + 100);
  });

  it('steady background noise does not trigger, however loud', () => {
    const t = new LevelTracker(audio);
    const rng = seeded(2);
    expect(feed(t, 0, 60, () => -35 + rng() * 6)).toHaveLength(0);
  });

  it('a slow rise (traffic getting louder, a crowd building) does not trigger', () => {
    const t = new LevelTracker(audio);
    feed(t, 0, 10, () => -60);
    expect(feed(t, 10_000, 20, (ms) => -60 + ((ms - 10_000) / 20_000) * 35)).toHaveLength(0);
  });

  it('a shout still triggers over a talking crowd', () => {
    const t = new LevelTracker(audio);
    const rng = seeded(4);
    feed(t, 0, 20, () => -38 + rng() * 8);
    const shouts = feed(t, 20_000, 1, (ms) => (ms > 20_300 && ms < 20_600 ? -12 : -38 + rng() * 8));
    expect(shouts).toHaveLength(1);
  });

  it('locks out after a shout so one scream counts once', () => {
    const t = new LevelTracker(audio);
    feed(t, 0, 10, () => -60);
    const scream = (ms: number) => (Math.floor(ms / 200) % 2 === 0 ? -15 : -60);
    const shouts = feed(t, 10_000, audio.shoutLockoutS * 0.9, scream);
    expect(shouts).toHaveLength(1);
  });
});

describe('envelope follower (Sound Skull jaw)', () => {
  it('attacks fast and releases slowly', () => {
    let v = 0;
    for (let i = 0; i < 3; i++) v = envelope(v, 1, 1 / 60, 0.03, 0.15); // 50 ms
    expect(v).toBeGreaterThan(0.8);
    for (let i = 0; i < 3; i++) v = envelope(v, 0, 1 / 60, 0.03, 0.15);
    expect(v).toBeGreaterThan(0.5);
  });
});
