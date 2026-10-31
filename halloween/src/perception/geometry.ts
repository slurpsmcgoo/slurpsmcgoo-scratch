// Camera geometry: the camera-to-visitor x flip, distance from where the feet
// appear in the image, a shoulder-width fallback, and zones.
//
// Distance from feet uses a pinhole camera at a known height, tilted down by
// an angle fitted from tape marks at known distances. A point on the ground at
// distance d appears at angle atan(h / d) below horizontal; its image row is
// set by that angle minus the camera tilt. Foot position doesn't depend on
// body size, so children and adults at the same spot get the same distance.

import type { ShowConfig } from '../config.ts';
import type { Landmark, Zone } from '../types.ts';

type GeometryConfig = ShowConfig['geometry'];

const DEG = Math.PI / 180;
const MIN_ANGLE = 0.5 * DEG; // feet at or above the horizon give no usable distance

/** The camera looks out the window, the opposite way to a visitor looking in. */
export function toVisitorX(cameraX: number, feedAlreadyMirrored: boolean): number {
  return feedAlreadyMirrored ? cameraX : 1 - cameraX;
}

function rowToAngleOffset(y: number, vfovRad: number): number {
  return Math.atan((y - 0.5) * 2 * Math.tan(vfovRad / 2));
}

/** Fits the camera's downward tilt (radians) from the calibration tape marks. */
export function fitTilt(g: GeometryConfig): number {
  const vfov = g.verticalFovDeg * DEG;
  const tilts = g.calibrationMarks.map((m) => Math.atan(g.cameraHeightM / m.distanceM) - rowToAngleOffset(m.footY, vfov));
  return tilts.reduce((a, b) => a + b, 0) / tilts.length;
}

export function distanceFromFootY(footY: number, g: GeometryConfig, tilt: number): number | null {
  const theta = tilt + rowToAngleOffset(footY, g.verticalFovDeg * DEG);
  if (theta < MIN_ANGLE) return null;
  return g.cameraHeightM / Math.tan(theta);
}

/** Image row where a point at `heightM` above the ground, `distanceM` away, appears. */
export function rowForPoint(distanceM: number, heightM: number, g: GeometryConfig, tilt: number): number {
  const theta = Math.atan((g.cameraHeightM - heightM) / distanceM);
  return 0.5 + Math.tan(theta - tilt) / (2 * Math.tan((g.verticalFovDeg * DEG) / 2));
}

/** Image width (0..1) covered by `widthM` at `distanceM`. */
export function widthAtDistance(widthM: number, distanceM: number, g: GeometryConfig): number {
  return widthM / (distanceM * 2 * Math.tan((g.horizontalFovDeg * DEG) / 2));
}

export function distanceFromShoulders(shoulderWidthNorm: number, g: GeometryConfig): number | null {
  if (shoulderWidthNorm <= 1e-4) return null;
  return g.shoulderWidthM / (shoulderWidthNorm * 2 * Math.tan((g.horizontalFovDeg * DEG) / 2));
}

export interface DistanceEstimate {
  distanceM: number;
  method: 'feet' | 'shoulders';
}

/** Shoulder width as a fraction of image width, or null if the shoulders aren't visible. */
export function shoulderWidthNorm(lm: Landmark[]): number | null {
  const ls = lm[11];
  const rs = lm[12];
  if (!ls || !rs || ls.visibility < 0.3 || rs.visibility < 0.3) return null;
  return Math.abs(ls.x - rs.x);
}

/** Physical shoulder width implied by a measured width at a known distance. */
export function shoulderWidthAt(widthNorm: number, distanceM: number, g: GeometryConfig): number {
  return widthNorm * distanceM * 2 * Math.tan((g.horizontalFovDeg * DEG) / 2);
}

/**
 * Distance from the lowest visible foot point, falling back to shoulder width
 * when feet are hidden. `personShoulderM` is this person's own shoulder width,
 * measured earlier while their feet were visible; without it the fallback
 * assumes an adult, which puts children too far away.
 */
