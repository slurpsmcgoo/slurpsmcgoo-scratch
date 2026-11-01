// WebXR: throw with your arm. Hold the trigger to grab, swing, let go; the
// release velocity comes from the last few frames of controller tracking.
// UNTESTED on hardware: written to the WebXR spec and Three.js's XR API, but
// no headset has run it yet.

import * as THREE from 'three';
import { CFG } from '../config.ts';
import type { GameController } from '../game/controller.ts';
import { HALF_W, forward, other } from '../sim/pitch.ts';
import { kubbsToThrow, raiseCandidates, throwLineZ, throwingTeam, validPenaltySpot } from '../sim/rules.ts';
import { makeIntent, speedScale } from '../throw/model.ts';
import type { Stage } from '../render/stage.ts';

interface Sample {
  p: THREE.Vector3;
  t: number;
}

export class XRInput {
  readonly dolly = new THREE.Group();
  private controllers: THREE.Group[] = [];
  private holding: number | null = null;
  private samples: Sample[] = [];
  private hands: THREE.Mesh[] = [];
  private held: THREE.Object3D;

  constructor(
    private readonly stage: Stage,
    private readonly getCtl: () => GameController | null,
    private readonly message: (t: string) => void,
  ) {
    const xr = stage.renderer.xr;
    this.held = stage.kit.baton();
    this.held.rotation.x = Math.PI / 2;
    for (let i = 0; i < 2; i++) {
      const c = xr.getController(i);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12), new THREE.MeshStandardMaterial({ color: '#e0ac85', roughness: 0.6 }));
      c.add(hand);
      this.hands.push(hand);
      c.addEventListener('selectstart', () => this.grab(i));
      c.addEventListener('selectend', () => this.release(i));
      this.dolly.add(c);
      this.controllers.push(c);
    }
    xr.addEventListener('sessionstart', () => {
      stage.scene.add(this.dolly);
      this.dolly.add(stage.rig.camera);
    });
    xr.addEventListener('sessionend', () => {
      stage.scene.add(stage.rig.camera);
      stage.scene.remove(this.dolly);
    });
  }

  static async supported(): Promise<boolean> {
    try {
      return !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr'));
    } catch {
      return false;
    }
  }

  async enter(): Promise<void> {
    const session = await navigator.xr!.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    this.stage.renderer.xr.setReferenceSpaceType('local-floor');
    await this.stage.renderer.xr.setSession(session);
  }

  private grab(i: number): void {
    const ctl = this.getCtl();
    const actor = ctl?.localHuman();
    if (!ctl || !actor) return;
    if (actor.act === 'raise' || actor.act === 'penalty') {
      this.pointAndPlace(i, ctl);
      return;
    }
    this.holding = i;
    this.samples = [];
    this.controllers[i]!.add(this.held);
  }

  private pointAndPlace(i: number, ctl: GameController): void {
    const c = this.controllers[i]!;
    const origin = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(c.getWorldQuaternion(new THREE.Quaternion()));
    const hit = this.stage.pickRay(origin, dir);
    if (!hit) return;
    const s = ctl.state;
    if (s.phase === 'raise') {
      const k = s.pieces.find((p) => p.id === s.raiseQueue[0])!;
      const [c0, c1] = raiseCandidates(k);
      const end: 0 | 1 = Math.hypot(hit.x - c0[0], hit.z - c0[2]) <= Math.hypot(hit.x - c1[0], hit.z - c1[2]) ? 0 : 1;
      ctl.act({ type: 'raise', kubbId: k.id, end });
    } else if (validPenaltySpot(s, other(s.turn), hit.x, hit.z)) {
      ctl.act({ type: 'placePenalty', kubbId: s.penaltyQueue[0]!, x: hit.x, z: hit.z });
    } else this.message('Not a legal spot');
  }

  private release(i: number): void {
    if (this.holding !== i) return;
    this.holding = null;
    this.controllers[i]!.remove(this.held);
    const ctl = this.getCtl();
    const actor = ctl?.localHuman();
    if (!ctl || !actor) return;
    const win = CFG.throw.xr.windowMs;
    const now = performance.now();
    const pts = this.samples.filter((s) => s.t >= now - win);
    if (pts.length < 3) return;
    // Least-squares velocity over the window.
    const n = pts.length;
    const mt = pts.reduce((a, s) => a + s.t, 0) / n;
    const mp = pts.reduce((a, s) => a.add(s.p), new THREE.Vector3()).divideScalar(n);
    let stt = 0;
    const sp = new THREE.Vector3();
    for (const s of pts) {
      const dt = (s.t - mt) / 1000;
      stt += dt * dt;
      sp.addScaledVector(s.p.clone().sub(mp), dt);
    }
    if (stt <= 0) return;
    const v = sp.divideScalar(stt).multiplyScalar(CFG.throw.xr.assist);
    const horiz = Math.hypot(v.x, v.z);
    const speed = Math.min(CFG.throw.maxSpeed * 1.4 * speedScale(ctl.state), v.length());
    if (speed < 1) return;
    const s = ctl.state;
    const T = throwingTeam(s);
    const line = throwLineZ(s);
    const from = pts[pts.length - 1]!.p;
    const depth = Math.min(0.5, (from.z - line) * forward(T));
    const kind = actor.act === 'throwKubb' ? 'kubb' : actor.act === 'practice' ? 'baton' : 'baton';
    const intent = makeIntent({
      kind,
      kubbId: kind === 'kubb' ? kubbsToThrow(s)[0]?.id : undefined,
      from: [Math.max(-HALF_W, Math.min(HALF_W, from.x)), Math.max(0.2, from.y), line + depth * forward(T)],
      dir: [v.x, v.z],
      loft: Math.atan2(v.y, horiz),
      speed,
    });
    const err = ctl.act({ type: 'throw', intent });
    if (err) this.message(err);
  }

  /** Each frame while presenting: stand the player at the line and record the throwing hand. */
  update(): void {
    if (!this.stage.renderer.xr.isPresenting) return;
    const ctl = this.getCtl();
    if (ctl) {
      const s = ctl.state;
      const T = throwingTeam(s);
      const line = throwLineZ(s);
      this.dolly.position.set(0, 0, line - forward(T) * 0.45);
      this.dolly.rotation.y = T === 0 ? Math.PI : 0;
    }
    if (this.holding !== null) {
      const p = new THREE.Vector3().setFromMatrixPosition(this.controllers[this.holding]!.matrixWorld);
      this.samples.push({ p, t: performance.now() });
      if (this.samples.length > 60) this.samples.shift();
    }
  }
}
