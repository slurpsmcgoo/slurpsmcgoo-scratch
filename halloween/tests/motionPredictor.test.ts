import { describe, expect, it } from 'vitest';
import { MotionPredictor } from '../src/world/motionPredictor.ts';
import type { Landmark } from '../src/types.ts';
import { person } from './helpers.ts';

const CFG = { predictMotion: true, predictMs: 0, maxPredictMs: 90 };
const pose = (x: number): Landmark[] => Array.from({ length: 33 }, () => ({ x, y: 0.5, visibility: 1 }));
const withPose = (id: number, lm: Landmark[]) => ({ ...person(id, 3, 'mid'), landmarks: lm });

describe('MotionPredictor', () => {
  it('moves a steadily moving person to where they are now, between pose results', () => {
    const m = new MotionPredictor(CFG);
    // Moving right at 0.001 per ms, results every 33 ms.
    m.observe([withPose(1, pose(0.4))], 0, 1000);
    const latest = withPose(1, pose(0.433));
    m.observe([latest], 33, 1033);
    const out = m.apply([latest], 1049.5)[0]!;
    expect(out.landmarks[0]!.x).toBeCloseTo(0.4495, 4);
  });

  it('adds predictMs on top, to cover camera and model delay', () => {
    const m = new MotionPredictor({ ...CFG, predictMs: 30 });
    m.observe([withPose(1, pose(0.4))], 0, 1000);
    const latest = withPose(1, pose(0.433));
    m.observe([latest], 33, 1033);
    expect(m.apply([latest], 1033)[0]!.landmarks[0]!.x).toBeCloseTo(0.463, 4);
  });

  it('leaves still people alone and never pushes a point too far', () => {
    const m = new MotionPredictor(CFG);
    m.observe([withPose(1, pose(0.5))], 0, 0);
    const still = withPose(1, pose(0.5));
    m.observe([still], 33, 33);
    expect(m.apply([still], 60)[0]!.landmarks[0]!.x).toBe(0.5);

    const jump = new MotionPredictor(CFG);
    jump.observe([withPose(2, pose(0.1))], 0, 0);
    const far = withPose(2, pose(0.6)); // a bad detection leaping half the frame
    jump.observe([far], 33, 33);
    expect(jump.apply([far], 100)[0]!.landmarks[0]!.x).toBeLessThanOrEqual(0.6 + 0.06 + 1e-9);
  });

  it('stops predicting when results stop, returning the same pose so stalls stay visible', () => {
    const m = new MotionPredictor(CFG);
    m.observe([withPose(1, pose(0.4))], 0, 0);
    const latest = withPose(1, pose(0.433));
    m.observe([latest], 33, 33);
    const out = m.apply([latest], 33 + CFG.maxPredictMs + 1)[0]!;
    expect(out).toBe(latest);
  });

  it('can be switched off', () => {
    const m = new MotionPredictor({ ...CFG, predictMotion: false });
    const people = [withPose(1, pose(0.4))];
    expect(m.apply(people, 10)).toBe(people);
  });
});
