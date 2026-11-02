// Deformable ground (the Moon's regolith): a fine height grid over the playing
// area that every hard landing dents. The grid is a pure function of the list
// of dents in GameState, applied in order, so every peer rebuilds exactly the
// same ground; the physics collides with it and the renderer draws it.
//
// A dent is a bowl with a raised rim, stretched along the direction the piece
// was travelling (a shallow skid leaves a long scrape, a steep drop a round
// pit) with more of the rim thrown out ahead. Dents add up, so hitting the same
// spot deepens and widens the hole. After each dent the regolith slumps until
// no slope is steeper than `maxSlope`, which keeps craters from growing walls a
// kubb can't stand on.

import { CFG } from '../config.ts';
import type { Dent, GameState } from '../types.ts';

const T = CFG.terrain;

/** Vertex counts along x and z. */
export const TERRAIN_NX = Math.round(T.width / T.cell) + 1;
export const TERRAIN_NZ = Math.round(T.depth / T.cell) + 1;
export const TERRAIN_HALF_W = T.width / 2;
export const TERRAIN_HALF_D = T.depth / 2;

/** Grid cells a dent touched (inclusive vertex indices), so a mesh can update just those. */
export interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export class TerrainGrid {
  /** Heights (m), column-major: index = ix * TERRAIN_NZ + iz, as Rapier's heightfield wants them. */
  readonly h: Float64Array;
  /** How many dents of the list this grid has applied. */
  count = 0;

  constructor(from?: TerrainGrid) {
    this.h = from ? new Float64Array(from.h) : new Float64Array(TERRAIN_NX * TERRAIN_NZ);
    if (from) this.count = from.count;
  }

  index(ix: number, iz: number): number {
    return ix * TERRAIN_NZ + iz;
  }

  /** Ground height at (x, z): interpolated inside the grid, 0 outside it. */
  heightAt(x: number, z: number): number {
    const fx = (x + TERRAIN_HALF_W) / T.cell;
    const fz = (z + TERRAIN_HALF_D) / T.cell;
    if (!(fx >= 0 && fz >= 0 && fx <= TERRAIN_NX - 1 && fz <= TERRAIN_NZ - 1)) return 0;
    const ix = Math.min(TERRAIN_NX - 2, Math.floor(fx));
    const iz = Math.min(TERRAIN_NZ - 2, Math.floor(fz));
    const tx = fx - ix;
    const tz = fz - iz;
    const h = this.h;
    const a = h[ix * TERRAIN_NZ + iz]!;
    const b = h[(ix + 1) * TERRAIN_NZ + iz]!;
    const c = h[ix * TERRAIN_NZ + iz + 1]!;
    const d = h[(ix + 1) * TERRAIN_NZ + iz + 1]!;
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  /** Highest ground under an axis-aligned square footprint of half-size r centred on (x, z). */
  maxUnder(x: number, z: number, r: number): number {
    let m = this.heightAt(x, z);
    for (const [dx, dz] of [[-r, -r], [r, -r], [-r, r], [r, r]] as const) m = Math.max(m, this.heightAt(x + dx, z + dz));
    return m;
  }

  /** Dig one dent into the grid. Returns the cells it changed, or null if it missed the grid. */
  apply(d: Dent): Box | null {
    this.count++;
    const [xmm, zmm, vxc, vyc, vzc, grams] = d;
    const vx = vxc / 100;
    const vz = vzc / 100;
    const down = Math.max(0, -vyc / 100);
    const vh = Math.sqrt(vx * vx + vz * vz);
    const impulse = (grams / 1000) * Math.sqrt(down * down + 0.25 * vh * vh);
    const depth = Math.min(T.maxDentDepth, T.depthPerImpulse * impulse);
    const r = Math.min(T.maxRadius, T.radiusBase + T.radiusPerImpulse * impulse);
    const elong = 1 + Math.min(T.maxElongation - 1, (T.elongationPer * vh) / (down + 0.5));
    const ux = vh > 1e-6 ? vx / vh : 1;
    const uz = vh > 1e-6 ? vz / vh : 0;
    const along = r * elong;
    // The crater sits a little downrange of first contact.
    const cx = xmm / 1000 + ux * (along - r) * T.downrangeShift;
    const cz = zmm / 1000 + uz * (along - r) * T.downrangeShift;
    const reach = along * T.rimReach;
    const box = this.clip(cx, cz, reach);
    if (!box) return null;
    const h = this.h;
    const rimSpan = T.rimReach - 1;
    for (let ix = box.x0; ix <= box.x1; ix++) {
      const dx = ix * T.cell - TERRAIN_HALF_W - cx;
      for (let iz = box.z0; iz <= box.z1; iz++) {
        const dz = iz * T.cell - TERRAIN_HALF_D - cz;
        const u = (dx * ux + dz * uz) / along;
        const w = (dz * ux - dx * uz) / r;
        const q = Math.sqrt(u * u + w * w);
        const i = ix * TERRAIN_NZ + iz;
        if (q < 1) {
          h[i]! -= depth * (1 - q * q);
        } else if (q < T.rimReach) {
          const k = (T.rimReach - q) / rimSpan;
          // More ejecta lands ahead of the impact than behind it.
          const ahead = 1 + T.rimDownrange * Math.max(-0.8, Math.min(1, u / q));
          h[i]! += depth * T.rimFraction * k * k * ahead;
        }
      }
    }
    return this.relax(box);
  }

  /** Vertex box around (x, z), kept off the grid's edge so the border stays level with the ground around it. */
  private clip(x: number, z: number, reach: number): Box | null {
    const fx = (x + TERRAIN_HALF_W) / T.cell;
    const fz = (z + TERRAIN_HALF_D) / T.cell;
    const n = reach / T.cell;
    const box = {
      x0: Math.max(1, Math.floor(fx - n)),
      x1: Math.min(TERRAIN_NX - 2, Math.ceil(fx + n)),
      z0: Math.max(1, Math.floor(fz - n)),
      z1: Math.min(TERRAIN_NZ - 2, Math.ceil(fz + n)),
    };
    return box.x0 > box.x1 || box.z0 > box.z1 ? null : box;
  }

  /** Let over-steep regolith slump into its neighbours, then floor the depth. Returns the cells touched. */
  private relax(b: Box): Box {
    const h = this.h;
    const step = T.maxSlope * T.cell;
    const pad = T.relaxPasses;
    const box = {
      x0: Math.max(1, b.x0 - pad),
      x1: Math.min(TERRAIN_NX - 2, b.x1 + pad),
      z0: Math.max(1, b.z0 - pad),
      z1: Math.min(TERRAIN_NZ - 2, b.z1 + pad),
    };
    const move = (a: number, c: number): void => {
      const diff = h[a]! - h[c]!;
      if (diff > step) {
        const t = (diff - step) / 2;
        h[a]! -= t;
        h[c]! += t;
      } else if (diff < -step) {
        const t = (-diff - step) / 2;
        h[a]! += t;
        h[c]! -= t;
      }
    };
    for (let pass = 0; pass < T.relaxPasses; pass++) {
      for (let ix = box.x0; ix <= box.x1; ix++) {
        for (let iz = box.z0; iz <= box.z1; iz++) {
          const i = ix * TERRAIN_NZ + iz;
          if (ix < box.x1) move(i, i + TERRAIN_NZ);
          if (iz < box.z1) move(i, i + 1);
        }
      }
    }
    for (let ix = box.x0; ix <= box.x1; ix++) {
      for (let iz = box.z0; iz <= box.z1; iz++) {
        const i = ix * TERRAIN_NZ + iz;
        if (h[i]! < -T.maxDepth) h[i] = -T.maxDepth;
      }
    }
    return box;
  }
}

/** The physics samples every `physicsStride`-th vertex: contacts with a finer mesh cost more than they add. */
export const PHYS_STRIDE = T.physicsStride;
export const PHYS_NX = (TERRAIN_NX - 1) / PHYS_STRIDE + 1;
export const PHYS_NZ = (TERRAIN_NZ - 1) / PHYS_STRIDE + 1;

/** Heights for Rapier's heightfield: its layout (column-major, x by z) and precision, at the physics stride. */
export function heightfieldData(g: TerrainGrid): Float32Array {
  const out = new Float32Array(PHYS_NX * PHYS_NZ);
  for (let ix = 0; ix < PHYS_NX; ix++) {
    for (let iz = 0; iz < PHYS_NZ; iz++) out[ix * PHYS_NZ + iz] = g.h[ix * PHYS_STRIDE * TERRAIN_NZ + iz * PHYS_STRIDE]!;
  }
  return out;
}

function sameDent(a: Dent, b: Dent): boolean {
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Bring `grid` up to date with `dents`: apply the new ones if it already has a
 * prefix of the list, otherwise start again. Returns the grid to use (the same
 * one, or a fresh one) and the cells that changed (null when rebuilt).
 */
export function syncGrid(grid: TerrainGrid, applied: Dent[], dents: Dent[]): { grid: TerrainGrid; changed: Box[] | null } {
  let prefix = grid.count <= dents.length && grid.count === applied.length;
  for (let i = 0; prefix && i < applied.length; i++) prefix = sameDent(applied[i]!, dents[i]!);
  if (!prefix) {
    const fresh = new TerrainGrid();
    for (const d of dents) fresh.apply(d);
    return { grid: fresh, changed: null };
  }
  const changed: Box[] = [];
  for (let i = grid.count; i < dents.length; i++) {
    const b = grid.apply(dents[i]!);
    if (b) changed.push(b);
  }
  return { grid, changed };
}

// The last terrain built, so consecutive throws only apply the new dents. It is a cache of a pure
// function of the dent list (checked entry by entry), never state of its own.
let cached = new TerrainGrid();
let cachedDents: Dent[] = [];

/** The ground for a game state (a shared, read-only grid: copy it before changing it). */
export function terrainOf(s: GameState): TerrainGrid {
  const dents = s.dents ?? [];
  cached = syncGrid(cached, cachedDents, dents).grid;
  cachedDents = dents.map((d) => [...d] as Dent);
  return cached;
}

/** Ground height under (x, z) in this state: 0 everywhere until something dents it. */
export function groundAt(s: GameState, x: number, z: number, halfSize = 0): number {
  if (!s.dents?.length) return 0;
  const t = terrainOf(s);
  return halfSize > 0 ? t.maxUnder(x, z, halfSize) : t.heightAt(x, z);
}
