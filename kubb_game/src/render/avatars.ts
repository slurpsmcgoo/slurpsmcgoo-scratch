// Players as stylised toy figures: rounded body, head with a simple face and a
// hat, and floating hands (no arms, so no arm IK to get wrong). On airless
// settings everyone wears a spacesuit with a gold visor.

import * as THREE from 'three';
import type { Player } from '../types.ts';
import { labelTexture } from './textures.ts';

const SKIN = ['#f1c9a5', '#e0ac85', '#c68863', '#9a6544', '#6e4a33', '#f5d7bf'];
const PANTS = ['#3b4a63', '#5a5040', '#2f3a33', '#4a4a50', '#6b5b46'];
const HAIR = ['#2b1d14', '#5a3a22', '#a8742f', '#1a1a1a', '#c9b089', '#7a3b1e'];
const HATS = ['cap', 'bucket', 'beanie', 'hair', 'cap', 'hair'] as const;

/** Arm swing angle (radians, 0 = hand straight down, + = forward). */
const REST = 0.2;
const BACK = -1.1;
const FRONT = 1.7;

function mat(color: string, roughness = 0.75, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

export type Outfit = 'casual' | 'space' | 'dive';

export class Avatar {
  readonly root = new THREE.Group();
  player: Player;
  private readonly torso = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly handL: THREE.Mesh;
  private readonly handR: THREE.Mesh;
  private readonly legL: THREE.Mesh;
  private readonly legR: THREE.Mesh;
  private readonly label: THREE.Sprite;
  /** Child of the right hand: whatever the player is holding. */
  readonly holdSlot = new THREE.Group();
  private target = new THREE.Vector3();
  private yaw = 0;
  private targetYaw = 0;
  private swing = REST;
  private throwT = -1;
  private walkPhase = 0;
  windup = 0;
  /** Beer mode: 0 sober, 1+ properly wobbly. */
  drunk = 0;
  private drinkT = -1;
  /** Child of the left hand: the can, in beer mode. */
  readonly canSlot = new THREE.Group();
  private time = Math.random() * 10;
  private headY = 1.56;

  constructor(player: Player, teamColor: string, outfit: Outfit) {
    const suit = outfit !== 'casual';
    const diver = outfit === 'dive';
    this.player = player;
    const look = player.look;
    const skin = SKIN[look % SKIN.length]!;
    const shirt = mat(teamColor, 0.85);
    const suitMat = diver ? mat('#7d7358', 0.9) : mat('#e9e7e1', 0.7);
    const bodyMat = suit ? suitMat : shirt;
    const handMat = diver ? mat('#3a3a36', 0.7) : suit ? mat('#cfcdc6', 0.6) : mat(skin, 0.6);

    const legGeo = new THREE.CapsuleGeometry(suit ? 0.095 : 0.075, 0.5, 4, 10);
    const legMat = suit ? suitMat : mat(PANTS[look % PANTS.length]!, 0.9);
    this.legL = new THREE.Mesh(legGeo, legMat);
    this.legR = new THREE.Mesh(legGeo, legMat);
    this.legL.position.set(-0.1, 0.4, 0);
    this.legR.position.set(0.1, 0.4, 0);
    const shoeGeo = new THREE.SphereGeometry(0.085, 12, 8);
    shoeGeo.scale(0.9, 0.55, 1.5);
    const shoeMat = diver ? mat('#3b3530', 0.5, 0.4) : suit ? mat('#9c9a94', 0.8) : mat('#2a2a2a', 0.6);
    for (const leg of [this.legL, this.legR]) {
      const shoe = new THREE.Mesh(shoeGeo, shoeMat);
      shoe.position.set(0, -0.33, 0.04);
      leg.add(shoe);
      this.root.add(leg);
    }

    const torsoGeo = new THREE.CapsuleGeometry(suit ? 0.25 : 0.2, 0.36, 6, 16);
    torsoGeo.scale(1, 1, suit ? 0.85 : 0.72);
    const body = new THREE.Mesh(torsoGeo, bodyMat);
    this.torso.add(body);
    if (diver) {
      const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.4, 4, 12), mat('#c9c4b4', 0.4, 0.6));
      tank.position.set(0, 0.05, -0.26);
      this.torso.add(tank);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.255, 0.255, 0.07, 24, 1, true), shirt);
      band.scale.z = 0.86;
      band.position.y = 0.12;
      this.torso.add(band);
    } else if (suit) {
      const pack = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.2), mat('#d8d6cf', 0.7));
      pack.position.set(0, 0.06, -0.27);
      this.torso.add(pack);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.255, 0.255, 0.07, 24, 1, true), shirt);
      band.scale.z = 0.86;
      band.position.y = 0.12;
      this.torso.add(band);
    } else {
      const collar = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.018, 8, 20), shirt);
      collar.rotation.x = Math.PI / 2;
      collar.position.y = 0.36;
      this.torso.add(collar);
    }
    this.torso.position.y = 1.1;
    this.root.add(this.torso);

    if (diver) this.buildDiveHelmet(teamColor);
    else if (suit) this.buildHelmet(teamColor);
    else this.buildHead(skin, look, teamColor);
    this.headY = suit ? 1.6 : 1.56;
    this.head.position.y = this.headY;
    this.root.add(this.head);

    const handGeo = new THREE.SphereGeometry(suit ? 0.068 : 0.055, 14, 10);
    handGeo.scale(1, 1.15, 0.85);
    this.handL = new THREE.Mesh(handGeo, handMat);
    this.handR = new THREE.Mesh(handGeo, handMat);
    this.handR.add(this.holdSlot);
    this.handL.add(this.canSlot);
    this.root.add(this.handL, this.handR);

    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(player.name, teamColor), depthTest: false, transparent: true }));
    this.label.scale.set(0.8, 0.2, 1);
    this.label.position.y = 2.0;
    this.label.renderOrder = 10;
    this.root.add(this.label);

    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
  }

  private buildHead(skin: string, look: number, teamColor: string): void {
    const skinMat = mat(skin, 0.6);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.135, 24, 18), skinMat);
    this.head.add(head);
    const eyeGeo = new THREE.SphereGeometry(0.016, 10, 8);
    const eyeMat = mat('#1b1b1b', 0.3);
    for (const x of [-0.045, 0.045]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(x, 0.02, 0.122);
      this.head.add(eye);
    }
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), skinMat);
    nose.position.set(0, -0.012, 0.135);
    this.head.add(nose);
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.007, 6, 16, Math.PI * 0.8), eyeMat);
    smile.position.set(0, -0.045, 0.118);
    smile.rotation.set(0.25, 0, Math.PI + Math.PI * 0.1);
    this.head.add(smile);

    const hair = mat(HAIR[look % HAIR.length]!, 0.9);
    const hatMat = mat(teamColor, 0.8);
    const kind = HATS[Math.floor(look / 2) % HATS.length]!;
    const capTop = (m: THREE.Material, r: number) => {
      const g = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), m);
      g.position.y = 0.02;
      return g;
    };
    if (kind === 'cap') {
      this.head.add(capTop(hatMat, 0.142));
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.012, 20, 1, false, -Math.PI / 2, Math.PI), hatMat);
      brim.position.set(0, 0.03, 0.12);
      brim.scale.z = 1.3;
      this.head.add(brim);
    } else if (kind === 'bucket') {
      this.head.add(capTop(mat('#d9cfae', 0.9), 0.145));
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.012, 24), mat('#d9cfae', 0.9));
      brim.position.y = 0.035;
      this.head.add(brim);
    } else if (kind === 'beanie') {
      const b = capTop(hatMat, 0.146);
      b.scale.y = 1.15;
      this.head.add(b);
      const pom = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), mat('#f2f0ea', 1));
      pom.position.y = 0.19;
      this.head.add(pom);
    } else {
      const h = capTop(hair, 0.142);
      h.rotation.x = -0.25;
      this.head.add(h);
    }
  }

  private buildHelmet(teamColor: string): void {
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.2, 28, 20), mat('#efede8', 0.45));
    this.head.add(shell);
    const visor = new THREE.Mesh(
      new THREE.SphereGeometry(0.205, 28, 16, -Math.PI * 0.32, Math.PI * 0.64, Math.PI * 0.28, Math.PI * 0.36),
      new THREE.MeshStandardMaterial({ color: '#d9a640', metalness: 1, roughness: 0.12 }),
    );
    visor.rotation.y = Math.PI / 2 - Math.PI / 2;
    this.head.add(visor);
    const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.012, 6, 32), mat(teamColor, 0.6));
    stripe.rotation.x = Math.PI / 2;
    stripe.position.y = -0.06;
    this.head.add(stripe);
  }

  /** A classic brass diving helmet with portholes. */
  private buildDiveHelmet(teamColor: string): void {
    const brass = mat('#b8823e', 0.32, 0.9);
    const glass = new THREE.MeshStandardMaterial({ color: '#1d3a40', roughness: 0.05, metalness: 0.3 });
    this.head.add(new THREE.Mesh(new THREE.SphereGeometry(0.2, 28, 20), brass));
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.26, 0.1, 24), brass);
    collar.position.y = -0.2;
    this.head.add(collar);
    const port = (radius: number, dir: THREE.Vector3) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.018, 8, 24), brass);
      const pane = new THREE.Mesh(new THREE.CircleGeometry(radius, 24), glass);
      const g = new THREE.Group();
      g.add(ring, pane);
      g.position.copy(dir.clone().multiplyScalar(0.195));
      g.lookAt(dir.clone().multiplyScalar(2));
      this.head.add(g);
    };
    port(0.085, new THREE.Vector3(0, 0.02, 1).normalize());
    port(0.05, new THREE.Vector3(1, 0.05, 0.2).normalize());
    port(0.05, new THREE.Vector3(-1, 0.05, 0.2).normalize());
    const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.205, 0.012, 6, 32), mat(teamColor, 0.6));
    stripe.rotation.x = Math.PI / 2;
    stripe.position.y = -0.1;
    this.head.add(stripe);
  }

  /** Walk to a spot (feet position) and face a point. */
  moveTo(p: THREE.Vector3, face: THREE.Vector3): void {
    this.target.copy(p);
    this.targetYaw = Math.atan2(face.x - p.x, face.z - p.z);
  }

  placeAt(p: THREE.Vector3, face: THREE.Vector3): void {
    this.moveTo(p, face);
    this.root.position.copy(p);
    this.yaw = this.targetYaw;
  }

  setHeld(obj: THREE.Object3D | null): void {
    this.holdSlot.clear();
    if (obj) this.holdSlot.add(obj);
  }

  setCan(obj: THREE.Object3D | null): void {
    this.canSlot.clear();
    if (obj) {
      obj.position.set(0, 0.02, 0.03);
      this.canSlot.add(obj);
    }
  }

  /** Raise the can for a long swig. */
  drinkNow(): void {
    this.drinkT = 0;
  }

  /** Play the underhand swing and follow-through. */
  throwNow(): void {
    this.throwT = 0;
    this.windup = 0;
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  update(dt: number): void {
    this.time += dt;
    // Walk.
    const to = this.target.clone().sub(this.root.position);
    to.y = 0;
    const dist = to.length();
    const walking = dist > 0.03;
    if (walking) {
      const step = Math.min(dist, 1.6 * dt);
      this.root.position.addScaledVector(to.normalize(), step);
      this.walkPhase += dt * 9;
    } else {
      this.walkPhase *= 0.9;
    }
    const want = walking ? Math.atan2(to.x, to.z) : this.targetYaw;
    let d = want - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * Math.min(1, dt * 8);
    this.root.rotation.y = this.yaw;
    // Beer mode: a slow sway that grows with drunkenness.
    const sway = Math.min(1.5, this.drunk);
    this.root.rotation.z = Math.sin(this.time * 1.1) * 0.06 * sway;
    this.root.rotation.x = Math.sin(this.time * 0.77 + 1) * 0.04 * sway;
    const legSwing = walking ? Math.sin(this.walkPhase) * 0.5 : 0;
    this.legL.rotation.x = legSwing;
    this.legR.rotation.x = -legSwing;

    // Breathing bob.
    const bob = Math.sin(this.time * 2.1) * 0.008 + (walking ? Math.abs(Math.sin(this.walkPhase)) * 0.03 : 0);
    this.torso.position.y = 1.1 + bob;
    this.head.position.y = this.headY + bob * 1.2;

    // Right hand: underhand arm swing about the shoulder.
    let target = REST + (BACK - REST) * this.windup;
    if (this.throwT >= 0) {
      this.throwT += dt;
      const t = this.throwT;
      if (t < 0.22) target = BACK + (FRONT - BACK) * (t / 0.22);
      else if (t < 0.9) target = FRONT + (REST - FRONT) * ((t - 0.22) / 0.68);
      else this.throwT = -1;
      this.swing = target;
    } else {
      this.swing += (target - this.swing) * Math.min(1, dt * 12);
    }
    const sh = new THREE.Vector3(0.24, 1.36 + bob, 0.02);
    const R = 0.6;
    this.handR.position.set(sh.x, sh.y - Math.cos(this.swing) * R, sh.z + Math.sin(this.swing) * R);
    this.handR.rotation.x = this.swing;
    const lw = walking ? -legSwing * 0.4 : Math.sin(this.time * 1.3) * 0.03;
    this.handL.position.set(-0.3, 0.86 + bob + Math.sin(this.time * 1.7) * 0.01, 0.04 + lw * 0.3);
    this.handL.rotation.x = 0;
    if (this.drinkT >= 0) {
      this.drinkT += dt;
      // Up to the mouth, tip, hold, back down.
      const t = this.drinkT;
      const k = t < 0.35 ? t / 0.35 : t < 1.35 ? 1 : Math.max(0, 1 - (t - 1.35) / 0.35);
      this.handL.position.lerp(new THREE.Vector3(-0.08, this.headY - 0.06, 0.16), k);
      this.handL.rotation.x = -1.9 * k;
      if (t > 1.7) this.drinkT = -1;
    }
  }
}

