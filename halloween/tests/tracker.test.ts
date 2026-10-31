import { describe, expect, it } from 'vitest';
import { Tracker } from '../src/perception/tracker.ts';
import type { Detection } from '../src/types.ts';

/** A detection whose hips sit at (x, y). */
function det(x: number, y = 0.6): Detection {
  const landmarks = Array.from({ length: 33 }, () => ({ x, y, visibility: 0.9 }));
  return { timeMs: 0, landmarks, confidence: 0.9 };
}

const CFG = { confirmFrames: 3, dropAfterS: 1, maxMatchDistance: 0.2 };

describe('Tracker', () => {
  it('confirms a person only after confirmFrames consecutive sightings', () => {
    const t = new Tracker(CFG);
    expect(t.update([det(0.5)], 0).tracks).toHaveLength(0);
    expect(t.update([det(0.5)], 66).tracks).toHaveLength(0);
    const r = t.update([det(0.5)], 133);
    expect(r.tracks).toHaveLength(1);
    expect(r.entered).toEqual([1]);
  });

  it('drops a tentative track that misses a frame (no flicker from one-off false detections)', () => {
    const t = new Tracker(CFG);
    t.update([det(0.5)], 0);
    t.update([det(0.5)], 66);
    t.update([], 133);
    t.update([det(0.5)], 200);
    expect(t.update([det(0.5)], 266).tracks).toHaveLength(0);
    expect(t.update([det(0.5)], 333).tracks).toHaveLength(1);
  });

  it('keeps a confirmed person through short gaps and removes them after dropAfterS', () => {
    const t = new Tracker(CFG);
    for (let i = 0; i < 3; i++) t.update([det(0.5)], i * 66);
    expect(t.update([], 500).tracks).toHaveLength(1);
    const back = t.update([det(0.51)], 900);
    expect(back.tracks.map((x) => x.id)).toEqual([1]);
    expect(t.update([], 1500).tracks).toHaveLength(1);
    const gone = t.update([], 1901);
    expect(gone.tracks).toHaveLength(0);
    expect(gone.left).toEqual([1]);
  });

  it('keeps stable IDs for two people moving side by side', () => {
    const t = new Tracker(CFG);
    let r = t.update([det(0.3), det(0.7)], 0);
    for (let i = 1; i < 3; i++) r = t.update([det(0.3), det(0.7)], i * 66);
    const idAt = (x: number) => r.tracks.find((tr) => Math.abs(tr.hip.x - x) < 0.05)!.id;
    const left = idAt(0.3);
    const right = idAt(0.7);
    for (let i = 3; i < 20; i++) {
      // Detections arrive in a different order each tick.
      const a = det(0.3 + i * 0.005);
      const b = det(0.7 - i * 0.005);
      r = t.update(i % 2 ? [b, a] : [a, b], i * 66);
    }
    expect(idAt(0.3 + 19 * 0.005)).toBe(left);
    expect(idAt(0.7 - 19 * 0.005)).toBe(right);
  });

  it('does not match detections farther than maxMatchDistance', () => {
    const t = new Tracker(CFG);
    for (let i = 0; i < 3; i++) t.update([det(0.2)], i * 66);
    const r = t.update([det(0.8)], 200);
    expect(r.tracks.map((x) => x.seenThisTick)).toEqual([false]);
  });

  it('never holds more people than the pose model can see: a newcomer retires the longest-missing person', () => {
    const t = new Tracker(CFG, 2);
    for (let i = 0; i < 3; i++) t.update([det(0.2), det(0.5)], i * 66);
    t.update([det(0.5)], 200); // person at 0.2 walks out of frame
    let r = t.update([det(0.5), det(0.85)], 266);
    r = t.update([det(0.5), det(0.85)], 333);
    r = t.update([det(0.5), det(0.85)], 400); // newcomer confirmed
    expect(r.tracks).toHaveLength(2);
    expect(r.left).toEqual([1]);
    expect(r.entered).toEqual([3]);
  });
});
