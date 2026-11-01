// ThrowSim: one throw, simulated. It builds a fresh Rapier world from the game
// state (pieces on the pitch, batons lying there), adds the thrown object with
// the intent's pose and velocities, and steps at a fixed rate until everything
// settles. Building fresh makes a throw a pure function of (state, intent), and
// Rapier's deterministic build makes that function give the same answer on
// every platform, so peers only need to exchange intents.

import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { CFG, physicsFor, type PhysicsParams } from '../config.ts';
import type { GameState, Impact, Pose, Quat, SettledResult, ThrowIntent, Vec3 } from '../types.ts';
import { stakePositions } from './pitch.ts';

let ready: Promise<void> | null = null;

/** Load Rapier's WebAssembly. Call once before creating a ThrowSim. */
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

type BodyKind = 'kubb' | 'king' | 'baton';

interface SimBody {
  id: string;
  kind: BodyKind;
  body: RAPIER.RigidBody;
  onGrass: boolean;
  /** Speed last step, for impact detection. */
  speed: number;
}

const THROWN_BATON = 'thrown';
/** Typical rolling radius (m), to turn rolling resistance into angular deceleration. */
const ROLL_RADIUS = 0.03;

function colliderFor(kind: BodyKind): RAPIER.ColliderDesc {
  if (kind === 'baton') {
    const b = CFG.pieces.baton;
    return RAPIER.ColliderDesc.cylinder(b.length / 2, b.radius).setDensity(b.density);
  }
  const piece = kind === 'king' ? CFG.pieces.king : CFG.pieces.kubb;
  const [w, h, d] = piece.size;
  const r = 0.003;
  return RAPIER.ColliderDesc.roundCuboid(w / 2 - r, h / 2 - r, d / 2 - r, r).setDensity(piece.density);
}

export class ThrowSim {
  readonly world: RAPIER.World;
  readonly bodies: SimBody[] = [];
  readonly thrownId: string;
  steps = 0;
  done = false;
  private calmSteps = 0;
  private readonly maxSteps: number;
  private readonly lyingBatonIds: string[] = [];
  private impacts: Impact[] = [];
  collectImpacts = false;
  private readonly P: PhysicsParams;

