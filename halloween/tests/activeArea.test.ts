import { describe, expect, it } from 'vitest';
import { areaRect, defaultArea } from '../src/perception/geometry.ts';
import { AudienceBuilder } from '../src/world/audience.ts';
import { SimWorld } from '../src/sensors/sim.ts';
import { loadConfig, seeded } from './helpers.ts';

const CAM = 16 / 9;

describe('camera active area', () => {
  it('defaults to the whole picture in landscape, and the center slice in portrait', () => {
    expect(areaRect(null, 16 / 9, CAM)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const p = areaRect(null, 9 / 16, CAM);
    expect(p.h).toBe(1);
    expect(p.w).toBeCloseTo((9 / 16) / CAM, 9); // ~0.32 of the width
    expect(p.x + p.w / 2).toBeCloseTo(0.5, 9);
  });

  it('keeps the window proportions in camera pixels, so nobody is stretched', () => {
    for (const out of [16 / 9, 9 / 16]) {
      for (const cam of [16 / 9, 4 / 3]) {
        const r = areaRect({ cx: 0.4, cy: 0.6, height: 0.5 }, out, cam);
        expect((r.w * cam) / r.h).toBeCloseTo(out, 9);
      }
    }
    expect(defaultArea(16 / 9, 4 / 3).height).toBeCloseTo(0.75, 9); // a 4:3 camera: full width, 3/4 of the height
  });

  it('reports people relative to the area, ignores people outside it, and keeps distances unchanged', () => {
    const base = loadConfig();
    const run = (perception: Partial<typeof base.perception>) => {
      const cfg = { ...base, perception: { ...base.perception, ...perception } };
      const world = new SimWorld(cfg, seeded(3));
      world.add(0.3, 3);
      world.add(0.8, 3);
      const b = new AudienceBuilder(cfg);
      let a = b.ingest(world.step(0));
      for (let t = 50; t <= 1000; t += 50) a = b.ingest(world.step(t));
      return a;
    };
    const full = run({ activeArea: null, ignoreOutsideArea: true });
    expect(full.people).toHaveLength(2);

    // A box around the left person only: half the camera height, centered on them.
    const left = full.people.reduce((p, q) => (p.x < q.x ? p : q));
    const zoom = run({ activeArea: { cx: left.x, cy: 0.6, height: 0.6 }, ignoreOutsideArea: true });
    expect(zoom.people).toHaveLength(1);
    expect(zoom.people[0]!.x).toBeCloseTo(0.5, 1); // centered in the box
    expect(zoom.people[0]!.distanceM).toBeCloseTo(left.distanceM, 1); // distance from the full picture

    const keep = run({ activeArea: { cx: left.x, cy: 0.6, height: 0.6 }, ignoreOutsideArea: false });
    expect(keep.people).toHaveLength(2); // the other person is still tracked, just off the window
    expect(keep.cameraArea.h).toBeCloseTo(0.6, 9);
  });
});

describe('pose model crop', () => {
  const base = loadConfig();
  const cfg = (perception: Partial<typeof base.perception>) => ({ ...base, perception: { ...base.perception, ...perception } });

  it('crops to the area plus margin, flipped into raw camera coordinates', async () => {
    const { inferenceCrop } = await import('../src/perception/pose.ts');
    // An area on the visitors' left (x 0.1..0.4) is on the raw camera's right.
    const area = { cx: 0.25, cy: 0.5, height: 0.3 }; // landscape window, 16:9 camera: 0.3 wide too
    const c = inferenceCrop(cfg({ activeArea: area, cropToArea: true, cropMargin: 0, cameraFeedMirrored: false }), 16 / 9);
    expect(c.x).toBeCloseTo(1 - 0.4, 6);
    expect(c.w).toBeCloseTo(0.3, 6);
    const mirrored = inferenceCrop(cfg({ activeArea: area, cropToArea: true, cropMargin: 0, cameraFeedMirrored: true }), 16 / 9);
    expect(mirrored.x).toBeCloseTo(0.1, 6);
    const margin = inferenceCrop(cfg({ activeArea: area, cropToArea: true, cropMargin: 0.1, cameraFeedMirrored: true }), 16 / 9);
    expect(margin.x).toBeCloseTo(0.1 - 0.03, 6);
    expect(margin.w).toBeCloseTo(0.36, 6);
  });

  it('uses the whole frame when cropping is off or the area covers nearly everything', async () => {
    const { inferenceCrop } = await import('../src/perception/pose.ts');
    const full = { x: 0, y: 0, w: 1, h: 1 };
    expect(inferenceCrop(cfg({ activeArea: { cx: 0.3, cy: 0.5, height: 0.3 }, cropToArea: false }), 16 / 9)).toEqual(full);
    expect(inferenceCrop(cfg({ activeArea: null, cropToArea: true }), 16 / 9)).toEqual(full);
  });
});
