// Procedural textures drawn on canvases at start-up: wood, bark, lawn,
// regolith, the Earth. No image files, so nothing to license or download.

import * as THREE from 'three';

/** Small seeded PRNG so textures look the same every load. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise on a grid of `cells`, sampled at (x, y) in 0..1. */
export function makeNoise(cells: number, seed: number): (x: number, y: number) => number {
  const r = prng(seed);
  const grid = new Float32Array(cells * cells).map(() => r());
  const at = (i: number, j: number) => grid[((j % cells) + cells) % cells * cells + (((i % cells) + cells) % cells)]!;
  return (x, y) => {
    const fx = x * cells;
    const fy = y * cells;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const u = fx - i;
    const v = fy - j;
    const su = u * u * (3 - 2 * u);
    const sv = v * v * (3 - 2 * v);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * su;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * su;
    return a + (b - a) * sv;
  };
}

export function fbm(x: number, y: number, octaves: ((x: number, y: number) => number)[]): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (const n of octaves) {
    sum += n(x, y) * amp;
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function toTexture(c: HTMLCanvasElement, color: boolean, repeat = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fillPixels(w: number, h: number, fn: (x: number, y: number) => [number, number, number]): HTMLCanvasElement {
  const [c, g] = canvas(w, h);
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, gg, b] = fn(x / w, y / h);
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = gg;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

export interface WoodTextures {
  map: THREE.Texture;
  bump: THREE.Texture;
}

/** Light hardwood (birch/beech) with grain running along v. */
export function woodTextures(seed = 1, tint = '#d8b88a'): WoodTextures {
  const w = 256;
  const h = 512;
  const n1 = makeNoise(4, seed);
  const n2 = makeNoise(16, seed + 1);
  const n3 = makeNoise(64, seed + 2);
  const [tr, tg, tb] = hexRgb(tint);
  const grain: number[] = [];
  const color = fillPixels(w, h, (x, y) => {
    // Rings: stretched along y, wobbling with low-frequency noise.
    const warp = n1(x, y * 0.25) * 6 + n2(x, y) * 0.6;
    const ring = Math.sin((x * 22 + warp) * Math.PI);
    const fine = n3(x * 4, y * 0.5);
    const g = 0.5 + 0.5 * ring;
    const v = 0.86 + 0.1 * g - 0.12 * Math.pow(g, 6) + (fine - 0.5) * 0.08;
    grain.push(v);
    return [tr * v, tg * v * 0.98, tb * v * 0.95];
  });
  let i = 0;
  const bump = fillPixels(w, h, () => {
    const v = Math.max(0, Math.min(255, (grain[i++]! - 0.7) * 600));
    return [v, v, v];
  });
  return { map: toTexture(color, true), bump: toTexture(bump, false) };
}

export function barkTexture(seed = 5): WoodTextures {
  const n1 = makeNoise(8, seed);
  const n2 = makeNoise(32, seed + 1);
  const vals: number[] = [];
  const color = fillPixels(256, 256, (x, y) => {
    const ridges = Math.abs(Math.sin((x * 14 + n1(x, y * 0.3) * 3) * Math.PI));
    const v = 0.35 + 0.4 * ridges * (0.7 + 0.6 * n2(x, y));
    vals.push(v);
    return [92 * v * 1.6, 72 * v * 1.6, 54 * v * 1.6];
  });
  let i = 0;
  const bump = fillPixels(256, 256, () => {
    const v = vals[i++]! * 255;
    return [v, v, v];
  });
  return { map: toTexture(color, true), bump: toTexture(bump, false) };
}

/** Lawn seen from above: thousands of short strokes in a few greens, tileable. */
export function lawnTexture(colors: string[], seed = 7): THREE.Texture {
  const size = 512;
  const [c, g] = canvas(size, size);
  const r = prng(seed);
  g.fillStyle = colors[0]!;
  g.fillRect(0, 0, size, size);
  const rgb = colors.map(hexRgb);
  for (let k = 0; k < 26000; k++) {
    const [cr, cg, cb] = rgb[Math.floor(r() * rgb.length)]!;
    const l = 0.75 + r() * 0.45;
    g.strokeStyle = `rgba(${cr * l | 0},${cg * l | 0},${cb * l | 0},${0.5 + r() * 0.5})`;
    g.lineWidth = 0.8 + r() * 1.2;
    const x = r() * size;
    const y = r() * size;
    const a = r() * Math.PI * 2;
    const len = 3 + r() * 7;
    for (const [ox, oy] of [[0, 0], [-size, 0], [size, 0], [0, -size], [0, size]] as const) {
      g.beginPath();
      g.moveTo(x + ox, y + oy);
      g.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len);
      g.stroke();
    }
  }
  // A few clover and dry patches.
  for (let k = 0; k < 120; k++) {
    g.fillStyle = r() < 0.5 ? 'rgba(170,160,90,0.10)' : 'rgba(40,70,20,0.12)';
    g.beginPath();
    g.arc(r() * size, r() * size, 4 + r() * 14, 0, Math.PI * 2);
    g.fill();
  }
  return toTexture(c, true);
}

/** Large-scale brightness variation (patchiness), greyscale around 1. */
export function macroNoiseTexture(seed = 9): THREE.Texture {
  const oct = [makeNoise(4, seed), makeNoise(8, seed + 1), makeNoise(16, seed + 2), makeNoise(32, seed + 3)];
  const c = fillPixels(256, 256, (x, y) => {
    const v = fbm(x, y, oct) * 255;
    return [v, v, v];
  });
  return toTexture(c, false);
}

export interface RegolithTextures {
  map: THREE.Texture;
  bump: THREE.Texture;
}

/** Lunar dust: fine grey grain, pebbles and tiny craterlets. */
export function regolithTextures(colors: string[], seed = 11): RegolithTextures {
  const size = 512;
  const oct = [makeNoise(8, seed), makeNoise(16, seed + 1), makeNoise(32, seed + 2), makeNoise(128, seed + 3)];
  const r = prng(seed + 4);
  const craters: [number, number, number][] = [];
  for (let k = 0; k < 40; k++) craters.push([r(), r(), 0.004 + r() * r() * 0.03]);
  const height = new Float32Array(size * size);
  const [c0, c1, c2] = colors.map(hexRgb) as [[number, number, number], [number, number, number], [number, number, number]];
  const color = fillPixels(size, size, (x, y) => {
    let h = fbm(x, y, oct);
    for (const [cx, cy, cr] of craters) {
      let dx = Math.abs(x - cx);
      let dy = Math.abs(y - cy);
      dx = Math.min(dx, 1 - dx);
      dy = Math.min(dy, 1 - dy);
      const d = Math.sqrt(dx * dx + dy * dy) / cr;
      if (d < 1.3) h += d < 1 ? -0.25 * (1 - d * d) : 0.15 * (1.3 - d) / 0.3;
    }
    const speck = r() < 0.03 ? (r() - 0.5) * 0.4 : 0;
    height[Math.floor(y * size) * size + Math.floor(x * size)] = h + speck * 0.3;
    const t = Math.max(0, Math.min(1, h + speck));
    const a = t < 0.5 ? c0 : c1;
    const b = t < 0.5 ? c1 : c2;
    const u = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  });
  let i = 0;
  const bump = fillPixels(size, size, () => {
    const v = Math.max(0, Math.min(255, height[i++]! * 255));
    return [v, v, v];
  });
  return { map: toTexture(color, true), bump: toTexture(bump, false) };
}

/** Sea-floor sand: fine grain with soft ripples, tileable. */
export function sandTextures(colors: string[], seed = 71): RegolithTextures {
  const size = 512;
  const oct = [makeNoise(8, seed), makeNoise(32, seed + 1), makeNoise(128, seed + 2)];
  const warp = makeNoise(4, seed + 3);
  const r = prng(seed + 4);
  const heights: number[] = [];
  const [c0, c1, c2] = colors.map(hexRgb) as [[number, number, number], [number, number, number], [number, number, number]];
  const color = fillPixels(size, size, (x, y) => {
    const ripple = Math.sin((y * 14 + warp(x, y) * 3 + x * 2) * Math.PI * 2) * 0.5 + 0.5;
    const grain = fbm(x, y, oct);
    const h = ripple * 0.55 + grain * 0.45 + (r() < 0.02 ? (r() - 0.5) * 0.4 : 0);
    heights.push(h);
    const t = Math.max(0, Math.min(1, h));
    const a = t < 0.5 ? c0 : c1;
    const b = t < 0.5 ? c1 : c2;
    const u = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  });
  let i = 0;
  const bump = fillPixels(size, size, () => {
    const v = Math.max(0, Math.min(255, heights[i++]! * 255));
    return [v, v, v];
  });
  return { map: toTexture(color, true), bump: toTexture(bump, false) };
}

/** Equirectangular Earth: oceans, continents, ice caps and clouds in one map. */
export function earthTexture(seed = 21): THREE.Texture {
  const w = 1024;
  const h = 512;
  const land = [makeNoise(6, seed), makeNoise(12, seed + 1), makeNoise(24, seed + 2), makeNoise(48, seed + 3)];
  const cloud = [makeNoise(8, seed + 10), makeNoise(16, seed + 11), makeNoise(32, seed + 12), makeNoise(64, seed + 13)];
  const c = fillPixels(w, h, (x, y) => {
    const lat = Math.abs(y - 0.5) * 2;
    const l = fbm(x, y * 0.5 + 0.2, land);
    const cl = fbm(x * 1.0, y * 0.5, cloud);
    let col: [number, number, number];
    if (lat > 0.88) col = [235, 240, 245];
    else if (l > 0.53) {
      const dry = Math.max(0, 1 - Math.abs(lat - 0.35) * 4);
      col = [70 + 100 * dry, 105 + 50 * dry, 50 + 30 * dry];
    } else col = [18, 48 + 40 * l, 110 + 60 * l];
    const cloudA = Math.max(0, Math.min(1, (cl - 0.52) * 4));
    return [col[0] + (250 - col[0]) * cloudA, col[1] + (252 - col[1]) * cloudA, col[2] + (255 - col[2]) * cloudA];
  });
  const t = toTexture(c, true);
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Text label for name tags. */
export function labelTexture(text: string, color: string): THREE.Texture {
  const [c, g] = canvas(256, 64);
  g.font = '600 34px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = Math.min(250, g.measureText(text).width + 28);
  g.fillStyle = 'rgba(15,18,22,0.55)';
  g.beginPath();
  g.roundRect(128 - w / 2, 8, w, 48, 24);
  g.fill();
  g.fillStyle = color;
  g.fillRect(128 - w / 2 + 14, 28, 8, 8);
  g.fillStyle = '#fff';
  g.fillText(text, 136, 33, 220);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
