// Accelerated soak: hours of random simulated visitors, shouts and sensor
// failures through the full perception → director → playlist path on a fake
// clock. Checks the show never wedges and nothing grows without bound.
// (Rendering is soaked separately in a real browser; see README.)

import { describe, expect, it } from 'vitest';
import { AudienceBuilder } from '../src/world/audience.ts';
import { Director } from '../src/director/director.ts';
import { Playlist } from '../src/director/playlist.ts';
import { SimWorld } from '../src/sensors/sim.ts';
import type { AudienceEvent, AudienceState, DirectorState } from '../src/types.ts';
import { loadConfig, seeded } from './helpers.ts';

const cfg = loadConfig();
const SCENES = [
  { id: 'shadowWalker', requires: {} },
  { id: 'soundSkull', requires: { audio: true } },
  { id: 'watchingEyes', requires: { camera: true } },
  { id: 'approachingGhost', requires: { camera: true } },
  { id: 'skeletonMirror', requires: { pose: true } },
];

describe('soak', () => {
  it('runs 6 simulated hours without wedging or growing', () => {
    const rng = seeded(2026);
    const world = new SimWorld(cfg, seeded(1));
    const builder = new AudienceBuilder(cfg);
    const director = new Director(cfg.director, seeded(3));
    const playlist = new Playlist(SCENES, cfg.show);
    const TICK = 1000 / cfg.perception.tickHz;
    const HOURS = 6;
    const end = HOURS * 3600 * 1000;
    const scenarios = ['family', 'passerby', 'lurker'] as const;

    let nextAction = 5000;
    let audience: AudienceState | null = null;
    let pending: AudienceEvent[] = [];
    let stateSince = 0;
    let lastState: DirectorState = 'idle';
    let longestNonIdleMs = 0;
    let scares = 0;
    let sceneChanges = 0;
    let maxPeople = 0;

    // Director and playlist run at 15 Hz here instead of 60 Hz to keep the test fast;
    // they only depend on the timestamps they are given.
    for (let t = 0; t < end; t += TICK) {
      if (t >= nextAction) {
        const r = rng();
        if (r < 0.5) world.playScenario(scenarios[Math.floor(rng() * 3)]!, t);
        else if (r < 0.65) world.shout(t);
        else if (r < 0.75) world.health.camera = world.health.camera === 'ok' ? 'off' : 'ok';
        else if (r < 0.8) world.health.audio = world.health.audio === 'ok' ? 'off' : 'ok';
        else if (r < 0.9) world.clear();
        else world.add(rng(), 1 + rng() * 8, 1 + rng() * 0.9);
        nextAction = t + 10_000 + rng() * 50_000;
      }
      audience = builder.ingest(world.step(t));
      pending.push(...audience.events);
      maxPeople = Math.max(maxPeople, audience.people.length);
      const a = { ...audience, events: pending };
      pending = [];
      for (const tr of director.update(t, a, 2.5)) if (tr.to === 'scare') scares++;
      if (playlist.update(t, a.health, director.context.state, a.people.length === 0)) sceneChanges++;

      const s = director.context.state;
      if (s !== lastState) {
        if (lastState !== 'idle') longestNonIdleMs = Math.max(longestNonIdleMs, t - stateSince);
        stateSince = t;
        lastState = s;
      }
      // Invariants every tick.
      expect(audience.people.length).toBeLessThanOrEqual(cfg.perception.numPoses);
      expect(playlist.activeId).not.toBeNull();
    }

    expect(scares).toBeGreaterThan(20);
    expect(sceneChanges).toBeGreaterThan(5);
    expect(maxPeople).toBeGreaterThan(1);
    // No single non-idle state lasts absurdly long: the machine always moves on.
    expect(longestNonIdleMs).toBeLessThan(10 * 60 * 1000);
    // Internal state is bounded: no leaked per-person filters.
    const internals = builder as unknown as { filters: Map<number, unknown> };
    expect(internals.filters.size).toBeLessThanOrEqual(cfg.perception.numPoses);
  }, 120_000);
});
