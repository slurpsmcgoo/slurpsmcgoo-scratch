// Settings: the world around the pitch. Each builds its sky, light, ground and
// scenery from a preset in config/kubb.json. Physics for the setting lives in
// the same preset and is applied by the sim, not here.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CFG, DEG, sceneDef, type QualityName, type SceneDef } from '../config.ts';
import type { Vec3 } from '../types.ts';
import { ImpactField } from './impacts.ts';
import { buildOcean } from './ocean.ts';
import { barkTexture, earthTexture, lawnTexture, macroNoiseTexture, makeNoise, prng, regolithTextures } from './textures.ts';

export interface Environment {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  surface: 'grass' | 'regolith' | 'sand';
  /** Colour of what impacts kick up. */
  dustColor: THREE.Color;
  update(dt: number, time: number): void;
  dispose(): void;
  /** Underwater settings: release n bubbles at p. */
  bubbles?(p: Vec3, n: number): void;
  /** Settings with a soft surface: leave a lasting dent where something hit the ground. */
  deform?(p: Vec3, strength: number): void;
  /** Clear marks left by a previous game. */
  reset?(): void;
}

/** Keep things off the pitch and its surroundings, where people stand. */
function nearPitch(x: number, z: number, margin: number): boolean {
  return Math.abs(x) < 2.5 + margin && Math.abs(z) < 4 + margin;
}

function sunDirection(def: SceneDef): THREE.Vector3 {
  return new THREE.Vector3().setFromSphericalCoords(1, (90 - def.sunElevationDeg) * DEG, def.sunAzimuthDeg * DEG);
}

function makeSun(def: SceneDef, quality: QualityName, extent: number): THREE.DirectionalLight {
  const sun = new THREE.DirectionalLight(0xffffff, def.sunIntensity);
  sun.position.copy(sunDirection(def).multiplyScalar(40));
  sun.castShadow = true;
  const size = CFG.quality[quality].shadowMap;
  sun.shadow.mapSize.set(size, size);
  const c = sun.shadow.camera;
  c.left = -extent;
  c.right = extent;
  c.top = extent;
  c.bottom = -extent;
  c.near = 1;
  c.far = 120;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.015;
  return sun;
}

/**
 * Prefilter a scene into environment lighting, then free everything used to
 * make it. Dispose the returned target (not just its texture) when done.
 */
export function prefilter(renderer: THREE.WebGLRenderer, envScene: THREE.Scene, sigma: number): THREE.WebGLRenderTarget {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(envScene, sigma);
  pmrem.dispose();
  disposeAll(envScene);
  return target;
}

export function buildEnvironment(name: string, scene: THREE.Scene, renderer: THREE.WebGLRenderer, quality: QualityName): Environment {
  const def = sceneDef(name);
  if (def.surface === 'sand') return buildOcean(def, scene, renderer, quality, makeSun);
  return def.surface === 'regolith' ? buildMoon(def, scene, renderer, quality) : buildPark(def, scene, renderer, quality);
}

function disposeAll(group: THREE.Object3D): void {
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
  });
}

// ---------------------------------------------------------------- park

