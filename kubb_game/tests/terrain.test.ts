import { beforeAll, describe, expect, it } from 'vitest';
import { CFG, DEG } from '../src/config.ts';
import { applyAction } from '../src/game/session.ts';
import { hashState } from '../src/sim/hash.ts';
import { simulateThrow } from '../src/sim/physics.ts';
import { currentActor, isUpright } from '../src/sim/rules.ts';
import { groundAt, syncGrid, TerrainGrid } from '../src/sim/terrain.ts';
import { makeIntent, mediumOf, releasePoint, solveSpeed } from '../src/throw/model.ts';
import type { Dent, GameState, Vec3 } from '../src/types.ts';
import { game, ready } from './helpers.ts';

beforeAll(ready);

/** A baton coming down at (x, z) at 4 m/s, `angleDeg` below horizontal, travelling +z. */
function dent(x: number, z: number, angleDeg = 60): Dent {
  const a = angleDeg * DEG;
  return [Math.round(x * 1000), Math.round(z * 1000), 0, Math.round(-400 * Math.sin(a)), Math.round(400 * Math.cos(a)), 320];
}

function batonAt(s: GameState, target: Vec3, loftDeg: number) {
  const from = releasePoint(s, target[0]);
  const loft = loftDeg * DEG;
  const speed = solveSpeed(from, target, loft, mediumOf(s))!;
  return makeIntent({ kind: 'baton', from, dir: [target[0] - from[0], target[2] - from[2]], loft, speed });
}

describe('terrain', () => {
  it('a dent is a bowl with a raised rim', () => {
    const g = new TerrainGrid();
    g.apply(dent(1, 2));
    expect(g.heightAt(1, 2)).toBeLessThan(-0.003);
    let rim = 0;
    for (let r = 0.05; r < 0.5; r += 0.01) rim = Math.max(rim, g.heightAt(1, 2 + r));
    expect(rim).toBeGreaterThan(0.0005);
    expect(g.heightAt(3, 2)).toBe(0);
  });

  it('hits on the same spot deepen and widen the crater', () => {
    const g = new TerrainGrid();
    g.apply(dent(0.5, -2));
    const depth1 = g.heightAt(0.5, -2);
    const width = (grid: TerrainGrid) => {
      let w = 0;
      for (let r = 0; r < 0.6; r += 0.01) if (grid.heightAt(0.5 + r, -2) < -0.001) w = r;
      return w;
    };
    const w1 = width(g);
    for (let i = 0; i < 6; i++) g.apply(dent(0.5 + (i % 3) * 0.02, -2 + (i % 2) * 0.02));
    expect(g.heightAt(0.5, -2)).toBeLessThan(depth1 * 1.8);
    expect(width(g)).toBeGreaterThan(w1);
    expect(g.heightAt(0.5, -2)).toBeGreaterThanOrEqual(-CFG.terrain.maxDepth);
  });

  it('a shallow skid leaves a long scrape, a steep drop a round pit', () => {
    const extent = (d: Dent) => {
      const g = new TerrainGrid();
      g.apply(d);
      let along = 0;
      let across = 0;
      for (let r = 0; r < 0.8; r += 0.005) {
        if (g.heightAt(0, r) < -0.0005 || g.heightAt(0, -r) < -0.0005) along = r;
        if (g.heightAt(r, 0) < -0.0005) across = r;
      }
      return along / across;
    };
    expect(extent(dent(0, 0, 15))).toBeGreaterThan(1.5);
    expect(extent(dent(0, 0, 85))).toBeLessThan(1.25);
  });

  it('never leaves a slope steeper than the regolith holds', () => {
    const g = new TerrainGrid();
    for (let i = 0; i < 20; i++) g.apply(dent(0, 0, 80));
    const cell = CFG.terrain.cell;
    let steepest = 0;
    for (let x = -0.6; x < 0.6; x += cell) steepest = Math.max(steepest, Math.abs(g.heightAt(x + cell, 0) - g.heightAt(x, 0)) / cell);
    expect(steepest).toBeLessThan(CFG.terrain.maxSlope * 1.3);
  });

  it('catching up on new dents gives exactly the ground a rebuild does', () => {
    const list = [dent(0, 0), dent(0.1, 0.05, 30), dent(-1, 3, 50), dent(0.05, 0, 70)];
    let g = new TerrainGrid();
    let applied: Dent[] = [];
    for (let n = 1; n <= list.length; n++) {
      g = syncGrid(g, applied, list.slice(0, n)).grid;
      applied = list.slice(0, n);
    }
    const fresh = syncGrid(new TerrainGrid(), [], list).grid;
    expect(Buffer.from(g.h.buffer).equals(Buffer.from(fresh.h.buffer))).toBe(true);
  });

  it('a hard landing on the Moon dents the ground, and only there', () => {
    const moon = game({ setting: 'moon' });
    const park = game();
    const r = simulateThrow(moon, batonAt(moon, [1.5, 0, 0.5], 40));
    expect(r.dents.length).toBeGreaterThan(0);
    expect(simulateThrow(park, batonAt(park, [1.5, 0, 0.5], 40)).dents).toEqual([]);
  });

  it('throws on dented ground stay deterministic, and pieces rest in the craters', () => {
    let s = game({ setting: 'moon', practice: true });
    const intent = batonAt(s, [1.5, 0, 0.5], 40);
    for (let i = 0; i < 4; i++) {
      const a = { type: 'throw' as const, id: `t${i}`, player: currentActor(s)!.player.id, intent };
      const a1 = applyAction(s, a);
      expect(hashState(applyAction(s, a))).toBe(hashState(a1));
      s = a1;
    }
    expect(s.dents.length).toBeGreaterThan(3);
    for (const b of s.batons) expect(b.p[1]).toBeGreaterThan(groundAt(s, b.p[0], b.p[2]) - 0.01);
    // A kubb stood in the crater rests on its floor, below where it would stand on flat ground.
    const floor = groundAt(s, 1.5, 0.47, CFG.pieces.kubb.size[0] / 2);
    expect(floor).toBeLessThan(-0.01);
    const k = s.pieces.find((p) => p.id === 'k5')!;
    k.p = [1.5, floor + CFG.pieces.kubb.size[1] / 2, 0.47];
    const r = simulateThrow(s, batonAt(s, [-1.5, 0, 1], 40)).pieces.k5!;
    expect(isUpright(r)).toBe(true);
    expect(r.p[1]).toBeLessThan(CFG.pieces.kubb.size[1] / 2 - 0.008);
  });
});
