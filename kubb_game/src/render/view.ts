// GameView: draws a game. It reads the controller's state (and the live
// ThrowSim while a throw is in flight) and never changes either.

import * as THREE from 'three';
import { CFG, sceneDef } from '../config.ts';
import type { ControllerEvent, GameController } from '../game/controller.ts';
import { HALF_L, HALF_W, baselineZ, forward, other, stakePositions } from '../sim/pitch.ts';
import { kubbsToThrow, teamPlayers, throwLineZ, throwingTeam } from '../sim/rules.ts';
import type { GameState, Pose, Quat, TeamId, Vec3 } from '../types.ts';
import { Avatar, FirstPersonHand, type Outfit } from './avatars.ts';
import { bacOf, drunkEffects } from '../game/bac.ts';
import { CanKit } from './cans.ts';
import type { KubbPaint } from './pieces.ts';
import type { Stage } from './stage.ts';

export interface Overlay {
  reticle: Vec3 | null;
  arc: Vec3[] | null;
  raise: { kubbId: string; cands: [Vec3, Vec3]; q: Quat; hover: 0 | 1 | null } | null;
  penalty: { p: Vec3; valid: boolean } | null;
  /** The local player shown in first person, if any. */
  firstPerson: string | null;
  standX: number;
  windup: number;
  holding: 'baton' | 'kubb' | null;
  overview: boolean;
  /** While zoomed, the camera looks at the reticle. */
  aimLook: Vec3 | null;
  /** The circle the throw can land in. */
  circle: { p: Vec3; r: number } | null;
  /** Where the throw being made would land, live during the flick. */
  mark: Vec3 | null;
}

export function emptyOverlay(): Overlay {
  return { reticle: null, arc: null, raise: null, penalty: null, firstPerson: null, standX: 0, windup: 0, holding: null, overview: false, aimLook: null, circle: null, mark: null };
}

const tmpV = new THREE.Vector3();
const ARC_DOTS = 90;
const ARC_SPACING = 0.22;

/** Which baseline a kubb started on: k0..k4 team 0, k5..k9 team 1 (practice kubbs count as team 1). */
function startTeam(id: string): 0 | 1 {
  const n = Number(id.slice(1));
  return id.startsWith('k') && n < CFG.pitch.baselineKubbs ? 0 : 1;
}

function setPose(o: THREE.Object3D, pose: Pose): void {
  o.position.set(pose.p[0], pose.p[1], pose.p[2]);
  o.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
}

export class GameView {
  readonly group = new THREE.Group();
  private pieces = new Map<string, THREE.Object3D>();
  private batons: THREE.Mesh[] = [];
  private avatars = new Map<string, Avatar>();
  private hand: FirstPersonHand;
  private heldBaton: THREE.Mesh;
  private heldKubb: THREE.Mesh;
  private fpBaton: THREE.Mesh;
  private fpKubb: THREE.Mesh;
  private reticle: THREE.Mesh;
  private arcDots: THREE.InstancedMesh;
  private landing: THREE.Mesh;
  private circle: THREE.Mesh;
  private mark: THREE.Mesh;
  private cans = new CanKit();
  private tossed = new Map<string, THREE.Object3D[]>();
  private coolers: THREE.Object3D[] = [];
  /** How kubbs are painted; set from the player's settings. */
  paint: KubbPaint = 'wood';
  private ghosts: THREE.Mesh[];
  private penaltyGhost: THREE.Mesh;
  private raiseRing: THREE.Mesh;
  private advLine: THREE.Mesh;
  private unsub: () => void;
  private lastThrower: string | null = null;
  /** Where a computer player is about to throw from (known once it winds up). */
  private throwX = new Map<string, number>();
  private fpMode = false;

