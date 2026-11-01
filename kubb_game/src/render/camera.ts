// Camera rig: eases between viewpoints (first person at the throw line,
// watching a throw, over the defending half for placing, the whole pitch).

import * as THREE from 'three';
import { CFG } from '../config.ts';

export type CameraMode = 'aim' | 'follow' | 'place' | 'overview' | 'spectate' | 'menu';

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'menu';
  private pos = new THREE.Vector3(8, 4, 10);
  private look = new THREE.Vector3();
  private wantPos = new THREE.Vector3(8, 4, 10);
  private wantLook = new THREE.Vector3();
  private menuAngle = 0;
  /** Seconds to snap instead of easing (after a cut). */
  private snap = 0;
  /** Hold-to-zoom for aiming at distant kubbs. */
  zoom = false;
  /** Beer mode: how much the view rolls and drifts (radians). */
  sway = 0;
  private swayT = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(CFG.camera.fov, aspect, 0.03, 20000);
  }

  set(mode: CameraMode, pos: THREE.Vector3, look: THREE.Vector3, cut = false): void {
    this.mode = mode;
    this.wantPos.copy(pos);
    this.wantLook.copy(look);
    if (cut) this.snap = 0.05;
  }

  /** Keep the position, turn to look at something moving. */
  track(look: THREE.Vector3): void {
    this.wantLook.copy(look);
  }

  update(dt: number): void {
    if (this.mode === 'menu') {
      this.menuAngle += dt * 0.06;
      this.wantPos.set(Math.sin(this.menuAngle) * 9, 3.2, Math.cos(this.menuAngle) * 9);
      this.wantLook.set(0, 0.2, 0);
    }
    const kp = this.snap > 0 ? 1 : 1 - Math.exp(-CFG.camera.moveLerp * dt);
    const kl = this.snap > 0 ? 1 : 1 - Math.exp(-CFG.camera.followLerp * dt);
    this.snap -= dt;
    this.pos.lerp(this.wantPos, kp);
    this.look.lerp(this.wantLook, kl);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    if (this.sway > 0) {
      this.swayT += dt;
      const t = this.swayT;
      this.camera.rotateZ(Math.sin(t * 0.8) * this.sway);
      this.camera.rotateY(Math.sin(t * 0.53 + 1.3) * this.sway * 0.5);
      this.camera.rotateX(Math.sin(t * 0.67 + 0.4) * this.sway * 0.35);
    }
    const fov = this.zoom ? CFG.camera.zoomFov : CFG.camera.fov;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 12);
      this.camera.updateProjectionMatrix();
    }
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