function buildPark(def: SceneDef, scene: THREE.Scene, renderer: THREE.WebGLRenderer, quality: QualityName): Environment {
  const group = new THREE.Group();
  const q = CFG.quality[quality];
  const sunDir = sunDirection(def);

  const sky = new Sky();
  sky.scale.setScalar(10000);
  const u = sky.material.uniforms;
  u.turbidity!.value = def.turbidity;
  u.rayleigh!.value = def.rayleigh;
  u.mieCoefficient!.value = def.mieCoefficient;
  u.mieDirectionalG!.value = def.mieDirectionalG;
  u.sunPosition!.value.copy(sunDir);
  group.add(sky);

  // Light the scene with the same sky: a prefiltered environment map.
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(1000);
  Object.assign(envSky.material.uniforms, THREE.UniformsUtils.clone(u));
  envSky.material.uniforms.sunPosition!.value.copy(sunDir);
  envScene.add(envSky);
  const env = prefilter(renderer, envScene, 0.02);
  scene.environment = env.texture;
  scene.environmentIntensity = 0.55;
  scene.background = null;

  scene.fog = new THREE.Fog(def.fogColor ?? '#c8d8e4', def.fogNear ?? 40, def.fogFar ?? 160);

  const sun = makeSun(def, quality, 11);
  sun.color.set('#fff4e2');
  group.add(sun, sun.target);
  group.add(new THREE.HemisphereLight('#bcd6ff', '#55693a', 0.2));

  // Lawn with large-scale patchiness and mowing stripes.
  const grassColors = def.grass ?? ['#4f7a2a', '#6b9637', '#87ad45'];
  const lawn = lawnTexture(grassColors);
  lawn.repeat.set(160, 160);
  const macro = macroNoiseTexture();
  const groundMat = new THREE.MeshStandardMaterial({ map: lawn, roughness: 0.95, metalness: 0 });
  const stripes = def.stripes ? 1 : 0;
  groundMat.onBeforeCompile = (shader) => {
    shader.uniforms.macroMap = { value: macro };
    shader.uniforms.stripes = { value: stripes };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;\nuniform sampler2D macroMap;\nuniform float stripes;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec2 wp = vWorld.xz;
        float m1 = texture2D(macroMap, wp / 70.0).r;
        float m2 = texture2D(macroMap, wp / 9.0 + 0.37).r;
        diffuseColor.rgb *= 0.74 + 0.4 * m1 + 0.16 * (m2 - 0.5);
        float inside = (1.0 - smoothstep(6.0, 9.0, abs(wp.x))) * (1.0 - smoothstep(9.0, 13.0, abs(wp.y)));
        float band = smoothstep(0.45, 0.55, fract(wp.x / 2.4 + 0.5)) - smoothstep(0.95, 1.0, fract(wp.x / 2.4 + 0.5));
        diffuseColor.rgb *= 1.0 + stripes * inside * (band - 0.5) * 0.14;`,
      );
  };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  const grass = q.grassBlades > 0 ? grassBlades(q.grassBlades, grassColors) : null;
  if (grass) group.add(grass.mesh);
  if (def.trees) group.add(trees(q.trees, def.treeColor ?? ['#3d6b26', '#4e7d2c'], 1));

  return {
    group,
    sun,
    surface: 'grass',
    dustColor: new THREE.Color('#6b5a3c'),
    update(_dt, time) {
      if (grass) grass.uniforms.uTime.value = time;
    },
    dispose() {
      disposeAll(group);
      macro.dispose();
      env.dispose();
      scene.environment = null;
      scene.fog = null;
    },
  };
}

function grassBlades(count: number, colors: string[]) {
  const segs = 3;
  const pos: number[] = [];
  const col: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const w = 0.5 * (1 - t * 0.9);
    pos.push(-w, t, 0, w, t, 0);
    const shade = 0.45 + 0.55 * t;
    col.push(shade, shade, shade, shade, shade, shade);
    nor.push(0, 1, 0, 0, 1, 0);
    if (i < segs) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 });
  const uniforms = { uTime: { value: 0 } };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 iw = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float sway = sin(uTime * 1.6 + iw.x * 0.7 + iw.z * 0.5) * 0.6 + sin(uTime * 3.3 + iw.x * 2.3 + iw.z * 1.7) * 0.3;
        transformed.x += sway * position.y * position.y * 0.18;`,
      );
  };
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.receiveShadow = true;
  const r = prng(31);
  const m = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const e = new THREE.Euler();
  const c = new THREE.Color();
  const palette = colors.map((h) => new THREE.Color(h));
  for (let i = 0; i < count; i++) {
    const x = (r() - 0.5) * 14;
    const z = (r() - 0.5) * 22;
    const h = 0.025 + r() * 0.035;
    e.set((r() - 0.5) * 0.5, r() * Math.PI, (r() - 0.5) * 0.5);
    quat.setFromEuler(e);
    m.compose(new THREE.Vector3(x, 0, z), quat, new THREE.Vector3(0.006 + r() * 0.006, h, 1));
    mesh.setMatrixAt(i, m);
    c.copy(palette[Math.floor(r() * palette.length)]!).multiplyScalar(0.55 + r() * 0.3);
    mesh.setColorAt(i, c);
  }
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}

