// Meshes for the game pieces, sized from config so they match the physics.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CFG } from '../config.ts';
import { woodTextures } from './textures.ts';

/** How kubbs are finished: natural wood, a blue set and a white set (by starting half), or each half blue, half white. */
export type KubbPaint = 'wood' | 'sets' | 'twoTone';

export interface PieceKit {
  kubb(): THREE.Mesh;
  /** The material for a kubb that started on team `team`'s baseline. */
  kubbMaterial(paint: KubbPaint, team: 0 | 1): THREE.Material;
  king(): THREE.Group;
  baton(): THREE.Mesh;
  stake(): THREE.Group;
  ghostMaterial: THREE.MeshStandardMaterial;
  kubbGeometry: THREE.BufferGeometry;
}

function woodMaterial(seed: number, tint: string, roughness: number): THREE.MeshStandardMaterial {
  const tex = woodTextures(seed, tint);
  return new THREE.MeshStandardMaterial({ map: tex.map, bumpMap: tex.bump, bumpScale: 0.6, roughness, metalness: 0 });
}

export function createPieceKit(): PieceKit {
  const kubbMat = woodMaterial(1, '#a98457', 0.6);
  const kingMat = woodMaterial(2, '#9c774b', 0.55);
  const batonMat = woodMaterial(3, '#94693f', 0.5);
  const crownMat = new THREE.MeshStandardMaterial({ color: '#b8893c', roughness: 0.45 });
  // Painted wood: flat colour, the grain still showing through the bump map.
  const grain = kubbMat.bumpMap;
  const painted = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 0.48, bumpMap: grain, bumpScale: 0.25 });
  const blueMat = painted('#2f5ea8');
  const whiteMat = painted('#eeebe2');
  // Two-tone: top half blue, bottom half white, split in the kubb's own space.
  const twoToneMat = painted('#eeebe2');
  twoToneMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLocalY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocalY = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLocalY;')
      .replace('#include <color_fragment>', '#include <color_fragment>\nif (vLocalY > 0.0) diffuseColor.rgb = vec3(0.028, 0.111, 0.392);');
  };

  const [kw, kh, kd] = CFG.pieces.kubb.size;
  const kubbGeometry = new RoundedBoxGeometry(kw, kh, kd, 3, 0.004);
  // Wood grain runs along the length: RoundedBoxGeometry's UVs are per face already.

  const [Kw, Kh, Kd] = CFG.pieces.king.size;
  const crownH = 0.045;
  const kingBody = new RoundedBoxGeometry(Kw, Kh - crownH, Kd, 3, 0.005);

  const b = CFG.pieces.baton;
  // Lathe profile: a cylinder with softly rounded ends.
  const prof: THREE.Vector2[] = [];
  const r = b.radius;
  const hl = b.length / 2;
  const round = 0.006;
  prof.push(new THREE.Vector2(0, -hl));
  for (let i = 0; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    prof.push(new THREE.Vector2(r - round + Math.sin(a) * round, -hl + round - Math.cos(a) * round));
  }
  for (let i = 0; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    prof.push(new THREE.Vector2(r - round + Math.cos(a) * round, hl - round + Math.sin(a) * round));
  }
  prof.push(new THREE.Vector2(0, hl));
  const batonGeometry = new THREE.LatheGeometry(prof, 20);
  batonGeometry.computeVertexNormals();

  const st = CFG.pitch;
  const stakeGeometry = new THREE.CylinderGeometry(st.stakeRadius * 0.8, st.stakeRadius, st.stakeHeight, 10);
  const stakeTip = new THREE.ConeGeometry(st.stakeRadius * 0.8, 0.04, 10);
  const stakeMat = woodMaterial(4, '#e6d2b0', 0.6);
  const stakeTipMat = new THREE.MeshStandardMaterial({ color: '#d9d4c8', roughness: 0.5 });

  const shadow = (m: THREE.Object3D) => {
    m.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return m;
  };

  return {
    kubbGeometry,
    kubb: () => shadow(new THREE.Mesh(kubbGeometry, kubbMat)) as THREE.Mesh,
    kubbMaterial: (paint, team) => (paint === 'wood' ? kubbMat : paint === 'twoTone' ? twoToneMat : team === 0 ? blueMat : whiteMat),
    king: () => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(kingBody, kingMat);
      body.position.y = -crownH / 2;
      g.add(body);
      // Crown: a band and four points.
      const band = new THREE.Mesh(new THREE.BoxGeometry(Kw * 0.96, 0.012, Kd * 0.96), crownMat);
      band.position.y = Kh / 2 - crownH;
      g.add(band);
      const pointGeo = new THREE.ConeGeometry(0.018, crownH - 0.006, 4);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const p = new THREE.Mesh(pointGeo, kingMat);
        p.position.set(x * Kw * 0.3, Kh / 2 - crownH / 2 + 0.003, z * Kd * 0.3);
        p.rotation.y = Math.PI / 4;
        g.add(p);
      }
      return shadow(g) as THREE.Group;
    },
    baton: () => shadow(new THREE.Mesh(batonGeometry, batonMat)) as THREE.Mesh,
    stake: () => {
      const g = new THREE.Group();
      const s = new THREE.Mesh(stakeGeometry, stakeMat);
      s.position.y = st.stakeHeight / 2;
      const tip = new THREE.Mesh(stakeTip, stakeTipMat);
      tip.position.y = st.stakeHeight + 0.02;
      g.add(s, tip);
      return shadow(g) as THREE.Group;
    },
    ghostMaterial: new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.45, roughness: 0.6, depthWrite: false }),
  };
}