  constructor(
    private readonly stage: Stage,
    private readonly ctl: GameController,
    private readonly onImpact: (e: ControllerEvent & { type: 'impact' }) => void,
    /** False for the demo game behind the menu, which leaves the camera alone. */
    private readonly driveCamera = true,
  ) {
    const kit = stage.kit;
    stage.scene.add(this.group);
    this.buildPitch();

    const surf = sceneDef(ctl.state.setting).surface;
    this.hand = new FirstPersonHand(surf === 'regolith' ? '#cfcdc6' : surf === 'sand' ? '#3a3a36' : '#e0ac85');
    stage.rig.camera.add(this.hand.root);
    this.heldBaton = kit.baton();
    this.heldKubb = kit.kubb();
    this.fpBaton = kit.baton();
    this.fpKubb = kit.kubb();
    for (const m of [this.heldBaton, this.heldKubb, this.fpBaton, this.fpKubb]) m.position.set(0, -0.12, 0.02);

    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.09, 0.12, 40),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, depthWrite: false }),
    );
    this.reticle.rotation.x = -Math.PI / 2;
    this.group.add(this.reticle);
    // The preview arc: evenly spaced dots (a thin line aliases and streaks past the camera).
    const dotMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false });
    this.arcDots = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), dotMat, ARC_DOTS);
    this.arcDots.frustumCulled = false;
    this.arcDots.count = 0;
    this.landing = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.085, 32), dotMat);
    this.landing.rotation.x = -Math.PI / 2;
    this.group.add(this.arcDots, this.landing);
    this.circle = new THREE.Mesh(
      new THREE.RingGeometry(0.97, 1, 64),
      new THREE.MeshBasicMaterial({ color: '#ffe9a8', transparent: true, opacity: 0.7, depthWrite: false }),
    );
    this.circle.rotation.x = -Math.PI / 2;
    this.mark = new THREE.Mesh(new THREE.CircleGeometry(0.035, 20), new THREE.MeshBasicMaterial({ color: '#ffd84a', depthWrite: false }));
    this.mark.rotation.x = -Math.PI / 2;
    this.group.add(this.circle, this.mark);

    const ghostA = new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, depthWrite: false });
    this.ghosts = [new THREE.Mesh(kit.kubbGeometry, ghostA), new THREE.Mesh(kit.kubbGeometry, ghostA.clone())];
    this.penaltyGhost = new THREE.Mesh(kit.kubbGeometry, ghostA.clone());
    this.group.add(...this.ghosts, this.penaltyGhost);
    this.raiseRing = new THREE.Mesh(
      new THREE.RingGeometry(0.12, 0.15, 40),
      new THREE.MeshBasicMaterial({ color: '#ffd84a', transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.raiseRing.rotation.x = -Math.PI / 2;
    this.group.add(this.raiseRing);

    this.advLine = new THREE.Mesh(
      new THREE.PlaneGeometry(CFG.pitch.width, 0.025),
      new THREE.MeshBasicMaterial({ color: '#ffe9a8', transparent: true, opacity: 0.8, depthWrite: false }),
    );
    this.advLine.rotation.x = -Math.PI / 2;
    this.group.add(this.advLine);

    this.syncAvatars();
    stage.env?.syncGround?.(ctl.state.dents ?? []);
    this.unsub = ctl.on((e) => this.onEvent(e));
  }

  private buildPitch(): void {
    const kit = this.stage.kit;
    for (const [x, , z] of stakePositions()) {
      const s = kit.stake();
      s.position.set(x, 0, z);
      this.group.add(s);
    }
    const moon = sceneDef(this.stage.setting).surface === 'regolith';
    const lineMat = new THREE.MeshStandardMaterial({ color: moon ? '#d8d4c8' : '#f4f2ea', roughness: 1, transparent: true, opacity: moon ? 0.55 : 0.75, depthWrite: false });
    const strip = (x: number, z: number, w: number, d: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.003, z);
      m.receiveShadow = true;
      this.group.add(m);
    };
    const t = 0.03;
    strip(0, -HALF_L, CFG.pitch.width, t);
    strip(0, HALF_L, CFG.pitch.width, t);
    strip(0, 0, CFG.pitch.width, t * 0.7);
    strip(-HALF_W, 0, t, CFG.pitch.length);
    strip(HALF_W, 0, t, CFG.pitch.length);
  }

  private syncAvatars(): void {
    const s = this.ctl.state;
    const surface = sceneDef(s.setting).surface;
    const outfit: Outfit = surface === 'regolith' ? 'space' : surface === 'sand' ? 'dive' : 'casual';
    for (const p of s.players) {
      const existing = this.avatars.get(p.id);
      if (existing) {
        existing.player = p;
        continue;
      }
      const a = new Avatar(p, CFG.teams[p.team]!.color, outfit);
      this.avatars.set(p.id, a);
      this.group.add(a.root);
      const spot = this.restSpot(p.team, teamIndex(s, p.id));
      a.placeAt(spot, new THREE.Vector3(0, 0, 0));
    }
  }

  private onEvent(e: ControllerEvent): void {
    if (e.type === 'applied' || e.type === 'replaced') this.stage.env?.syncGround?.(e.state.dents ?? []);
    if (e.type === 'applied' && e.action.type === 'drink') {
      this.avatars.get(e.action.player)?.drinkNow();
    } else if (e.type === 'throwStart') {
      this.lastThrower = e.action.player;
      this.throwX.delete(e.action.player);
      const av = this.avatars.get(e.action.player);
      av?.setHeld(null);
      av?.throwNow();
      if (this.fpMode) this.hand.throwNow();
      this.hand.setHeld(null);
    } else if (e.type === 'botWindup') {
      const av = this.avatars.get(e.player.id);
      if (av && e.action.type === 'throw') {
        const it = e.action.intent;
        this.throwX.set(e.player.id, it.p[0]);
        av.windup = 1;
      }
    } else if (e.type === 'impact') {
      this.onImpact(e);
    } else if (e.type === 'replaced') {
      this.syncAvatars();
    }
  }

  /** Where a player waits when not throwing: beside their own baseline. */
  private restSpot(team: TeamId, i: number): THREE.Vector3 {
    const side = team === 0 ? 1 : -1;
    const z = baselineZ(team) * 0.82 - forward(team) * 0.2;
    return new THREE.Vector3(side * (HALF_W + 0.9 + i * 0.75), 0, z);
  }

  update(dt: number, ov: Overlay): void {
    const s = this.ctl.state;
    const session = this.ctl.session;
    const sim = session.sim;
    const actor = this.ctl.actor();
    this.syncAvatars();

    if (s.beer) this.updateCans(s);

    // Pieces.
    const live = sim ? sim.poses() : null;
    const seen = new Set<string>();
    const pileTeam = throwingTeam(s);
    const pile = kubbsToThrow(s).filter((p) => !live?.has(p.id));
    const heldKubbId = actor?.act === 'throwKubb' && !sim ? pile[0]?.id : undefined;
    let pileIndex = 0;
    for (const p of s.pieces) {
      seen.add(p.id);
      let o = this.pieces.get(p.id);
      if (!o) {
        o = p.kind === 'king' ? this.stage.kit.king() : this.stage.kit.kubb();
        if (p.kind === 'kubb') (o as THREE.Mesh).material = this.stage.kit.kubbMaterial(this.paint, startTeam(p.id));
        this.pieces.set(p.id, o);
        this.group.add(o);
      }
      const pose = live?.get(p.id);
      o.visible = true;
      if (pose) setPose(o, pose);
      else if (p.status === 'inHand') {
        if (p.id === heldKubbId) {
          o.visible = false;
          continue;
        }
        // Waiting kubbs lie in a neat pile beside the throwing team's corner.
        const i = pileIndex++;
        const fwd = forward(pileTeam);
        o.position.set((HALF_W + 0.45 + (i % 3) * 0.1) * (pileTeam === 0 ? -1 : 1), 0.035, baselineZ(pileTeam) - fwd * (0.4 + Math.floor(i / 3) * 0.2));
        o.quaternion.setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
      } else setPose(o, p);
    }
    for (const [id, o] of this.pieces) {
      if (!seen.has(id) && id !== sim?.thrownId) {
        this.group.remove(o);
        this.pieces.delete(id);
      }
    }
    if (live && sim && !s.pieces.some((p) => p.id === sim.thrownId) && sim.thrownId !== 'thrown') {
      // A practice kubb in flight: borrow a temporary mesh.
      let o = this.pieces.get(sim.thrownId);
      if (!o) {
        o = this.stage.kit.kubb();
        this.pieces.set(sim.thrownId, o);
        this.group.add(o);
      }
      setPose(o, live.get(sim.thrownId)!);
    }

    // Batons: lying ones, the one in flight, and the unthrown ones beside the line.
    const batonPoses: Pose[] = [];
    if (live) {
      for (let i = 0; i < s.batons.length; i++) batonPoses.push(live.get(`b${i}`) ?? s.batons[i]!);
      const t = live.get('thrown');
      if (t) batonPoses.push(t);
    } else batonPoses.push(...s.batons);
    const T = throwingTeam(s);
    const fwd = forward(T);
    const lineZ = throwLineZ(s);
    const waiting = s.phase === 'batonThrow' || s.phase === 'practice' ? Math.max(0, s.batonsLeft - (sim ? 0 : 1)) : 0;
    for (let i = 0; i < waiting; i++) {
      batonPoses.push({
        p: [(HALF_W + 0.35) * (T === 0 ? 1 : -1) + i * 0.07 * (T === 0 ? 1 : -1), 0.022, baselineZ(T) - fwd * 0.5],
        q: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      });
    }
    while (this.batons.length < batonPoses.length) {
      const b = this.stage.kit.baton();
      this.batons.push(b);
      this.group.add(b);
    }
    this.batons.forEach((b, i) => {
      b.visible = i < batonPoses.length;
      if (b.visible) setPose(b, batonPoses[i]!);
    });

    // Avatars.
    const thrower = actor && (actor.act === 'throwBaton' || actor.act === 'throwKubb' || actor.act === 'practice') ? actor.player : null;
    this.fpMode = !!ov.firstPerson && !sim;
    for (const [id, av] of this.avatars) {
      const p = av.player;
      const team = p.team;
      const isThrower = thrower?.id === id;
      const remote = this.ctl.remoteAims.get(id);
      if (isThrower) {
        const x = ov.firstPerson === id ? ov.standX : (remote?.x ?? this.throwX.get(id) ?? 0);
        const spot = new THREE.Vector3(Math.max(-HALF_W, Math.min(HALF_W, x)), 0, lineZ - forward(team) * 0.45);
        const bot = this.ctl.session.current ?? null;
        const dir = remote?.dir ?? (bot?.player === id ? [bot.intent.v[0], bot.intent.v[2]] : [0, forward(team)]);
        av.moveTo(spot, new THREE.Vector3(spot.x + dir[0], 0, spot.z + dir[1]));
        if (ov.firstPerson !== id && remote) av.windup = remote.windup;
        const holding = actor!.act === 'throwKubb' ? this.heldKubb : this.heldBaton;
        if (av.holdSlot.children[0] !== holding) av.setHeld(holding);
      } else if (!(sim && this.lastThrower === id)) {
        av.moveTo(this.restSpot(team, teamIndex(s, id)), new THREE.Vector3(0, 0, lineZ * 0.3));
        if (av.holdSlot.children.length) av.setHeld(null);
        av.windup = 0;
      }
      if (ov.firstPerson === id) av.windup = ov.windup;
      // Never draw a figure the camera is inside (first person, or watching your own throw).
      const head = tmpV.copy(av.root.position).setY(1.55);
      const inside = head.distanceTo(this.stage.rig.camera.position) < 0.7;
      av.setVisible(!inside && (ov.firstPerson !== id || !!sim || ov.overview));
      // Divers breathe out bubbles every few seconds.
      const env = this.stage.env;
      if (env?.bubbles && Math.random() < dt * 0.45) env.bubbles([av.root.position.x, 1.62, av.root.position.z], 6 + Math.floor(Math.random() * 8));
      if (s.beer) {
        av.drunk = drunkEffects(bacOf(s, id).bac).impairment + Math.min(0.3, bacOf(s, id).bac * 3);
        if (!av.canSlot.children.length) av.setCan(this.cans.can(av.player.look));
      } else if (av.canSlot.children.length) av.setCan(null);
      av.update(dt);
    }

    // First-person hand.
    this.hand.visible = this.fpMode && !ov.overview;
    this.hand.windup = ov.windup;
    const fpHeld = ov.holding === 'kubb' ? this.fpKubb : ov.holding === 'baton' ? this.fpBaton : null;
    if (this.hand.holdSlot.children[0] !== fpHeld) this.hand.setHeld(fpHeld);
    this.hand.update(dt);

    // Overlays.
    this.reticle.visible = !!ov.reticle && !sim;
    if (ov.reticle) this.reticle.position.set(ov.reticle[0], 0.006, ov.reticle[2]);
    this.drawArc(sim ? null : ov.arc);
    this.circle.visible = !!ov.circle && !sim;
    if (ov.circle) {
      this.circle.position.set(ov.circle.p[0], 0.008, ov.circle.p[2]);
      // Keep the ring's line about the same width however big the circle is.
      this.circle.scale.setScalar(ov.circle.r);
    }
    this.mark.visible = !!ov.mark && !sim;
    if (ov.mark) this.mark.position.set(ov.mark[0], 0.01, ov.mark[2]);
    if (heldKubbId) {
      const mat = this.stage.kit.kubbMaterial(this.paint, startTeam(heldKubbId));
      this.heldKubb.material = mat;
      this.fpKubb.material = mat;
    }
    const r = ov.raise;
    this.ghosts.forEach((g, i) => {
      g.visible = !!r && !sim;
      if (!r) return;
      g.position.set(...r.cands[i]!);
      g.quaternion.set(...r.q);
      (g.material as THREE.MeshStandardMaterial).opacity = r.hover === i ? 0.75 : 0.3;
      (g.material as THREE.MeshStandardMaterial).color.set(r.hover === i ? '#ffe27a' : '#ffffff');
    });
    const raising = s.phase === 'raise' ? s.pieces.find((p) => p.id === (r?.kubbId ?? s.raiseQueue[0])) : undefined;
    this.raiseRing.visible = !!raising && !sim;
    if (raising) this.raiseRing.position.set(raising.p[0], 0.008, raising.p[2]);
    this.penaltyGhost.visible = !!ov.penalty && !sim;
    if (ov.penalty) {
      this.penaltyGhost.position.set(ov.penalty.p[0], 0.075, ov.penalty.p[2]);
      (this.penaltyGhost.material as THREE.MeshStandardMaterial).color.set(ov.penalty.valid ? '#7dff8a' : '#ff6b6b');
      (this.penaltyGhost.material as THREE.MeshStandardMaterial).opacity = 0.55;
    }
    this.advLine.visible = s.phase === 'batonThrow' && lineZ !== baselineZ(s.turn);
    this.advLine.position.set(0, 0.005, lineZ);

    if (this.driveCamera) this.updateCamera(s, ov, actor?.act ?? null, live);
  }

  /** Dots every ARC_SPACING metres along the flight, sized to stay visible far away, and a ring where it lands. */
  private drawArc(arc: Vec3[] | null): void {
    this.arcDots.count = 0;
    this.landing.visible = false;
    if (!arc || arc.length < 2) return;
    const cam = this.stage.rig.camera.position;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    let travelled = 0;
    let next = 0.7; // skip the first stretch: it passes right by the camera
    let n = 0;
    for (let i = 1; i < arc.length && n < ARC_DOTS; i++) {
      a.set(...arc[i - 1]!);
      b.set(...arc[i]!);
      const seg = a.distanceTo(b);
      while (seg > 0 && travelled + seg >= next && n < ARC_DOTS) {
        p.lerpVectors(a, b, (next - travelled) / seg);
        const r = Math.min(0.03, Math.max(0.008, p.distanceTo(cam) * 0.0035));
        m.makeScale(r, r, r).setPosition(p);
        this.arcDots.setMatrixAt(n++, m);
        next += ARC_SPACING;
      }
      travelled += seg;
    }
    this.arcDots.count = n;
    this.arcDots.instanceMatrix.needsUpdate = true;
    const end = arc[arc.length - 1]!;
    this.landing.position.set(end[0], 0.007, end[2]);
    this.landing.visible = end[1] <= 0.001;
  }

  /** Empty cans lie around each player's spot, more with every can; a cooler on each side. */
  private updateCans(s: GameState): void {
    if (!this.coolers.length) {
      for (const team of [0, 1] as TeamId[]) {
        const c = this.cans.cooler();
        const spot = this.restSpot(team, 0);
        c.position.set(spot.x + (team === 0 ? 0.6 : -0.6), 0, spot.z - forward(team) * 0.9);
        c.rotation.y = 0.3;
        this.coolers.push(c);
        this.group.add(c);
      }
    }
    for (const p of s.players) {
      const opened = s.drinks[p.id]?.length ?? 0;
      // The can in hand is the newest; every earlier one has been tossed.
      const want = Math.max(0, opened - 1);
      const list = this.tossed.get(p.id) ?? [];
      while (list.length < want) {
        const i = list.length;
        const can = this.cans.can(p.look);
        const spot = this.restSpot(p.team, teamIndex(s, p.id));
        const h = hash(`${p.id}:${i}`);
        const a = h * Math.PI * 2;
        const r = 0.35 + hash(`${p.id}:r${i}`) * 0.5;
        const upright = hash(`${p.id}:u${i}`) < 0.2;
        can.position.set(spot.x + Math.cos(a) * r, upright ? 0.061 : 0.033, spot.z + Math.sin(a) * r);
        can.rotation.set(upright ? 0 : Math.PI / 2, hash(`${p.id}:y${i}`) * Math.PI * 2, 0, 'YXZ');
        list.push(can);
        this.group.add(can);
      }
      while (list.length > want) this.group.remove(list.pop()!);
      this.tossed.set(p.id, list);
    }
  }

  /** Repaint every kubb (the setting changed). */
  setPaint(paint: KubbPaint): void {
    this.paint = paint;
    for (const [id, o] of this.pieces) {
      if (id !== 'king') (o as THREE.Mesh).material = this.stage.kit.kubbMaterial(paint, startTeam(id));
    }
  }

  private updateCamera(s: GameState, ov: Overlay, act: string | null, live: Map<string, Pose> | null): void {
    const rig = this.stage.rig;
    const cam = CFG.camera;
    if (ov.overview || s.phase === 'over') {
      rig.set('overview', tmpV.set(6.5, 5.2, 0), new THREE.Vector3(0, 0, 0));
      return;
    }
    const T = throwingTeam(s);
    const fwd = forward(T);
    const lineZ = throwLineZ(s);
    if (live) {
      const sim = this.ctl.session.sim!;
      const p = live.get(sim.thrownId)!.p;
      if (rig.mode !== 'aim' && rig.mode !== 'follow' && rig.mode !== 'spectate') {
        rig.set('follow', tmpV.set(2.8 * (T === 0 ? 1 : -1), 2.4, lineZ - fwd * 2), new THREE.Vector3(...p));
      }
      rig.track(new THREE.Vector3(p[0] * 0.8, Math.min(p[1], 0.8) * 0.4, p[2]));
      return;
    }
    const raising = act === 'raise' ? s.pieces.find((p) => p.id === s.raiseQueue[0]) : undefined;
    if (raising) {
      // Close over the kubb being raised, from the centre-line side.
      const toMid = -Math.sign(baselineZ(other(s.turn)));
      rig.set('place', tmpV.set(raising.p[0] * 0.8, 1.5, raising.p[2] + toMid * 1.3), new THREE.Vector3(raising.p[0], 0.05, raising.p[2]));
      return;
    }
    if (act === 'penalty') {
      const O = other(s.turn);
      const cz = baselineZ(O) / 2;
      rig.set('place', tmpV.set(0, 4.6, -Math.sign(cz) * 1.6), new THREE.Vector3(0, 0, cz * 1.05));
      return;
    }
    if (ov.firstPerson) {
      const eye = new THREE.Vector3(ov.standX, cam.eyeHeight, lineZ - fwd * cam.eyeBack);
      rig.set('aim', eye, ov.aimLook ? new THREE.Vector3(...ov.aimLook) : new THREE.Vector3(ov.standX * 0.35, 0, lineZ + fwd * 5.5));
      return;
    }
    const thrower = this.ctl.actor()?.player;
    const av = thrower ? this.avatars.get(thrower.id) : undefined;
    const x = av ? av.root.position.x : 0;
    rig.set('spectate', tmpV.set(x * 0.6 - 1.4 * (T === 0 ? 1 : -1), 2.9, lineZ - fwd * 4.4), new THREE.Vector3(x * 0.4, 0.3, lineZ + fwd * 5));
  }

  dispose(): void {
    this.unsub();
    this.stage.scene.remove(this.group);
    this.stage.rig.camera.remove(this.hand.root);
    // Free GPU resources. Shared piece geometry and materials are freed too; Three
    // uploads them again if the next game uses them.
    for (const root of [this.group, this.hand.root, this.heldBaton, this.heldKubb, this.fpBaton, this.fpKubb]) {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const mat of mats) {
          for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
          mat.dispose();
        }
      });
    }
  }
}

function teamIndex(s: GameState, id: string): number {
  const p = s.players.find((x) => x.id === id);
  return p ? teamPlayers(s, p.team).findIndex((x) => x.id === id) : 0;
}

/** Stable 0..1 from a string, for scattering cans the same way every frame. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}
