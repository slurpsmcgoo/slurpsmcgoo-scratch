import { beforeEach, describe, expect, it } from 'vitest';
import { Director } from '../src/director/director.ts';
import type { ShowConfig } from '../src/config.ts';
import { audience, loadConfig, person } from './helpers.ts';

const SCARE_S = 2;

describe('Director encounter state machine', () => {
  let cfg: ShowConfig['director'];
  let d: Director;
  let rngValue: number;

  beforeEach(() => {
    cfg = {
      ...loadConfig().director,
      engageZone: 'mid',
      scareZone: 'near',
      lingerS: 5,
      scareDelayMinS: 0.5,
      scareDelayMaxS: 1.5,
      cooldownS: 10,
      emptyResetS: 3,
      scareOnShout: true,
      gentleCooldownFactor: 2,
      focusSwitchMarginM: 1,
    };
    rngValue = 0.5;
    d = new Director(cfg, () => rngValue);
  });

  const far = person(1, 8, 'far');
  const mid = person(1, 3, 'mid');
  const near = person(1, 1.5, 'near');

  it('idle → noticed when someone appears', () => {
    expect(d.update(0, audience(0, []), SCARE_S)).toEqual([]);
    const t = d.update(100, audience(100, [far]), SCARE_S);
    expect(t).toEqual([{ from: 'idle', to: 'noticed', atMs: 100 }]);
    expect(d.context.focusPersonId).toBe(1);
  });

  it('noticed → engaged when the nearest person reaches the engage zone', () => {
    d.update(0, audience(0, [far]), SCARE_S);
    d.update(1000, audience(1000, [far]), SCARE_S);
    expect(d.context.state).toBe('noticed');
    d.update(1100, audience(1100, [mid]), SCARE_S);
    expect(d.context.state).toBe('engaged');
  });

  it('noticed → engaged when someone lingers far away for lingerS', () => {
    d.update(0, audience(0, [far]), SCARE_S);
    d.update(4900, audience(4900, [far]), SCARE_S);
    expect(d.context.state).toBe('noticed');
    d.update(5000, audience(5000, [far]), SCARE_S);
    expect(d.context.state).toBe('engaged');
  });

  it('noticed → idle once the walk stays empty for emptyResetS', () => {
    d.update(0, audience(0, [far]), SCARE_S);
    d.update(1000, audience(1000, []), SCARE_S);
    d.update(3900, audience(3900, []), SCARE_S);
    expect(d.context.state).toBe('noticed');
    d.update(4000, audience(4000, []), SCARE_S);
    expect(d.context.state).toBe('idle');
    expect(d.context.focusPersonId).toBeNull();
  });

  it('a brief gap in detections does not end the encounter', () => {
    d.update(0, audience(0, [far]), SCARE_S);
    d.update(1000, audience(1000, []), SCARE_S);
    d.update(2000, audience(2000, [far]), SCARE_S);
    d.update(4500, audience(4500, [far]), SCARE_S);
    expect(d.context.state).toBe('noticed');
  });

  it('engaged → scare at the door, after the random delay', () => {
    d.update(0, audience(0, [mid]), SCARE_S); // noticed
    d.update(10, audience(10, [mid]), SCARE_S); // engaged
    expect(d.context.state).toBe('engaged');
    d.update(1000, audience(1000, [near]), SCARE_S);
    // rng 0.5 → delay 0.5 + 0.5 * (1.5 - 0.5) = 1.0 s
    expect(d.scheduledScareMs).toBe(2000);
    d.update(1999, audience(1999, [near]), SCARE_S);
    expect(d.context.state).toBe('engaged');
    const t = d.update(2000, audience(2000, [near]), SCARE_S);
    expect(t).toEqual([{ from: 'engaged', to: 'scare', atMs: 2000 }]);
  });

  it('scare delay stays within the configured range', () => {
    for (const r of [0, 0.999]) {
      rngValue = r;
      d = new Director(cfg, () => rngValue);
      d.update(0, audience(0, [near]), SCARE_S);
      d.update(10, audience(10, [near]), SCARE_S);
      d.update(20, audience(20, [near]), SCARE_S);
      const delay = (d.scheduledScareMs! - 20) / 1000;
      expect(delay).toBeGreaterThanOrEqual(cfg.scareDelayMinS);
      expect(delay).toBeLessThanOrEqual(cfg.scareDelayMaxS);
    }
  });

  it('engaged → scare on a shout', () => {
    d.update(0, audience(0, [mid]), SCARE_S);
    d.update(10, audience(10, [mid]), SCARE_S);
    d.update(100, audience(100, [mid], [{ type: 'shout', db: -10 }]), SCARE_S);
    expect(d.scheduledScareMs).toBe(1100);
    d.update(1100, audience(1100, [mid]), SCARE_S);
    expect(d.context.state).toBe('scare');
  });

  it('a shout scares even with no one detected (audio-only mode)', () => {
    d.update(0, audience(0, [], [{ type: 'shout', db: -10 }]), SCARE_S);
    expect(d.context.state).toBe('engaged');
    d.update(5000, audience(5000, []), SCARE_S); // past emptyResetS, but the shout counts
    expect(d.context.state).toBe('scare');
  });

  it('shouts are ignored when scareOnShout is off', () => {
    d.setConfig({ ...cfg, scareOnShout: false });
    d.update(0, audience(0, [], [{ type: 'shout', db: -10 }]), SCARE_S);
    expect(d.context.state).toBe('idle');
  });

  it('engaged → idle (and the scheduled scare is cancelled) when the group leaves', () => {
    d.update(0, audience(0, [mid]), SCARE_S);
    d.update(10, audience(10, [near]), SCARE_S);
    d.update(20, audience(20, [near]), SCARE_S);
    expect(d.scheduledScareMs).not.toBeNull();
    d.update(100, audience(100, []), SCARE_S);
    d.update(3100, audience(3100, []), SCARE_S);
    expect(d.context.state).toBe('idle');
    expect(d.scheduledScareMs).toBeNull();
  });

  it('scare → cooldown after the scene scare duration', () => {
    d.scareNow();
    d.update(0, audience(0, [near]), SCARE_S);
    expect(d.context.state).toBe('scare');
    d.update(1999, audience(1999, [near]), SCARE_S);
    expect(d.context.state).toBe('scare');
    d.update(2000, audience(2000, [near]), SCARE_S);
    expect(d.context.state).toBe('cooldown');
  });

  it('cooldown suppresses scares, then returns to engaged if people remain', () => {
    d.scareNow();
    d.update(0, audience(0, [near]), SCARE_S);
    d.update(2000, audience(2000, [near]), SCARE_S); // cooldown
    d.update(5000, audience(5000, [near], [{ type: 'shout', db: -5 }]), SCARE_S);
    expect(d.context.state).toBe('cooldown');
    d.update(12000, audience(12000, [near]), SCARE_S);
    expect(d.context.state).toBe('engaged');
  });

  it('cooldown → idle when the walk is empty', () => {
    d.scareNow();
    d.update(0, audience(0, [near]), SCARE_S);
    d.update(2000, audience(2000, []), SCARE_S);
    expect(d.context.state).toBe('cooldown');
    d.update(5000, audience(5000, []), SCARE_S);
    expect(d.context.state).toBe('idle');
  });

  it('gentle intensity lengthens cooldown', () => {
    d.setIntensity('gentle');
    d.scareNow();
    d.update(0, audience(0, [near]), SCARE_S);
    d.update(2000, audience(2000, [near]), SCARE_S);
    d.update(12000, audience(12000, [near]), SCARE_S);
    expect(d.context.state).toBe('cooldown');
    d.update(22000, audience(22000, [near]), SCARE_S);
    expect(d.context.state).toBe('engaged');
    expect(d.context.intensity).toBe('gentle');
  });

  it('scareNow jumps to scare from any state, even when paused', () => {
    d.setPaused(true);
    d.scareNow();
    d.update(0, audience(0, []), SCARE_S);
    expect(d.context.state).toBe('scare');
    d.update(2000, audience(2000, []), SCARE_S);
    expect(d.context.state).toBe('idle');
  });

  it('pause keeps the director idle', () => {
    d.setPaused(true);
    d.update(0, audience(0, [near]), SCARE_S);
    d.update(10000, audience(10000, [near], [{ type: 'shout', db: -5 }]), SCARE_S);
    expect(d.context.state).toBe('idle');
    d.setPaused(false);
    d.update(10100, audience(10100, [near]), SCARE_S);
    expect(d.context.state).toBe('noticed');
  });

  it('keeps focus on one person until someone is clearly nearer', () => {
    const a = person(1, 3, 'mid', 0.3);
    d.update(0, audience(0, [a]), SCARE_S);
    expect(d.context.focusPersonId).toBe(1);
    d.update(100, audience(100, [a, person(2, 2.5, 'mid', 0.7)]), SCARE_S);
    expect(d.context.focusPersonId).toBe(1);
    d.update(200, audience(200, [a, person(2, 1.5, 'near', 0.7)]), SCARE_S);
    expect(d.context.focusPersonId).toBe(2);
    d.update(300, audience(300, [a]), SCARE_S);
    expect(d.context.focusPersonId).toBe(1);
  });
});