/** A deciduous tree: tapered trunk and a clumpy canopy of displaced spheres. */
function treeGeometries(seed: number, leafColors: string[]): { trunk: THREE.BufferGeometry; canopy: THREE.BufferGeometry } {
  const r = prng(seed);
  const height = 3 + r() * 2.5;
  const trunk = new THREE.CylinderGeometry(0.13, 0.24, height, 9, 4);
  trunk.translate(0, height / 2, 0);
  const noise = makeNoise(8, seed);
  const blobs: THREE.BufferGeometry[] = [];
  const n = 6 + Math.floor(r() * 4);
  const palette = leafColors.map((h) => new THREE.Color(h));
  for (let i = 0; i < n; i++) {
    const rad = 1.1 + r() * 0.9;
    const g = new THREE.IcosahedronGeometry(rad, 3);
    const a = r() * Math.PI * 2;
    const d = i === 0 ? 0 : 0.9 + r() * 0.8;
    const cy = height + 0.6 + (r() - 0.3) * 1.4;
    const p = g.attributes.position!;
    const cols: number[] = [];
    const base = palette[Math.floor(r() * palette.length)]!;
    for (let k = 0; k < p.count; k++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, k);
      const nn = v.clone().normalize();
      const bump = noise(nn.x * 0.5 + 0.5 + i * 0.13, nn.y * 0.5 + 0.5 + nn.z * 0.31);
      v.multiplyScalar(0.82 + bump * 0.36);
      p.setXYZ(k, v.x, v.y, v.z);
      // Darker underneath and inside: cheap ambient occlusion.
      const shade = 0.55 + 0.45 * (nn.y * 0.5 + 0.5) + (bump - 0.5) * 0.25;
      cols.push(base.r * shade, base.g * shade, base.b * shade);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.translate(Math.cos(a) * d, cy, Math.sin(a) * d);
    g.computeVertexNormals();
    blobs.push(g);
  }
  return { trunk, canopy: mergeGeometries(blobs)! };
}

function trees(count: number, leafColors: string[], seed: number): THREE.Group {
  const group = new THREE.Group();
  const bark = barkTexture();
  bark.map.repeat.set(2, 3);
  bark.bump.repeat.set(2, 3);
  const trunkMat = new THREE.MeshStandardMaterial({ map: bark.map, bumpMap: bark.bump, roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  const variants = 4;
  const r = prng(seed * 101);
  const spots: [number, number, number][] = [];
  const total = count * 3;
  for (let tries = 0; spots.length < total && tries < total * 20; tries++) {
    const near = spots.length < count;
    const a = r() * Math.PI * 2;
    const d = near ? 14 + r() * 26 : 45 + r() * 70;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (nearPitch(x, z, 9)) continue;
    if (spots.some(([sx, sz]) => (sx - x) ** 2 + (sz - z) ** 2 < 16)) continue;
    spots.push([x, z, 0.8 + r() * 0.6]);
  }
  for (let v = 0; v < variants; v++) {
    const { trunk, canopy } = treeGeometries(seed * 13 + v, leafColors);
    const mine = spots.filter((_, i) => i % variants === v);
    const tm = new THREE.InstancedMesh(trunk, trunkMat, mine.length);
    const cm = new THREE.InstancedMesh(canopy, leafMat, mine.length);
    const m = new THREE.Matrix4();
    mine.forEach(([x, z, s], i) => {
      m.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28), new THREE.Vector3(s, s, s));
      tm.setMatrixAt(i, m);
      cm.setMatrixAt(i, m);
    });
    tm.castShadow = cm.castShadow = true;
    tm.receiveShadow = cm.receiveShadow = true;
    group.add(tm, cm);
  }
  return group;
}

// ---------------------------------------------------------------- moon

