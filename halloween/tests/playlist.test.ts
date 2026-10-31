import { describe, expect, it } from 'vitest';
import { Playlist, isEligible } from '../src/director/playlist.ts';
import type { SensorHealth } from '../src/types.ts';

const SCENES = [
  { id: 'shadowWalker', requires: {} },
  { id: 'soundSkull', requires: { audio: true } },
  { id: 'watchingEyes', requires: { camera: true } },
  { id: 'skeletonMirror', requires: { pose: true } },
];
const SHOW = { startScene: 'shadowWalker', playlist: SCENES.map((s) => s.id), rotateEveryS: 60 };
const health = (camera: SensorHealth['camera'], audio: SensorHealth['audio']): SensorHealth => ({ camera, audio, source: 'live', perceptionLatencyMs: 0 });
const FULL = health('ok', 'ok');

describe('Playlist (show layer)', () => {
  it('checks sensor requirements', () => {
    expect(isEligible({}, health('off', 'off'))).toBe(true);
    expect(isEligible({ audio: true }, health('ok', 'stale'))).toBe(false);
    expect(isEligible({ pose: true }, health('stale', 'ok'))).toBe(false);
  });

  it('starts on the start scene and rotates only while idle and empty', () => {
    const p = new Playlist(SCENES, SHOW);
    expect(p.update(0, FULL, 'idle', true)).toBe('shadowWalker');
    expect(p.update(59_000, FULL, 'idle', true)).toBeNull();
    expect(p.update(61_000, FULL, 'engaged', false)).toBeNull();
    expect(p.update(61_000, FULL, 'idle', true)).toBe('soundSkull');
  });

  it('leaves a scene immediately when its sensor goes down', () => {
    const p = new Playlist(SCENES, SHOW);
    p.update(0, FULL, 'idle', true);
    p.choose('watchingEyes', 0, FULL);
    // Next eligible after watchingEyes, wrapping past the camera-only skeletonMirror.
    expect(p.update(100, health('off', 'ok'), 'engaged', false)).toBe('shadowWalker');
    p.choose('soundSkull', 150, health('off', 'ok'));
    expect(p.update(200, health('off', 'off'), 'idle', true)).toBe('shadowWalker');
  });

  it('a one-scene show never rotates, falls back when the camera drops, and returns at once', () => {
    const p = new Playlist(SCENES, { startScene: 'skeletonMirror', playlist: ['skeletonMirror'], rotateEveryS: 0 });
    expect(p.update(0, FULL, 'idle', true)).toBe('skeletonMirror');
    expect(p.update(3_600_000, FULL, 'idle', true)).toBeNull();
    expect(p.update(3_600_100, health('off', 'ok'), 'idle', true)).toBe('shadowWalker');
    expect(p.update(3_600_200, FULL, 'idle', true)).toBe('skeletonMirror');
  });

  it('rotateEveryS 0 turns rotation off', () => {
    const p = new Playlist(SCENES, { ...SHOW, rotateEveryS: 0 });
    p.update(0, FULL, 'idle', true);
    expect(p.update(10_000_000, FULL, 'idle', true)).toBeNull();
  });

  it('next/prev cycle through eligible scenes only', () => {
    const p = new Playlist(SCENES, SHOW);
    const noCam = health('off', 'ok');
    p.update(0, noCam, 'idle', true);
    expect(p.step(1, 0, noCam)).toBe('soundSkull');
    expect(p.step(1, 0, noCam)).toBe('shadowWalker');
    expect(p.step(-1, 0, noCam)).toBe('soundSkull');
    expect(p.choose('watchingEyes', 0, noCam)).toBeNull();
  });

  it('never returns to a scene that crashed', () => {
    const p = new Playlist(SCENES, SHOW);
    p.update(0, FULL, 'idle', true);
    p.choose('soundSkull', 0, FULL);
    p.disable('soundSkull');
    expect(p.update(10, FULL, 'idle', true)).toBe('watchingEyes');
    expect(p.eligible(FULL)).not.toContain('soundSkull');
  });

  it('shows black only if even the fallback scene is disabled', () => {
    const p = new Playlist(SCENES, SHOW);
    p.update(0, health('off', 'off'), 'idle', true);
    p.disable('shadowWalker');
    expect(p.update(10, health('off', 'off'), 'idle', true)).toBeNull();
    expect(p.activeId).toBeNull();
  });
});