  constructor(state: GameState, intent: ThrowIntent) {
    const P = physicsFor(state.setting);
    this.P = P;
    const world = new RAPIER.World({ x: 0, y: -P.gravity, z: 0 });
    world.timestep = P.timestep;
    world.numSolverIterations = P.solverIterations;
    this.world = world;
    this.maxSteps = Math.round(P.maxSeconds / P.timestep);

    const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(60, 0.5, 60).setFriction(P.groundFriction).setRestitution(P.groundRestitution),
      ground,
    );
    const st = CFG.pitch;
    for (const [x, , z] of stakePositions()) {
      const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, st.stakeHeight / 2, z));
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(st.stakeHeight / 2, st.stakeRadius).setFriction(P.woodFriction).setRestitution(P.woodRestitution),
        b,
      );
    }

    this.thrownId = intent.kind === 'kubb' ? (intent.kubbId ?? 'xnew') : THROWN_BATON;
    for (const piece of state.pieces) {
      if (piece.status === 'inHand' || piece.id === intent.kubbId) continue;
      this.add(piece.id, piece.kind, piece, true);
    }
    state.batons.forEach((b, i) => {
      const id = `b${i}`;
      this.lyingBatonIds.push(id);
      this.add(id, 'baton', b, true);
    });
    const thrown = this.add(this.thrownId, intent.kind, intent, false);
    thrown.body.setLinvel({ x: intent.v[0], y: intent.v[1], z: intent.v[2] }, true);
    thrown.body.setAngvel({ x: intent.w[0], y: intent.w[1], z: intent.w[2] }, true);
  }

  private add(id: string, kind: BodyKind, pose: Pose, resting: boolean): SimBody {
    const P = this.P;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pose.p[0], pose.p[1], pose.p[2])
      .setRotation({ x: pose.q[0], y: pose.q[1], z: pose.q[2], w: pose.q[3] })
      .setLinearDamping(P.airLinearDamping)
      .setAngularDamping(P.airAngularDamping)
      // Resting pieces start awake: created asleep, Rapier wakes them before it has
      // their ground contacts, they sink into the ground and get pushed out sideways.
      .setCcdEnabled(!resting);
    const body = this.world.createRigidBody(desc);
    this.world.createCollider(colliderFor(kind).setFriction(P.woodFriction).setRestitution(P.woodRestitution), body);
    const b: SimBody = { id, kind, body, onGrass: false, speed: 0 };
    this.bodies.push(b);
    return b;
  }

  /** Advance one fixed timestep. */
  step(): void {
    if (this.done) return;
    const P = this.P;
    // Grass: rolling and sliding bodies slow down much faster than in the air.
    for (const b of this.bodies) {
      if (b.body.isSleeping()) continue;
      const onGrass = b.body.translation().y < P.grassContactHeight[b.kind];
      if (onGrass !== b.onGrass) {
        // Soft ground: a piece coming down onto it loses most of its forward and spin speed.
        if (onGrass) {
          const v = b.body.linvel();
          if (v.y < -1) {
            const keep = P.landingKeep;
            b.body.setLinvel({ x: v.x * keep, y: v.y, z: v.z * keep }, false);
            const w = b.body.angvel();
            b.body.setAngvel({ x: w.x * keep, y: w.y * keep, z: w.z * keep }, false);
          }
        }
        b.onGrass = onGrass;
        b.body.setLinearDamping(onGrass ? P.grassLinearDamping : P.airLinearDamping);
        b.body.setAngularDamping(onGrass ? P.grassAngularDamping : P.airAngularDamping);
      }
    }
    this.world.step();
    this.steps++;
    this.rollingResistance();
    if (P.waterDrag > 0) this.waterDrag();

    let calm = true;
    const sl2 = P.settleLinear * P.settleLinear;
    const sa2 = P.settleAngular * P.settleAngular;
    for (const b of this.bodies) {
      if (b.body.isSleeping()) {
        b.speed = 0;
        continue;
      }
      const v = b.body.linvel();
      const w = b.body.angvel();
      const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
      if (v2 > sl2 || w.x * w.x + w.y * w.y + w.z * w.z > sa2) calm = false;
      if (this.collectImpacts) this.detectImpact(b, Math.sqrt(v2));
      else b.speed = Math.sqrt(v2);
    }
    this.calmSteps = calm ? this.calmSteps + 1 : 0;
    if (this.calmSteps >= P.settleSteps || this.steps >= this.maxSteps) this.done = true;
  }

  /**
   * Constant deceleration for bodies touching the ground, like real rolling
   * resistance. Damping alone never quite stops a rolling cylinder.
   */
  private rollingResistance(): void {
    const P = this.P;
    const dv = P.rollingResistance * P.gravity * P.timestep;
    const dw = dv / ROLL_RADIUS;
    for (const b of this.bodies) {
      if (!b.onGrass || b.body.isSleeping()) continue;
      const v = b.body.linvel();
      const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (sp > 0) {
        const f = Math.max(0, sp - dv) / sp;
        b.body.setLinvel({ x: v.x * f, y: v.y * f, z: v.z * f }, false);
      }
      const w = b.body.angvel();
      const sw = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
      if (sw > 0) {
        const f = Math.max(0, sw - dw) / sw;
        b.body.setAngvel({ x: w.x * f, y: w.y * f, z: w.z * f }, false);
      }
    }
  }

  /**
   * Quadratic drag through water: dv = -k |v| v dt. (Buoyancy is folded into the
   * setting's gravity, since every piece is the same weighted wood.)
   */
  private waterDrag(): void {
    const k = this.P.waterDrag * this.P.timestep;
    for (const b of this.bodies) {
      if (b.body.isSleeping()) continue;
      const v = b.body.linvel();
      const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      const f = Math.max(0, 1 - k * sp);
      if (f < 1) b.body.setLinvel({ x: v.x * f, y: v.y * f, z: v.z * f }, false);
    }
  }

  private detectImpact(b: SimBody, speed: number): void {
    const dv = b.speed - speed;
    b.speed = speed;
    if (dv < CFG.audio.impactMinDv) return;
    const t = b.body.translation();
    let surface: Impact['surface'] = 'grass';
    for (const o of this.bodies) {
      if (o === b) continue;
      const u = o.body.translation();
      const dx = u.x - t.x;
      const dy = u.y - t.y;
      const dz = u.z - t.z;
      if (dx * dx + dy * dy + dz * dz < 0.3 * 0.3) {
        surface = 'wood';
        break;
      }
    }
    this.impacts.push({ p: [t.x, t.y, t.z], strength: dv, surface });
  }

  /** Impacts since the last call (only collected when collectImpacts is set). */
  drainImpacts(): Impact[] {
    const out = this.impacts;
    this.impacts = [];
    return out;
  }

  /** Step until settled. */
  run(): void {
    while (!this.done) this.step();
  }

  poseOf(b: SimBody): Pose {
    const t = b.body.translation();
    const r = b.body.rotation();
    return { p: [t.x, t.y, t.z] as Vec3, q: [r.x, r.y, r.z, r.w] as Quat };
  }

  /** Current poses by id: piece ids, 'b<i>' for lying batons, and thrownId. */
  poses(): Map<string, Pose> {
    const m = new Map<string, Pose>();
    for (const b of this.bodies) m.set(b.id, this.poseOf(b));
    return m;
  }

  result(): SettledResult {
    const pieces: Record<string, Pose> = {};
    const batons: Pose[] = [];
    let thrown: Pose | null = null;
    for (const b of this.bodies) {
      const pose = this.poseOf(b);
      if (b.id === this.thrownId) thrown = pose;
      else if (b.kind === 'baton') batons[this.lyingBatonIds.indexOf(b.id)] = pose;
      else pieces[b.id] = pose;
    }
    return { pieces, batons, thrown: thrown!, steps: this.steps };
  }

  free(): void {
    this.world.free();
  }
}

/** Simulate a whole throw headlessly. */
export function simulateThrow(state: GameState, intent: ThrowIntent): SettledResult {
  const sim = new ThrowSim(state, intent);
  try {
    sim.run();
    return sim.result();
  } finally {
    sim.free();
  }
}
