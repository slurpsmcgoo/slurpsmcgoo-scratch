import { beforeAll, describe, expect, it } from 'vitest';
import { DEG } from '../src/config.ts';
import { applyAction } from '../src/game/session.ts';
import { hashState } from '../src/sim/hash.ts';
import { simulateThrow } from '../src/sim/physics.ts';
import { currentActor, isUpright } from '../src/sim/rules.ts';
import { arcPoints, makeIntent, mediumOf, releasePoint, solveSpeed, speedScale } from '../src/throw/model.ts';
import type { GameState, ThrowIntent, Vec3 } from '../src/types.ts';
import { game, ready } from './helpers.ts';

beforeAll(ready);

function aimAt(s: GameState, target: Vec3, loftDeg = 30, x = target[0]): ThrowIntent {
  const from = releasePoint(s, x);
  const loft = loftDeg * DEG;
  const speed = solveSpeed(from, target, loft, mediumOf(s))!;
  return makeIntent({ kind: 'baton', from, dir: [target[0] - from[0], target[2] - from[2]], loft, speed });
}

describe('physics', () => {
  it('is deterministic: the same throw gives bit-identical results', () => {
    const s = game();
    const intent = aimAt(s, [0.4, 0.06, 3.9]);
    const a = simulateThrow(s, intent);
    const b = simulateThrow(s, intent);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('gives identical game states through applyAction', () => {
    const s = game();
    const action = { type: 'throw' as const, id: 'x', player: currentActor(s)!.player.id, intent: aimAt(s, [0, 0.06, 3.96]) };
    expect(hashState(applyAction(s, action))).toBe(hashState(applyAction(s, action)));
  });

  it('leaves resting pieces where they are when nothing hits them', () => {
    const s = game();
    const r = simulateThrow(s, aimAt(s, [0, 0, 1.5]));
    for (const p of s.pieces) {
      const pose = r.pieces[p.id]!;
      expect(isUpright(pose)).toBe(true);
      expect(Math.abs(pose.p[0] - p.p[0]) + Math.abs(pose.p[2] - p.p[2])).toBeLessThan(0.002);
    }
  });

  // Not every perfect aim hits: a tumbling baton can arrive end-up and skip over,
  // as real ones do. Most should.
  it.each(['park', 'moon', 'ocean'])('a baton aimed at a kubb usually knocks it over (%s)', (setting) => {
    const s = game({ setting });
    const k = s.pieces.find((p) => p.id === 'k7')!;
    let hits = 0;
    let tries = 0;
    for (let loft = 18; loft <= 44; loft += 2, tries++) {
      const r = simulateThrow(s, aimAt(s, [k.p[0], 0.06, k.p[2] - 0.04], loft, 0));
      if (!isUpright(r.pieces.k7!)) hits++;
    }
    expect(hits / tries).toBeGreaterThan(0.6);
  });

  it('settles well before the time limit', () => {
    const s = game();
    const r = simulateThrow(s, aimAt(s, [1, 0, 2]));
    expect(r.steps).toBeLessThan(600);
    expect(r.thrown.p[1]).toBeLessThan(0.03); // lying flat
  });

  it('a missed baton stops within a couple of metres of where it lands', () => {
    const s = game();
    const r = simulateThrow(s, aimAt(s, [0.8, 0, 1.5]));
    expect(r.thrown.p[2]).toBeGreaterThan(1.0);
    expect(r.thrown.p[2]).toBeLessThan(3.5);
  });

  it('on the moon the same throw flies about six times further', () => {
    const park = game();
    const moon = game({ setting: 'moon' });
    const intent = makeIntent({ kind: 'baton', from: releasePoint(park, 0), dir: [0, 1], loft: 30 * DEG, speed: 3 });
    const zPark = simulateThrow(park, intent).thrown.p[2] + 4;
    const zMoon = simulateThrow(moon, intent).thrown.p[2] + 4;
    expect(zMoon / zPark).toBeGreaterThan(3);
  });

  it('under water a throw needs more speed and drops steeply at the end', () => {
    const sea = game({ setting: 'ocean' });
    expect(speedScale(sea)).toBeGreaterThan(1.02);
    const from = releasePoint(sea, 0);
    const loft = 34 * DEG;
    const speed = solveSpeed(from, [0, 0.06, 4], loft, mediumOf(sea))!;
    const arc = arcPoints(from, [0, speed * Math.sin(loft), speed * Math.cos(loft)], mediumOf(sea));
    const [a, b] = [arc[arc.length - 3]!, arc[arc.length - 1]!];
    const descent = Math.atan2(a[1] - b[1], b[2] - a[2]);
    expect(descent).toBeGreaterThan(loft + 10 * DEG);
  });
});
