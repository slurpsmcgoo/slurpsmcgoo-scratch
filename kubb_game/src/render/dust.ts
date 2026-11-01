// What impacts kick up: lunar dust that flies in clean arcs with no air to
// slow it, or bits of grass and soil on a lawn.

import * as THREE from 'three';
import type { Vec3 } from '../types.ts';

const MAX = 3000;

export class Dust {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private alpha = new Float32Array(MAX);
  private next = 0;
  gravity = 9.81;
  drag = 3;
  color = new THREE.Color('#888');
  surface: 'grass' | 'regolith' | 'sand' = 'grass';

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { color: { value: this.color }, scale: { value: 300 } },
      vertexShader: `
        attribute float alpha; varying float vA; uniform float scale;
        void main() { vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = scale * 0.012 / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform vec3 color; varying float vA;
        void main() { vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25) discard;
          gl_FragColor = vec4(color, vA * (1.0 - d * 4.0)); }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.life.fill(-1);
  }

  setSurface(surface: 'grass' | 'regolith' | 'sand', color: THREE.Color, gravity: number): void {
    this.color.copy(color);
    // Sand stirred up under water hangs in a slow cloud.
    this.gravity = surface === 'sand' ? gravity * 0.06 : gravity;
    this.drag = surface === 'regolith' ? 0 : surface === 'sand' ? 2.2 : 3;
    this.surface = surface;
  }

  /** A puff at p, scaled by impact strength (m/s of speed change). */
  puff(p: Vec3, strength: number, surface: 'grass' | 'regolith' | 'sand'): void {
    const n = Math.min(160, Math.floor(strength * (surface === 'regolith' ? 40 : surface === 'sand' ? 30 : 6)));
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      const a = Math.random() * Math.PI * 2;
      const up = 0.3 + Math.random() * 0.9;
      const sp = (0.2 + Math.random()) * Math.min(3, strength) * (surface === 'regolith' ? 0.5 : 0.35);
      this.pos.set([p[0] + (Math.random() - 0.5) * 0.06, Math.max(0.005, p[1] - 0.02), p[2] + (Math.random() - 0.5) * 0.06], i * 3);
      this.vel.set([Math.cos(a) * sp, up * sp * 1.6, Math.sin(a) * sp], i * 3);
      this.maxLife[i] = this.life[i] = surface === 'regolith' ? 2.5 + Math.random() * 2 : surface === 'sand' ? 3 + Math.random() * 3 : 0.6 + Math.random() * 0.5;
    }
  }

  update(dt: number): void {
    const f = Math.exp(-this.drag * dt);
    for (let i = 0; i < MAX; i++) {
      if (this.life[i]! <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i]! -= dt;
      const o = i * 3;
      this.vel[o + 1]! -= this.gravity * dt;
      this.vel[o]! *= f;
      this.vel[o + 1]! *= f;
      this.vel[o + 2]! *= f;
      this.pos[o]! += this.vel[o]! * dt;
      this.pos[o + 1]! += this.vel[o + 1]! * dt;
      this.pos[o + 2]! += this.vel[o + 2]! * dt;
      if (this.pos[o + 1]! < 0.003) {
        this.pos[o + 1] = 0.003;
        this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
      }
      this.alpha[i] = Math.min(1, this.life[i]! / (this.maxLife[i]! * 0.5)) * 0.8;
    }
    this.points.geometry.attributes.position!.needsUpdate = true;
    this.points.geometry.attributes.alpha!.needsUpdate = true;
  }
}