function buildMoon(def: SceneDef, scene: THREE.Scene, renderer: THREE.WebGLRenderer, quality: QualityName): Environment {
  const group = new THREE.Group();
  const sunDir = sunDirection(def);
  scene.background = new THREE.Color('#000000');
  scene.fog = null;

  // No atmosphere: light comes from the sun, and a little bounces off the ground.
  const envScene = new THREE.Scene();
  const envMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {},
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vDir; void main(){ float g = smoothstep(0.05, -0.25, vDir.y); gl_FragColor = vec4(vec3(0.55, 0.54, 0.52) * g, 1.0); }',
  });
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), envMat));
  const env = prefilter(renderer, envScene, 0);
  scene.environment = env.texture;
  scene.environmentIntensity = 0.55;

  const sun = makeSun(def, quality, 14);
  group.add(sun, sun.target);
  group.add(new THREE.HemisphereLight('#1a2236', '#4a4844', 0.12));

  // Stars.
  const r = prng(41);
  const starCount = def.stars ?? 2500;
  const starPos: number[] = [];
  const starCol: number[] = [];
  for (let i = 0; i < starCount; i++) {
    const v = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    if (v.lengthSq() > 1 || v.lengthSq() < 0.01) {
      i--;
      continue;
    }
    v.normalize().multiplyScalar(900);
    starPos.push(v.x, Math.abs(v.y) * 0.98 + 10, v.z);
    const b = 0.4 + r() * r() * 1.4;
    const warm = r();
    starCol.push(b * (0.85 + 0.15 * warm), b * 0.9, b * (1.05 - 0.2 * warm));
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  starGeo.setAttribute('color', new THREE.Float32BufferAttribute(starCol, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false }));
  group.add(stars);

  // The sun's disc and a soft glow.
  const glowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.12, 'rgba(255,252,240,1)');
    grd.addColorStop(0.2, 'rgba(255,245,225,0.35)');
    grd.addColorStop(1, 'rgba(255,240,220,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  sunSprite.position.copy(sunDir).multiplyScalar(850);
  sunSprite.scale.setScalar(120);
  group.add(sunSprite);

  // The Earth, lit by the same sun.
  const earthDir = new THREE.Vector3().setFromSphericalCoords(1, (90 - (def.earthElevationDeg ?? 38)) * DEG, (def.earthAzimuthDeg ?? 20) * DEG);
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(16, 64, 32),
    new THREE.MeshStandardMaterial({ map: earthTexture(), roughness: 0.7, metalness: 0, fog: false }),
  );
  earth.position.copy(earthDir).multiplyScalar(800);
  earth.rotation.set(0.4, 2.2, 0.1);
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(17.2, 48, 24),
    new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      uniforms: { sunDir: { value: sunDir } },
      vertexShader:
        'varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
      fragmentShader:
        'varying vec3 vN; varying vec3 vV; void main(){ float rim = pow(1.0 - max(dot(vN, vV), 0.0), 3.0); gl_FragColor = vec4(vec3(0.35,0.6,1.0) * rim * 1.4, rim); }',
    }),
  );
  atmo.position.copy(earth.position);
  group.add(earth, atmo);

  // Regolith: flat where the game is played, cratered and rolling beyond.
  const colors = def.ground ?? ['#77746f', '#8c8a85', '#a3a09a'];
  const reg = regolithTextures(colors);
  reg.map.repeat.set(45, 45);
  reg.bump.repeat.set(45, 45);
  const groundGeo = new THREE.PlaneGeometry(700, 700, 280, 280);
  groundGeo.rotateX(-Math.PI / 2);
  const craters: [number, number, number][] = [];
  const nCraters = def.craters ?? 60;
  for (let i = 0; i < nCraters; i++) {
    const a = r() * Math.PI * 2;
    const d = 12 + Math.pow(r(), 0.7) * 260;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const rad = 1.5 + Math.pow(r(), 3) * 30;
    if (nearPitch(x, z, rad + 4)) continue;
    craters.push([x, z, rad]);
  }
  const hills = makeNoise(16, 43);
  const heightAt = (x: number, z: number): number => {
    // The impact field covers the playing area; the ground sits just below it there, so dents show.
    if (Math.abs(x) <= 7 && Math.abs(z) <= 10) return -0.05;
    const flat = Math.min(1, Math.max(0, Math.max(Math.abs(x) - 7, Math.abs(z) - 10, 0) / 14));
    let y = (hills(x / 700 + 0.5, z / 700 + 0.5) - 0.5) * 14 * flat * flat;
    for (const [cx, cz, cr] of craters) {
      const d = Math.hypot(x - cx, z - cz) / cr;
      if (d < 1) y += -cr * 0.22 * (1 - d * d) + cr * 0.06;
      else if (d < 1.6) y += cr * 0.06 * Math.pow((1.6 - d) / 0.6, 2);
    }
    return y;
  };
  const pos = groundGeo.attributes.position!;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  groundGeo.computeVertexNormals();
  const groundMat = new THREE.MeshStandardMaterial({ map: reg.map, bumpMap: reg.bump, bumpScale: 2.5, roughness: 1, metalness: 0 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.receiveShadow = true;
  group.add(ground);
  const impacts = new ImpactField(groundMat, 14, 20, 0.05);
  group.add(impacts.mesh);

  // Scattered rocks.
  const rockGeo = new THREE.DodecahedronGeometry(1, 1);
  const rp = rockGeo.attributes.position!;
  const rn = makeNoise(4, 47);
  for (let i = 0; i < rp.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(rp, i);
    v.multiplyScalar(0.7 + rn(v.x * 0.5 + 0.5, v.z * 0.5 + 0.5 + v.y * 0.2) * 0.6);
    rp.setXYZ(i, v.x, v.y * 0.7, v.z);
  }
  rockGeo.computeVertexNormals();
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: '#8a8782', roughness: 0.95 }), 260);
  const m = new THREE.Matrix4();
  let placed = 0;
  for (let i = 0; i < 2000 && placed < 260; i++) {
    const x = (r() - 0.5) * 140;
    const z = (r() - 0.5) * 140;
    if (nearPitch(x, z, 3)) continue;
    const s = 0.04 + Math.pow(r(), 4) * 1.2;
    m.compose(new THREE.Vector3(x, heightAt(x, z) + s * 0.2, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3)), new THREE.Vector3(s, s, s));
    rocks.setMatrixAt(placed++, m);
  }
  rocks.count = placed;
  rocks.castShadow = rocks.receiveShadow = true;
  group.add(rocks);

  const lm = lander();
  lm.position.y = heightAt(lm.position.x, lm.position.z) - 0.05;
  group.add(lm);

  return {
    group,
    sun,
    surface: 'regolith',
    dustColor: new THREE.Color(colors[2]),
    deform: (p, strength) => impacts.dent(p[0], p[2], strength),
    reset: () => impacts.reset(),
    update() {
      impacts.flush();
    },
    dispose() {
      disposeAll(group);
      env.dispose();
      scene.environment = null;
      scene.background = null;
    },
  };
}