/** The local player's own hand in first person: a hand and whatever it holds, attached to the camera. */
export class FirstPersonHand {
  readonly root = new THREE.Group();
  readonly holdSlot = new THREE.Group();
  private readonly hand: THREE.Mesh;
  private throwT = -1;
  windup = 0;
  visible = false;

  constructor(skin: string) {
    const geo = new THREE.SphereGeometry(0.03, 16, 12);
    geo.scale(1, 1.15, 0.85);
    this.hand = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: skin, roughness: 0.6 }));
    this.hand.add(this.holdSlot);
    this.root.add(this.hand);
  }

  setHeld(obj: THREE.Object3D | null): void {
    this.holdSlot.clear();
    if (obj) this.holdSlot.add(obj);
  }

  throwNow(): void {
    this.throwT = 0;
  }

  update(dt: number): void {
    let swing = 0.25 - this.windup * 1.0;
    let show = this.visible;
    if (this.throwT >= 0) {
      this.throwT += dt;
      swing = -0.75 + this.throwT * 9;
      if (this.throwT > 0.25) {
        this.throwT = -1;
      }
      show = true;
    }
    this.root.visible = show;
    // In camera space: lower right, swinging up and forward.
    // Keep the hand inside the view on narrow (portrait) screens too.
    const aspect = (this.root.parent as THREE.PerspectiveCamera | null)?.aspect ?? 1.5;
    this.hand.position.set(0.13 * Math.min(1.2, aspect), -0.2 - Math.cos(swing) * 0.08 - this.windup * 0.12, -0.55 - Math.sin(swing) * 0.15);
    this.hand.rotation.x = swing * 0.8 - 0.5;
  }
}
