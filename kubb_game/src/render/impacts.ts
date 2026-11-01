// Persistent impact marks on the lunar surface: a fine height grid laid over
// the playing area that every ground impact dents with a small crater (a bowl
// with a raised rim, the disturbed regolith a little darker). Dents add up
// over a game. Visual only: the physics ground stays flat, which keeps the
// simulation deterministic and fair.

import * as THREE from 'three';

/** Matches the regolith ground's UV layout (a 700 m plane), so textures line up. */
const GROUND_SIZE = 700;

export class ImpactField {
  readonly mesh: THREE.Mesh;
  private readonly nx: number;
  private readonly nz: number;
  private readonly heights: Float32Array;
  private readonly shade: Float32Array;
  private dirty: [number, number, number, number] | null = null;

  constructor(
    material: THREE.MeshStandardMaterial,
    private readonly width = 14,
    private readonly depth = 20,
    private readonly cell = 0.05,
  ) {
    this.nx = Math.round(width / cell);
    this.nz = Math.round(depth / cell);
    const geo = new THREE.PlaneGeometry(width, depth, this.nx, this.nz);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position!;
    const uv = geo.attributes.uv!;
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, (pos.getX(i) + GROUND_SIZE / 2) / GROUND_SIZE, (-pos.getZ(i) + GROUND_SIZE / 2) / GROUND_SIZE);
    }
    const count = (this.nx + 1) * (this.nz + 1);
    this.heights = new Float32Array(count);
    this.shade = new Float32Array(count).fill(1);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
    (geo.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    (geo.attributes.normal as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    const mat = material.clone();
    mat.vertexColors = true;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
  }

  /** Vertex index for grid column ix (along x) and row iz (along z). */
  private index(ix: number, iz: number): number {
    // PlaneGeometry rows start at +y, which the rotation turned into -z.
    return iz * (this.nx + 1) + ix;
  }

  /** Dent the surface at (x, z) for an impact of `strength` (m/s of speed change). */
  dent(x: number, z: number, strength: number): void {
    const s = Math.min(6, strength);
    const r = Math.min(0.3, 0.06 + 0.035 * s);
    const depth = Math.min(0.03, 0.005 * s);
    const reach = r * 1.7;
    const cx = (x + this.width / 2) / this.cell;
    const cz = (z + this.depth / 2) / this.cell;
    const x0 = Math.max(1, Math.floor(cx - reach / this.cell));
    const x1 = Math.min(this.nx - 1, Math.ceil(cx + reach / this.cell));
    const z0 = Math.max(1, Math.floor(cz - reach / this.cell));
    const z1 = Math.min(this.nz - 1, Math.ceil(cz + reach / this.cell));
    if (x0 > x1 || z0 > z1) return;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const d = (Math.hypot(ix - cx, iz - cz) * this.cell) / r;
        const i = this.index(ix, iz);
        if (d < 1) {
          this.heights[i]! -= depth * (1 - d * d);
          this.shade[i] = Math.max(0.72, this.shade[i]! - 0.07 * (1 - d));
        } else if (d < 1.7) {
          const k = (1.7 - d) / 0.7;
          this.heights[i]! += depth * 0.35 * k * k;
          this.shade[i] = Math.min(1.12, this.shade[i]! + 0.03 * k);
        }
      }
    }
    const [ax, az, bx, bz] = this.dirty ?? [x0, z0, x1, z1];
    this.dirty = [Math.min(ax, x0 - 1), Math.min(az, z0 - 1), Math.max(bx, x1 + 1), Math.max(bz, z1 + 1)];
  }

  reset(): void {
    this.heights.fill(0);
    this.shade.fill(1);
    this.dirty = [0, 0, this.nx, this.nz];
  }

  /** Push changed heights, normals and shading to the GPU (once per frame at most). */
  flush(): void {
    if (!this.dirty) return;
    const [x0, z0, x1, z1] = this.dirty;
    this.dirty = null;
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position!;
    const nor = geo.attributes.normal!;
    const col = geo.attributes.color!;
    const h = (ix: number, iz: number) => this.heights[this.index(Math.max(0, Math.min(this.nx, ix)), Math.max(0, Math.min(this.nz, iz)))]!;
    for (let iz = Math.max(0, z0); iz <= Math.min(this.nz, z1); iz++) {
      for (let ix = Math.max(0, x0); ix <= Math.min(this.nx, x1); ix++) {
        const i = this.index(ix, iz);
        pos.setY(i, this.heights[i]!);
        const dx = (h(ix + 1, iz) - h(ix - 1, iz)) / (2 * this.cell);
        const dz = (h(ix, iz + 1) - h(ix, iz - 1)) / (2 * this.cell);
        const len = Math.hypot(dx, 1, dz);
        nor.setXYZ(i, -dx / len, 1 / len, -dz / len);
        const s = this.shade[i]!;
        col.setXYZ(i, s, s, s);
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    col.needsUpdate = true;
  }
}
