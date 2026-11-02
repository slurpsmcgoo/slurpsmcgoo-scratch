// The deformable ground drawn: a fine mesh over the playing area whose heights
// come from the same TerrainGrid the physics collides with (sim/terrain.ts).
// Dents show the moment something lands (from the impact event) and are then
// checked against the game state after every action, so a late joiner or a
// resync ends up with exactly the ground everyone else has. Disturbed regolith
// in the bowls is a little darker, rims a little brighter.

import * as THREE from 'three';
import { CFG } from '../config.ts';
import { syncGrid, TERRAIN_HALF_D, TERRAIN_HALF_W, TERRAIN_NX, TERRAIN_NZ, TerrainGrid, type Box } from '../sim/terrain.ts';
import type { Dent } from '../types.ts';

/** Matches the regolith ground's UV layout (a 700 m plane), so textures line up. */
const GROUND_SIZE = 700;

export class ImpactField {
  readonly mesh: THREE.Mesh;
  private grid = new TerrainGrid();
  private applied: Dent[] = [];
  private dirty: Box | null = null;

  constructor(material: THREE.MeshStandardMaterial) {
    const nx = TERRAIN_NX - 1;
    const nz = TERRAIN_NZ - 1;
    const geo = new THREE.PlaneGeometry(TERRAIN_HALF_W * 2, TERRAIN_HALF_D * 2, nx, nz);
    // PlaneGeometry rows start at +y, which this rotation turns into -z: vertex (ix, iz) is iz * NX + ix.
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position!;
    const uv = geo.attributes.uv!;
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, (pos.getX(i) + GROUND_SIZE / 2) / GROUND_SIZE, (-pos.getZ(i) + GROUND_SIZE / 2) / GROUND_SIZE);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3));
    (geo.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    (geo.attributes.normal as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    const mat = material.clone();
    mat.vertexColors = true;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
  }

  /** Show a dent straight away, as it happens in the throw. */
  dent(d: Dent): void {
    if (this.grid.count !== this.applied.length) return;
    this.applied.push(d);
    const b = this.grid.apply(d);
    if (b) this.mark(b);
  }

  /** Make the ground match the game state's list of dents. */
  sync(dents: Dent[]): void {
    const { grid, changed } = syncGrid(this.grid, this.applied, dents);
    this.grid = grid;
    this.applied = dents.map((d) => [...d] as Dent);
    if (!changed) this.mark({ x0: 0, z0: 0, x1: TERRAIN_NX - 1, z1: TERRAIN_NZ - 1 });
    else for (const b of changed) this.mark(b);
  }

  private mark(b: Box): void {
    const d = this.dirty;
    this.dirty = d
      ? { x0: Math.min(d.x0, b.x0 - 1), z0: Math.min(d.z0, b.z0 - 1), x1: Math.max(d.x1, b.x1 + 1), z1: Math.max(d.z1, b.z1 + 1) }
      : { x0: b.x0 - 1, z0: b.z0 - 1, x1: b.x1 + 1, z1: b.z1 + 1 };
  }

  /** Push changed heights, normals and shading to the GPU (once per frame at most). */
  flush(): void {
    if (!this.dirty) return;
    const { x0, z0, x1, z1 } = this.dirty;
    this.dirty = null;
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position!;
    const nor = geo.attributes.normal!;
    const col = geo.attributes.color!;
    const g = this.grid;
    const cell = CFG.terrain.cell;
    const h = (ix: number, iz: number) => g.h[g.index(Math.max(0, Math.min(TERRAIN_NX - 1, ix)), Math.max(0, Math.min(TERRAIN_NZ - 1, iz)))]!;
    for (let iz = Math.max(0, z0); iz <= Math.min(TERRAIN_NZ - 1, z1); iz++) {
      for (let ix = Math.max(0, x0); ix <= Math.min(TERRAIN_NX - 1, x1); ix++) {
        const i = iz * TERRAIN_NX + ix;
        const y = h(ix, iz);
        pos.setY(i, y);
        const dx = (h(ix + 1, iz) - h(ix - 1, iz)) / (2 * cell);
        const dz = (h(ix, iz + 1) - h(ix, iz - 1)) / (2 * cell);
        const len = Math.hypot(dx, 1, dz);
        nor.setXYZ(i, -dx / len, 1 / len, -dz / len);
        const s = Math.max(0.62, Math.min(1.15, 1 + y * (y < 0 ? 11 : 14)));
        col.setXYZ(i, s, s, s);
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    col.needsUpdate = true;
  }
}
