// The ocean floor: sand with moving caustics, kelp, coral and rocks, shafts of
// light from the surface, fish, and bubbles (from the divers, from vents, and
// from impacts). Built from a preset in config/kubb.json like the other settings.

import * as THREE from 'three';
import type { QualityName, SceneDef } from '../config.ts';
import type { Vec3 } from '../types.ts';
import { prefilter, type Environment } from './environment.ts';
import { makeNoise, prng, sandTextures } from './textures.ts';

function nearPitch(x: number, z: number, margin: number): boolean {
  return Math.abs(x) < 2.5 + margin && Math.abs(z) < 4 + margin;
}

const BUBBLES = 1500;

class Bubbles {
  readonly points: THREE.Points;
  private pos = new Float32Array(BUBBLES * 3);
  private vel = new Float32Array(BUBBLES);
  private seed = new Float32Array(BUBBLES);
  private life = new Float32Array(BUBBLES).fill(-1);
  private size = new Float32Array(BUBBLES);
  private next = 0;

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        vertexShader: `attribute float size; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * 300.0 / -mv.z; gl_Position = projectionMatrix * mv; }`,
        // A hollow, bright-rimmed circle with a highlight: reads as a bubble.
        fragmentShader: `void main() { vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard;
          float rim = smoothstep(0.32, 0.5, d) * (1.0 - smoothstep(0.47, 0.5, d));
          float hi = smoothstep(0.12, 0.0, length(c - vec2(-0.15, -0.15)));
          gl_FragColor = vec4(vec3(0.85, 0.97, 1.0), rim * 0.8 + hi * 0.9 + 0.06); }`,
      }),
    );
    this.points.frustumCulled = false;
  }

  emit(p: Vec3, n: number, spread = 0.05): void {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % BUBBLES;
      this.pos.set([p[0] + (Math.random() - 0.5) * spread, p[1] + Math.random() * spread, p[2] + (Math.random() - 0.5) * spread], i * 3);
      this.size[i] = 0.006 + Math.random() * Math.random() * 0.03;
      this.vel[i] = 0.35 + this.size[i]! * 18;
      this.seed[i] = Math.random() * 100;
      this.life[i] = 6 + Math.random() * 4;
    }
  }

  update(dt: number, t: number): void {
    for (let i = 0; i < BUBBLES; i++) {
      if (this.life[i]! <= 0) {
        this.size[i] = 0;
        continue;
      }
      this.life[i]! -= dt;
      const o = i * 3;
      const s = this.seed[i]!;
      this.pos[o]! += Math.sin(t * 3 + s) * 0.12 * dt;
      this.pos[o + 1]! += this.vel[i]! * dt;
      this.pos[o + 2]! += Math.cos(t * 2.6 + s) * 0.12 * dt;
      if (this.pos[o + 1]! > 12) this.life[i] = 0;
    }
    this.points.geometry.attributes.position!.needsUpdate = true;
    this.points.geometry.attributes.size!.needsUpdate = true;
  }
}

interface Fish {
  cx: number;
  cz: number;
  r: number;
  h: number;
  speed: number;
  phase: number;
  bob: number;
  scale: number;
}

