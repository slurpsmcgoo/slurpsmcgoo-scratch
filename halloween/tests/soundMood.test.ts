import { describe, expect, it } from 'vitest';
import { SoundMood } from '../src/render/soundMood.ts';
import { loadConfig } from './helpers.ts';

const cfg = loadConfig().ambient;
const quiet = { levelDb: -60, baselineDb: -60 };
const talk = { levelDb: -60 + cfg.talkRiseDb + cfg.rangeDb, baselineDb: -60 };
const pop = { levelDb: -60 + cfg.flashRiseDb + 1, baselineDb: -60 };

/** Runs `s` seconds of 60 fps frames at one level; returns how many flashes fired. */
function run(m: SoundMood, audio: typeof quiet, s: number, ok = true): number {
  let flashes = 0;
  for (let i = 0; i < s * 60; i++) if (m.update(1 / 60, audio, ok)) flashes++;
  return flashes;
}

describe('SoundMood', () => {
  it('stays dark when the walk is quiet', () => {
    const m = new SoundMood(cfg);
    expect(run(m, quiet, 10)).toBe(0);
    expect(m.liveliness).toBe(0);
  });

  it('livens up quickly with chatter and settles slowly after', () => {
    const m = new SoundMood(cfg);
    run(m, talk, 0.5);
    expect(m.liveliness).toBeGreaterThan(0.95);
    run(m, quiet, cfg.releaseS);
    expect(m.liveliness).toBeGreaterThan(0.2);
    run(m, quiet, cfg.releaseS * 6);
    expect(m.liveliness).toBeLessThan(0.01);
  });

  it('flashes once per loud sound, not once per frame', () => {
    const m = new SoundMood(cfg);
    expect(run(m, pop, 2)).toBe(1);
  });

  it('needs the level to drop before the next flash, and keeps the minimum gap', () => {
    const m = new SoundMood(cfg);
    expect(run(m, pop, 0.1)).toBe(1);
    run(m, quiet, 0.2);
    expect(run(m, pop, 0.1)).toBe(0); // too soon
    run(m, quiet, cfg.flashMinGapS);
    expect(run(m, pop, 0.1)).toBe(1);
  });

  it('does nothing without a working microphone', () => {
    const m = new SoundMood(cfg);
    expect(run(m, pop, 2, false)).toBe(0);
    expect(m.liveliness).toBe(0);
  });
});
