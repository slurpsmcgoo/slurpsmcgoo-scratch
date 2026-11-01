// What impacts kick up. On the Moon: a plume of regolith thrown out in a cone
// (an ejecta curtain) that flies in clean ballistic arcs with no air to slow
// it, then settles where it lands. On a lawn: a few bits of grass and soil.
// Under water: a slow cloud of sand.

import * as THREE from 'three';
import type { Vec3 } from '../types.ts';

const MAX = 12000;

type Surface = 'grass' | 'regolith' | 'sand';

export class Dust {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private alpha = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private next = 0;
  private uniforms = { color: { value: new THREE.Color('#888') }, pxPerMeter: { value: 700 }, brightness: { value: 1 } };
  gravity = 9.81;
  drag = 3;
  surface: Surface = 'grass';

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: this.uniforms,
      vertexShader: `
        attribute float alpha; attribute float size; varying float vA; uniform float pxPerMeter;
        void main() { vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.5, size * pxPerMeter / -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform vec3 color; uniform float brightness; varying float vA;
        void main() { vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25) discard;
          gl_FragColor = vec4(color * brightness, vA * (1.0 - d * 4.0)); }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.life.fill(-1);
  }

  setSurface(surface: Surface, color: THREE.Color, gravity: number): void {
    this.uniforms.color.value.copy(color);
    // Sand stirred up under water hangs in a slow cloud.
    this.gravity = surface === 'sand' ? gravity * 0.06 : gravity;
    this.drag = surface === 'regolith' ? 0 : surface === 'sand' ? 2.2 : 3;
    this.surface = surface;
    // Sunlit regolith in vacuum is bright; nothing is in shadow mid-air.
    this.uniforms.brightness.value = surface === 'regolith' ? 1.6 : 1;
  }

  /** Keep particle sizes in metres whatever the screen and field of view. */
  setCamera(camera: THREE.PerspectiveCamera, heightPx: number): void {
    this.uniforms.pxPerMeter.value = heightPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
  }

  private spawn(p: Vec3, v: Vec3, size: number, life: number, spread: number): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.pos.set([p[0] + (Math.random() - 0.5) * spread, Math.max(0.005, p[1]), p[2] + (Math.random() - 0.5) * spread], i * 3);
    this.vel.set(v, i * 3);
    this.size[i] = size;
    this.maxLife[i] = this.life[i] = life;
  }

  /** A puff at p, scaled by impact strength (m/s of speed change). */
  puff(p: Vec3, strength: number, surface: Surface): void {
    const s = Math.min(6, strength);
    if (surface === 'regolith') {
      // The ejecta curtain: grains thrown outwards in a cone, 30-65 degrees up.
      const n = Math.min(2200, Math.floor(200 + s * 420));
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2;
        const el = (30 + Math.random() * 35) * (Math.PI / 180);
        const sp = (0.3 + Math.random() * Math.random() * 1.2) * (0.6 + s * 0.6);
        const v: Vec3 = [Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp];
        this.spawn([p[0], 0.01, p[2]], v, 0.012 + Math.random() * Math.random() * 0.05, 5 + Math.random() * 4, 0.12);
      }
      // A denser, slower core that falls back around the impact.
      for (let k = 0; k < n / 2; k++) {
        const a = Math.random() * Math.PI * 2;
        const sp = Math.random() * (0.3 + s * 0.35);
        this.spawn([p[0], 0.01, p[2]], [Math.cos(a) * sp * 0.4, sp, Math.sin(a) * sp * 0.4], 0.02 + Math.random() * 0.045, 3 + Math.random() * 2, 0.08);
      }
      return;
    }
    const n = Math.min(160, Math.floor(strength * (surface === 'sand' ? 30 : 6)));
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const up = 0.3 + Math.random() * 0.9;
      const sp = (0.2 + Math.random()) * Math.min(3, strength) * 0.35;
      const life = surface === 'sand' ? 3 + Math.random() * 3 : 0.6 + Math.random() * 0.5;
      this.spawn([p[0], p[1] - 0.02, p[2]], [Math.cos(a) * sp, up * sp * 1.6, Math.sin(a) * sp], surface === 'sand' ? 0.02 : 0.012, life, 0.06);
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
        // Landed: it stays put, fading as it settles into the surface.
        this.pos[o + 1] = 0.003;
        this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
      }
      this.alpha[i] = Math.min(1, this.life[i]! / (this.maxLife[i]! * 0.4)) * 0.85;
    }
    const g = this.points.geometry.attributes;
    g.position!.needsUpdate = true;
    g.alpha!.needsUpdate = true;
    g.size!.needsUpdate = true;
  }
}