/** A lunar module descent stage, parked a respectful distance away. */
function lander(): THREE.Group {
  const g = new THREE.Group();
  const foil = new THREE.MeshStandardMaterial({ color: '#c9a043', metalness: 1, roughness: 0.32 });
  const grey = new THREE.MeshStandardMaterial({ color: '#b9b8b2', metalness: 0.3, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: '#2b2b2b', roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 1.6, 8), foil);
  body.position.y = 1.6;
  g.add(body);
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.8, 2.2), grey);
  top.position.y = 3.3;
  g.add(top);
  const window = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.05), dark);
  window.position.set(0.5, 3.6, 1.12);
  g.add(window);
  const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.6, 0.8, 16, 1, true), dark);
  nozzle.position.y = 0.6;
  g.add(nozzle);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.6), grey);
    leg.position.set(Math.cos(a) * 2.3, 1.1, Math.sin(a) * 2.3);
    leg.lookAt(Math.cos(a) * 1.6, 2.3, Math.sin(a) * 1.6);
    leg.rotateX(Math.PI / 2);
    g.add(leg);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 0.1, 16), foil);
    pad.position.set(Math.cos(a) * 2.9, 0.05, Math.sin(a) * 2.9);
    g.add(pad);
  }
  g.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  g.position.set(-17, 0, 11);
  g.rotation.y = 0.6;
  return g;
}
