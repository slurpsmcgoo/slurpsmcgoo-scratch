// Runs every scene's update and render code through a simulated night: people
// arriving, scares, gentle mode, music with a beat clock (including just below
// zero, as it is right after locking) and music stopping. The canvas is a
// stand-in that accepts any drawing call, so this catches crashes (a scene that
// throws is disabled for the night), not how anything looks.

import { describe, expect, it } from 'vitest';
import { AudienceBuilder } from '../src/world/audience.ts';
import { SimWorld } from '../src/sensors/sim.ts';
import { SCENE_FACTORIES } from '../src/scenes/index.ts';
import type { DirectorContext, DirectorState, MusicState, SceneContext } from '../src/types.ts';
import { loadConfig, seeded } from './helpers.ts';

/** A 2D context that accepts every call and property; gradients and paths are stand-ins too. */
function fakeContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop() {} };
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => gradient;
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => {};
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function installFakeDom(): void {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => fakeContext() }) };
  g.Path2D ??= class { rect() {} moveTo() {} lineTo() {} arc() {} closePath() {} };
}

describe('every scene survives a simulated night', () => {
  installFakeDom();
  const cfg = loadConfig();

  for (const [orientation, width, height] of [['landscape', 1920, 1080], ['portrait', 1080, 1920]] as const)
  for (const factory of SCENE_FACTORIES) {
    const scene = factory();
    it(`${scene.id} (${orientation})`, async () => {
      const sc: SceneContext = { ctx: fakeContext(), width, height, config: { ...cfg.scenes[scene.id] } };
      await scene.init(sc);
      const world = new SimWorld(cfg, seeded(5));
      const builder = new AudienceBuilder(cfg);
      world.playScenario('family', 0);
      const states: DirectorState[] = ['idle', 'noticed', 'engaged', 'scare', 'cooldown'];
      let director: DirectorContext = { state: 'idle', stateEnteredMs: 0, focusPersonId: null, intensity: 'normal' };
      const dt = 1 / 60;
      for (let i = 0; i < 60 * 40; i++) {
        const tMs = i * dt * 1000;
        if (i === 60 * 20) world.clear();
        // Every 3 s, the next director state; gentle mode for the second half.
        if (i % 180 === 0) {
          const to = states[(i / 180) % states.length]!;
          const next: DirectorContext = { ...director, state: to, stateEnteredMs: tMs, intensity: i > 60 * 20 ? 'gentle' : 'normal' };
          scene.onStateChange?.(director.state, to, next);
          director = next;
        }
        const audience = builder.ingest(world.step(tMs));
        // Music: off, then on with the beat clock starting just below zero, then off again.
        const playing = i > 60 * 5 && i < 60 * 30;
        const beatPos = (i - 60 * 5) / 30 - 0.4;
        const music: MusicState = playing
          ? { playing, bpm: 120, beat: Math.floor(beatPos), phase: beatPos - Math.floor(beatPos), energy: 0.8 }
          : { playing: false, bpm: 120, beat: 0, phase: 0, energy: 0 };
        expect(() => {
          scene.update(dt, { ...audience, music }, director);
          scene.render(sc);
        }).not.toThrow();
      }
    });
  }
});