export function estimateDistance(lm: Landmark[], g: GeometryConfig, tilt: number, personShoulderM?: number): DistanceEstimate | null {
  const feet = [lm[27], lm[28], lm[29], lm[30]].filter(
    (p): p is Landmark => !!p && p.visibility >= g.footMinVisibility && p.y <= g.footMaxY,
  );
  if (feet.length > 0) {
    const footY = Math.max(...feet.map((p) => p.y));
    const d = distanceFromFootY(footY, g, tilt);
    if (d !== null) return { distanceM: d, method: 'feet' };
  }
  const w = shoulderWidthNorm(lm);
  if (w !== null) {
    const d = distanceFromShoulders(w, { ...g, shoulderWidthM: personShoulderM ?? g.shoulderWidthM });
    if (d !== null) return { distanceM: d, method: 'shoulders' };
  }
  return null;
}

/** Zone for a distance, with hysteresis so people standing on a boundary don't flicker. */
export function zoneFor(distanceM: number, zones: ShowConfig['zones'], previous?: Zone): Zone {
  const raw: Zone = distanceM < zones.nearM ? 'near' : distanceM < zones.midM ? 'mid' : 'far';
  if (!previous || previous === raw) return raw;
  // Stay in the previous zone until the distance is past its edge by hysteresisM.
  const m = zones.hysteresisM;
  const lo = previous === 'near' ? -Infinity : previous === 'mid' ? zones.nearM : zones.midM;
  const hi = previous === 'near' ? zones.nearM : previous === 'mid' ? zones.midM : Infinity;
  return distanceM >= lo - m && distanceM < hi + m ? previous : raw;
}

/** Hip center, the point the tracker follows. */
export function hipCenter(lm: Landmark[]): { x: number; y: number } {
  const l = lm[23];
  const r = lm[24];
  if (l && r) return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  const s = lm[11] && lm[12] ? { x: (lm[11].x + lm[12].x) / 2, y: (lm[11].y + lm[12].y) / 2 } : null;
  return s ?? { x: lm[0]?.x ?? 0.5, y: lm[0]?.y ?? 0.5 };
}

/** Vertical extent of the visible landmarks, used to reject tiny false detections. */
export function bodyHeight(lm: Landmark[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of lm) {
    if (p.visibility < 0.3) continue;
    lo = Math.min(lo, p.y);
    hi = Math.max(hi, p.y);
  }
  return hi > lo ? hi - lo : 0;
}

// ---------------------------------------------------------------- camera active area

/** The part of the camera picture that maps to the whole window, in visitor view. */
export interface ActiveArea {
  cx: number;     // center, 0..1 of camera width
  cy: number;     // center, 0..1 of camera height
  height: number; // fraction of camera height (may exceed 1 to show the whole picture, smaller)
}

export interface AreaRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The largest centered area with the window's proportions that fits in the camera picture. */
export function defaultArea(outAspect: number, cameraAspect: number): ActiveArea {
  return { cx: 0.5, cy: 0.5, height: Math.min(1, cameraAspect / outAspect) };
}

/**
 * The area as a rectangle in normalized camera coordinates. Its width follows
 * from its height so that, in camera pixels, it has the window's proportions
 * (`outAspect`, width/height): people are never stretched.
 */
export function areaRect(area: ActiveArea | null, outAspect: number, cameraAspect: number): AreaRect {
  const a = area ?? defaultArea(outAspect, cameraAspect);
  const h = a.height;
  const w = (h * outAspect) / cameraAspect;
  return { x: a.cx - w / 2, y: a.cy - h / 2, w, h };
}

/** Camera coordinates → area coordinates (0..1 across the area). */
export const toArea = (r: AreaRect, x: number, y: number): [number, number] => [(x - r.x) / r.w, (y - r.y) / r.h];

/** Area coordinates → camera coordinates. */
export const fromArea = (r: AreaRect, x: number, y: number): [number, number] => [r.x + x * r.w, r.y + y * r.h];
