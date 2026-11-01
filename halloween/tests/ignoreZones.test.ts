import { describe, expect, it } from 'vitest';
import { bodyBox, fractionInside, inIgnoreZone, type AreaRect } from '../src/perception/geometry.ts';
import { validateConfig } from '../src/config.ts';
import { AudienceBuilder } from '../src/world/audience.ts';
import { SimWorld } from '../src/sensors/sim.ts';
import type { Landmark } from '../src/types.ts';
import { loadConfig, seeded } from './helpers.ts';

const box = (x: number, y: number, w: number, h: number): AreaRect => ({ x, y, w, h });
/** 33 landmarks spread evenly over a box. */
const figure = (b: AreaRect): Landmark[] =>
  Array.from({ length: 33 }, (_, i) => ({ x: b.x + ((i % 3) / 2) * b.w, y: b.y + (Math.floor(i / 3) / 10) * b.h, z: 0, visibility: 0.9 }));

describe('ignore zones', () => {
  it('measures how much of a body sits inside a zone', () => {
    expect(fractionInside(box(0.1, 0.1, 0.2, 0.2), box(0, 0, 1, 1))).toBeCloseTo(1, 9);
    expect(fractionInside(box(0.1, 0.1, 0.2, 0.2), box(0.2, 0, 1, 1))).toBeCloseTo(0.5, 9);
    expect(fractionInside(box(0.1, 0.1, 0.2, 0.2), box(0.5, 0.5, 0.1, 0.1))).toBe(0);
    expect(bodyBox(figure(box(0.2, 0.3, 0.1, 0.4)))).toEqual({ x: 0.2, y: 0.3, w: expect.closeTo(0.1, 9), h: expect.closeTo(0.4, 9) });
  });

  it('drops something that fits in the zone (the motorcycle) but keeps a person walking in front of it', () => {
    const zone = box(0.6, 0.5, 0.2, 0.2);
    const bike = figure(box(0.62, 0.52, 0.15, 0.15));
    const personInFront = figure(box(0.6, 0.2, 0.15, 0.7)); // taller than the zone: most of them is outside
    expect(inIgnoreZone(bike, [zone], 0.8)).toBe(true);
    expect(inIgnoreZone(personInFront, [zone], 0.8)).toBe(false);
    expect(inIgnoreZone(bike, [], 0.8)).toBe(false);
  });

  it('removes only the person inside a zone from the audience', () => {
    const base = loadConfig();
    const run = (ignoreZones: AreaRect[] | undefined) => {
      const cfg = { ...base, perception: { ...base.perception, activeArea: null, ignoreZones } };
      const world = new SimWorld(cfg, seeded(3));
      world.add(0.3, 3);
      world.add(0.8, 3);
      const b = new AudienceBuilder(cfg);
      let a = b.ingest(world.step(0));
      for (let t = 50; t <= 1000; t += 50) a = b.ingest(world.step(t));
      return a;
    };
    const all = run(undefined); // a show.json from before ignore zones still works
    expect(all.people).toHaveLength(2);
    const right = all.people.reduce((p, q) => (p.x > q.x ? p : q));
    const b = bodyBox(right.landmarks)!; // with the default area, landmarks are full-camera coordinates
    const pad = 0.03;
    const kept = run([box(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad)]);
    expect(kept.people).toHaveLength(1);
    expect(kept.people[0]!.x).toBeLessThan(0.5);
    // A zone over only their legs is not enough to drop them.
    expect(run([box(b.x - pad, b.y + b.h * 0.6, b.w + 2 * pad, b.h * 0.5)]).people).toHaveLength(2);
  });

  it('rejects malformed zones in show.json', () => {
    const cfg = loadConfig();
    expect(validateConfig(cfg)).toEqual([]);
    const bad = { ...cfg, perception: { ...cfg.perception, ignoreZones: [{ x: 0, y: 0, w: 0, h: 0.1 }] } };
    expect(validateConfig(bad)).toContain('perception.ignoreZones must be a list of { x, y, w, h } boxes');
  });
});
