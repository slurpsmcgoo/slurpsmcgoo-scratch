import { describe, expect, it } from 'vitest';
import { pictureToQuad, quadToPicture } from '../src/render/output.ts';
import { turned } from '../src/render/calibrate.ts';
import { logicalSize, type Pt, type Rotation } from '../src/config.ts';

const ROTATIONS: Rotation[] = [0, 90, 180, 270];
const close = (a: Pt, b: Pt) => {
  expect(a[0]).toBeCloseTo(b[0], 9);
  expect(a[1]).toBeCloseTo(b[1], 9);
};

describe('orientation and rotation', () => {
  it('portrait is 1080 wide and 1920 tall', () => {
    expect(logicalSize('landscape')).toEqual({ width: 1920, height: 1080 });
    expect(logicalSize('portrait')).toEqual({ width: 1080, height: 1920 });
  });

  it('turning the picture a quarter turn clockwise puts its top-left corner at the projector top-right', () => {
    close(pictureToQuad([0, 0], 90), [1, 0]);
    close(pictureToQuad([0, 1], 90), [0, 0]); // its bottom-left ends up top-left
    close(pictureToQuad([0, 0], 180), [1, 1]);
    close(pictureToQuad([0, 0], 270), [0, 1]);
    close(pictureToQuad([0.3, 0.7], 0), [0.3, 0.7]);
  });

  it('picture-to-projector and back is the identity for every rotation', () => {
    for (const r of ROTATIONS) {
      for (const p of [[0, 0], [1, 0], [0.25, 0.8], [0.5, 0.5]] as Pt[]) close(quadToPicture(pictureToQuad(p, r), r), p);
    }
  });

  it('O flips landscape and portrait; Shift+O steps the rotation round', () => {
    const cal = { mirror: false, corners: [], mask: [], orientation: 'landscape', rotation: 0 } as const;
    expect(turned({ ...cal, corners: [], mask: [] }, false).orientation).toBe('portrait');
    let r = { ...cal, corners: [], mask: [] } as Parameters<typeof turned>[0];
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      r = turned(r, true);
      seen.push(r.rotation);
    }
    expect(seen).toEqual([90, 180, 270, 0]);
  });
});
