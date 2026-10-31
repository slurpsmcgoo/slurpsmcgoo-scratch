// Render helpers that scenes may import (alongside types.ts). Pure functions
// only: no sensors, no timers, no globals.

// ---------- config access ----------
// Scenes read their tunables from their section of show.json. A missing key is
// a bug in show.json (tests/sceneConfig.test.ts checks every key scenes read).

const warned = new Set<string>();
function warnMissing(key: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[config] scene config key "${key}" is missing from show.json`);
}

export function num(cfg: Record<string, unknown>, key: string): number {
  const v = cfg[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  warnMissing(key);
  return 0;
}

export function bool(cfg: Record<string, unknown>, key: string): boolean {
  const v = cfg[key];
  if (typeof v === 'boolean') return v;
  warnMissing(key);
  return false;
}

export function str(cfg: Record<string, unknown>, key: string): string {
  const v = cfg[key];
  if (typeof v === 'string') return v;
  warnMissing(key);
  return '#ffffff';
}

// ---------- math ----------

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
export const easeInCubic = (t: number): number => clamp(t, 0, 1) ** 3;
export const easeOutCubic = (t: number): number => 1 - (1 - clamp(t, 0, 1)) ** 3;
export const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * clamp(t, 0, 1)) - 1) / 2;

/** Moves `current` toward `target` with time constant `tauS` (frame-rate independent). */
export function approach(current: number, target: number, dtS: number, tauS: number): number {
  if (tauS <= 0) return target;
  return target + (current - target) * Math.exp(-dtS / tauS);
}

/** Envelope follower: fast attack when rising, slower release when falling. */
export function envelope(current: number, target: number, dtS: number, attackS: number, releaseS: number): number {
  return approach(current, target, dtS, target > current ? attackS : releaseS);
}

// ---------- deterministic randomness and noise ----------

/** Seeded PRNG (mulberry32). Returns a function giving floats in [0, 1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randRange = (rng: () => number, lo: number, hi: number): number => lo + (hi - lo) * rng();

function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth 1D value noise in [-1, 1]. */
export function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash1(i), hash1(i + 1), u) * 2 - 1;
}

/** Sum of noise octaves in roughly [-1, 1]. */
export function fbm1(x: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise1(x * freq + o * 17.3) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// ---------- drawing ----------

export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1).toFixed(3)})`;
}

/** Runs `draw` with a soft glow around whatever it fills or strokes. */
export function glow(ctx: CanvasRenderingContext2D, color: string, blur: number, draw: () => void): void {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  draw();
  ctx.restore();
}

/** Strokes a thick rounded limb from (x1, y1) to (x2, y2). */
export function limb(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, width: number): void {
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

// ---------- audience helpers ----------

/** MediaPipe Pose landmark indices that scenes commonly need. */
export const LM = {
  nose: 0,
  leftEye: 2,
  rightEye: 5,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFoot: 31,
  rightFoot: 32,
} as const;

/** Bones drawn by skeleton-style scenes, as pairs of landmark indices. */
export const BONES: [number, number][] = [
  [11, 13], [13, 15], [12, 14], [14, 16], // arms
  [23, 25], [25, 27], [24, 26], [26, 28], // legs
  [27, 31], [28, 32],                     // feet
  [11, 12], [23, 24],                     // shoulder and hip girdles
];