function fishGeometry(): THREE.BufferGeometry {
  const body = new THREE.SphereGeometry(1, 12, 8);
  body.scale(0.5, 0.22, 0.12);
  const tail = new THREE.BufferGeometry();
  tail.setAttribute('position', new THREE.Float32BufferAttribute([-0.45, 0, 0, -0.78, 0.2, 0, -0.78, -0.2, 0], 3));
  tail.setIndex([0, 1, 2]);
  tail.computeVertexNormals();
  const merged = new THREE.BufferGeometry();
  const parts = [body.toNonIndexed(), tail.toNonIndexed()];
  const pos: number[] = [];
  const nor: number[] = [];
  for (const g of parts) {
    pos.push(...(g.attributes.position!.array as Float32Array));
    nor.push(...(g.attributes.normal!.array as Float32Array));
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return merged;
}

export function buildOcean(def: SceneDef, scene: THREE.Scene, renderer: THREE.WebGLRenderer, quality: QualityName, makeSun: (def: SceneDef, q: QualityName, extent: number) => THREE.DirectionalLight): Environment {
  const group = new THREE.Group();
  const water = new THREE.Color(def.waterColor ?? '#0e5a73');
  scene.background = water.clone();
  scene.fog = new THREE.FogExp2(water.getHex(), def.fogDensity ?? 0.05);
  const r = prng(61);
  const uTime = { value: 0 };

  // Ambient light from the water: bright above, dark below.
  const envScene = new THREE.Scene();
  envScene.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(10, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader:
          'varying vec3 vDir; void main(){ float u = vDir.y * 0.5 + 0.5; gl_FragColor = vec4(mix(vec3(0.02,0.12,0.16), vec3(0.45,0.85,0.95), pow(u, 1.6)), 1.0); }',
      }),
    ),
  );
  const env = prefilter(renderer, envScene, 0);
  scene.environment = env.texture;
  scene.environmentIntensity = 0.7;

  const sun = makeSun(def, quality, 12);
  sun.color.set('#bfeaf2');
  group.add(sun, sun.target, new THREE.HemisphereLight('#6cc4dc', '#2a3a2c', 0.35));

  // Sand: ripples in the texture, gentle dunes beyond the pitch, caustics in the shader.
  const sand = sandTextures(def.ground ?? ['#b9a77f', '#cdbb92', '#ddd0aa']);
  sand.map.repeat.set(70, 70);
  sand.bump.repeat.set(70, 70);
  const groundGeo = new THREE.PlaneGeometry(300, 300, 200, 200);
  groundGeo.rotateX(-Math.PI / 2);
  const dunes = makeNoise(12, 63);
  const gp = groundGeo.attributes.position!;
  for (let i = 0; i < gp.count; i++) {
    const x = gp.getX(i);
    const z = gp.getZ(i);
    const away = Math.min(1, Math.max(0, Math.max(Math.abs(x) - 7, Math.abs(z) - 10, 0) / 12));
    gp.setY(i, (dunes(x / 300 + 0.5, z / 300 + 0.5) - 0.5) * 6 * away * away);
  }
  groundGeo.computeVertexNormals();
  const groundMat = new THREE.MeshStandardMaterial({ map: sand.map, bumpMap: sand.bump, bumpScale: 1.5, roughness: 1 });
  groundMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWorld; uniform float uTime;
        float caustic(vec2 p, float t) {
          vec2 q = p * 1.3;
          float c = 0.0;
          for (int i = 0; i < 3; i++) {
            q += vec2(sin(q.y * 1.7 + t * 0.8), cos(q.x * 1.4 - t * 0.6)) * 0.55;
            c += abs(sin(q.x + q.y));
          }
          return pow(max(0.0, 1.0 - c / 3.0), 3.0);
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(0.55, 0.85, 0.95) * caustic(vWorld.xz, uTime) * 0.5;`,
      );
  };
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.receiveShadow = true;
  group.add(ground);

  // Kelp: tall ribbons that sway more towards the tip.
  const kelpGeo = new THREE.PlaneGeometry(0.24, 1, 1, 10);
  kelpGeo.translate(0, 0.5, 0);
  const kelpMat = new THREE.MeshStandardMaterial({ color: '#7fa046', emissive: '#16240a', roughness: 0.75, side: THREE.DoubleSide });
  kelpMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vec4 iw = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float h = position.y;
      transformed.x += sin(uTime * 0.8 + iw.x * 0.4 + h * 2.0) * h * h * 0.25;
      transformed.z += cos(uTime * 0.6 + iw.z * 0.4 + h * 1.5) * h * h * 0.15;`,
    );
  };
  const kelpCount = def.kelp ?? 120;
  const kelp = new THREE.InstancedMesh(kelpGeo, kelpMat, kelpCount);
  const m = new THREE.Matrix4();
  const kc = new THREE.Color();
  let k = 0;
  for (let tries = 0; k < kelpCount && tries < kelpCount * 20; tries++) {
    // Clumps of kelp around the pitch.
    const a = r() * Math.PI * 2;
    const d = 7 + r() * 22;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (nearPitch(x, z, 3)) continue;
    const blades = 3 + Math.floor(r() * 5);
    for (let b = 0; b < blades && k < kelpCount; b++) {
      const bx = x + (r() - 0.5) * 0.8;
      const bz = z + (r() - 0.5) * 0.8;
      m.compose(new THREE.Vector3(bx, 0, bz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28), new THREE.Vector3(1 + r(), 1.5 + r() * 3, 1));
      kelp.setMatrixAt(k, m);
      kelp.setColorAt(k++, kc.set(r() < 0.5 ? '#5d7a2f' : '#6e6a2a').multiplyScalar(0.8 + r() * 0.4));
    }
  }
  kelp.count = k;
  kelp.castShadow = true;
  group.add(kelp);

  // Rocks and coral.
  const rockGeo = new THREE.DodecahedronGeometry(1, 1);
  const rockMat = new THREE.MeshStandardMaterial({ color: '#6d6a60', roughness: 0.95 });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 90);
  const coralGeo = new THREE.IcosahedronGeometry(1, 2);
  const cp = coralGeo.attributes.position!;
  const cn = makeNoise(6, 67);
  for (let i = 0; i < cp.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(cp, i);
    const n = v.clone().normalize();
    v.multiplyScalar(0.7 + cn(n.x * 0.5 + 0.5, n.y * 0.5 + 0.5 + n.z * 0.3) * 0.7);
    cp.setXYZ(i, v.x, Math.max(-0.2, v.y), v.z);
  }
  coralGeo.computeVertexNormals();
  const corals = new THREE.InstancedMesh(coralGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), 70);
  const coralColors = ['#e2725b', '#f2a65a', '#c86fa8', '#8f6bd6', '#e8d36a', '#ef8fa0'];
  let nr = 0;
  let nc = 0;
  for (let i = 0; i < 1500 && (nr < 90 || nc < 70); i++) {
    const x = (r() - 0.5) * 60;
    const z = (r() - 0.5) * 60;
    if (nearPitch(x, z, 2.5)) continue;
    if (r() < 0.55 && nr < 90) {
      const s = 0.1 + Math.pow(r(), 3) * 1.4;
      m.compose(new THREE.Vector3(x, s * 0.2, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3)), new THREE.Vector3(s, s * 0.7, s));
      rocks.setMatrixAt(nr++, m);
    } else if (nc < 70) {
      const s = 0.15 + r() * 0.45;
      m.compose(new THREE.Vector3(x, s * 0.3, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28), new THREE.Vector3(s, s * (0.6 + r()), s));
      corals.setMatrixAt(nc, m);
      corals.setColorAt(nc++, kc.set(coralColors[Math.floor(r() * coralColors.length)]!));
    }
  }
  rocks.count = nr;
  corals.count = nc;
  rocks.castShadow = rocks.receiveShadow = corals.castShadow = corals.receiveShadow = true;
  group.add(rocks, corals);

  // Shafts of light from the surface.
  const shaftMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uTime },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader:
      'varying vec2 vUv; uniform float uTime; void main(){ float edge = sin(vUv.x * 3.14159); float fade = smoothstep(0.0, 0.6, vUv.y); float flicker = 0.75 + 0.25 * sin(uTime * 0.7 + vUv.x * 9.0); gl_FragColor = vec4(vec3(0.6, 0.9, 1.0) * edge * fade * flicker * 0.09, 1.0); }',
  });
  const shafts: THREE.Mesh[] = [];
  for (let i = 0; i < 9; i++) {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.2 + r(), 0.4 + r() * 0.5, 22, 16, 1, true), shaftMat);
    shaft.position.set((r() - 0.5) * 26, 9, (r() - 0.5) * 26);
    shaft.rotation.set((r() - 0.5) * 0.3, 0, (r() - 0.5) * 0.3 + 0.15);
    shaft.userData.phase = r() * 6;
    shafts.push(shaft);
    group.add(shaft);
  }

  // Fish: schools circling at different heights, and some loners.
  const fishMat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 });
  fishMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      float tailAmount = smoothstep(0.0, -0.8, position.x);
      transformed.z += sin(uTime * 10.0 + float(gl_InstanceID) * 1.7) * tailAmount * 0.25;`,
    );
  };
  const fishCount = def.fish ?? 60;
  const fishMesh = new THREE.InstancedMesh(fishGeometry(), fishMat, fishCount);
  fishMesh.frustumCulled = false;
  const palette = ['#f28c28', '#f5d142', '#4fb0e8', '#e8e8e8', '#9a6dd7', '#ff6f61'];
  const fish: Fish[] = [];
  let made = 0;
  while (made < fishCount) {
    const school = r() < 0.7;
    const n = school ? 6 + Math.floor(r() * 8) : 1;
    const cx = (r() - 0.5) * 20;
    const cz = (r() - 0.5) * 24;
    const rad = 4 + r() * 10;
    const h = 2.2 + r() * 3.5;
    const speed = (0.25 + r() * 0.25) * (r() < 0.5 ? -1 : 1);
    const color = palette[Math.floor(r() * palette.length)]!;
    const scale = school ? 0.12 + r() * 0.08 : 0.25 + r() * 0.2;
    for (let i = 0; i < n && made < fishCount; i++, made++) {
      fish.push({ cx, cz, r: rad + (r() - 0.5) * 1.2, h: h + (r() - 0.5) * 0.8, speed, phase: r() * 0.6 + (school ? 0 : r() * 6), bob: r() * 6, scale: scale * (0.85 + r() * 0.3) });
      fishMesh.setColorAt(made, kc.set(color));
    }
  }
  group.add(fishMesh);

  const bubbles = new Bubbles();
  group.add(bubbles.points);
  const vents: Vec3[] = [];
  for (let i = 0; i < 6; i++) {
    const a = r() * Math.PI * 2;
    vents.push([Math.cos(a) * (8 + r() * 10), 0, Math.sin(a) * (8 + r() * 10)]);
  }

  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  return {
    group,
    sun,
    surface: 'sand',
    dustColor: new THREE.Color(def.ground?.[1] ?? '#cdbb92'),
    bubbles: (p, n) => bubbles.emit(p, n),
    update(dt, time) {
      uTime.value = time;
      for (const s of shafts) s.rotation.y = Math.sin(time * 0.1 + s.userData.phase) * 0.2;
      fish.forEach((f, i) => {
        const a = time * f.speed / (f.r * 0.25) + f.phase;
        const x = f.cx + Math.cos(a) * f.r;
        const z = f.cz + Math.sin(a) * f.r;
        const y = f.h + Math.sin(time * 0.7 + f.bob) * 0.25;
        // Face along the circle: the nose is local +x, and a turn of θ about +y sends +x to (cos θ, -sin θ).
        const sgn = Math.sign(f.speed);
        q.setFromAxisAngle(up, Math.atan2(-Math.cos(a) * sgn, -Math.sin(a) * sgn));
        m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(f.scale, f.scale, f.scale));
        fishMesh.setMatrixAt(i, m);
      });
      fishMesh.instanceMatrix.needsUpdate = true;
      if (Math.random() < dt * 3) {
        const v = vents[Math.floor(Math.random() * vents.length)]!;
        bubbles.emit(v, 3, 0.15);
      }
      bubbles.update(dt, time);
    },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const mat of mats) {
          for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
          mat.dispose();
        }
      });
      env.dispose();
      scene.environment = null;
      scene.background = null;
      scene.fog = null;
    },
  };
}

