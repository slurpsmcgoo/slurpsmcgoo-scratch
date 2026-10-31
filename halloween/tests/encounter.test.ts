// End-to-end behavior on a simulated clock: simulator → AudienceBuilder →
// Director, exactly as main.ts wires them (perception ticks at tickHz, the
// director updated every 60 Hz frame with events delivered once).

import { describe, expect, it } from 'vitest';
import { AudienceBuilder } from '../src/world/audience.ts';
import { Director, type Transition } from '../src/director/director.ts';
import { SimWorld } from '../src/sensors/sim.ts';
import type { AudienceEvent, AudienceState } from '../src/types.ts';
import { loadConfig, seeded } from './helpers.ts';

const cfg = loadConfig();
const FRAME_MS = 1000 / 60;
const TICK_MS = 1000 / cfg.perception.tickHz;
const SCARE_S = 2.5;

function simulate(seconds: number, setup: (w: SimWorld) => void, during?: (w: SimWorld, tMs: number) => void) {
  const world = new SimWorld(cfg, seeded(42));
  const builder = new AudienceBuilder(cfg);
  const director = new Director(cfg.director, seeded(7));
  setup(world);
  let audience: AudienceState | null = null;
  let pending: AudienceEvent[] = [];
  let nextTick = 0;
  const transitions: Transition[] = [];
  for (let t = 0; t <= seconds * 1000; t += FRAME_MS) {
    during?.(world, t);
    if (t >= nextTick) {
      audience = builder.ingest(world.step(t));
      pending.push(...audience.events);
      nextTick += TICK_MS;
    }
    if (!audience) continue;
    transitions.push(...director.update(t, { ...audience, events: pending }, SCARE_S));
    pending = [];
  }
  return { transitions, path: transitions.map((x) => x.to), director };
}

describe('whole encounters in the simulator', () => {
  it('dragging a person toward the window walks through idle → noticed → engaged → scare → cooldown', () => {
    let key = 0;
    const { path } = simulate(
      30,
      (w) => (key = w.add(0.5, 9.5).key),
      // Walk from 9.5 m to 1.2 m over 8 s, then stand at the door.
      (w, t) => w.move(key, 0.5, Math.max(1.2, 9.5 - (t / 1000) * (8.3 / 8))),
    );
    expect(path.slice(0, 4)).toEqual(['noticed', 'engaged', 'scare', 'cooldown']);
  });

  it('a family that lingers at the door gets one scare per cooldown, then the show resets when they leave', () => {
    const { path, transitions } = simulate(70, (w) => w.playScenario('family', 0));
    const scares = transitions.filter((t) => t.to === 'scare');
    expect(scares.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < scares.length; i++) {
      expect(scares[i]!.atMs - scares[i - 1]!.atMs).toBeGreaterThanOrEqual((SCARE_S + cfg.director.cooldownS) * 1000);
    }
    expect(path[path.length - 1]).toBe('idle');
  });

  it('someone walking past on the street is noticed but never scared', () => {
    const { path } = simulate(20, (w) => w.playScenario('passerby', 0));
    expect(path).toContain('noticed');
    expect(path).not.toContain('scare');
    expect(path[path.length - 1]).toBe('idle');
  });

  it('a shout with nobody in view still triggers a scare (audio-only mode)', () => {
    const { path } = simulate(
      8,
      (w) => (w.health.camera = 'off'),
      (w, t) => {
        if (Math.abs(t - 1000) < FRAME_MS / 2) w.shout(t);
      },
    );
    expect(path.slice(0, 3)).toEqual(['engaged', 'scare', 'cooldown']);
  });
});
