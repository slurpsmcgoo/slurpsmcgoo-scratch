// ThrowSim: one throw, simulated. It builds a fresh Rapier world from the game
// state (pieces on the pitch, batons lying there), adds the thrown object with
// the intent's pose and velocities, and steps at a fixed rate until everything
// settles. Building fresh makes a throw a pure function of (state, intent), and
// Rapier's deterministic build makes that function give the same answer on
// every platform, so peers only need to exchange intents.

import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { CFG, physicsFor, type PhysicsParams } from '../config.ts';
import type { Dent, GameState, Impact, Pose, Quat, SettledResult, ThrowIntent, Vec3 } from '../types.ts';
import { stakePositions } from './pitch.ts';
import { heightfieldData, PHYS_NX, PHYS_NZ, TERRAIN_HALF_D, TERRAIN_HALF_W, TerrainGrid, terrainOf } from './terrain.ts';

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
  collider: RAPIER.Collider;
  onGrass: boolean;
  /** Velocity last step, for impact detection. */
  v: Vec3;
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
  /** Colliders that are the ground (one cuboid, or a heightfield with a level border). */
  private readonly groundHandles = new Set<number>();
  private readonly groundBody: RAPIER.RigidBody;
  /** Deformable settings: this throw's own copy of the ground, dented as things land. */
  private readonly terrain: TerrainGrid | null;
  private heightfield: RAPIER.Collider | null = null;
  private terrainDirty = false;
  private readonly dents: Dent[] = [];

  constructor(state: GameState, intent: ThrowIntent) {
    const P = physicsFor(state.setting);
    this.P = P;
    const world = new RAPIER.World({ x: 0, y: -P.gravity, z: 0 });
    world.timestep = P.timestep;
    world.numSolverIterations = P.solverIterations;
    this.world = world;
    this.maxSteps = Math.round(P.maxSeconds / P.timestep);

    this.groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.terrain = P.deformable ? new TerrainGrid(terrainOf(state)) : null;
    if (this.terrain) {
      // A level border around the deformable patch, then the patch itself.
      const hw = TERRAIN_HALF_W;
      const hd = TERRAIN_HALF_D;
      const side = (60 - hw) / 2;
      const end = (60 - hd) / 2;
      this.addGround(RAPIER.ColliderDesc.cuboid(side, 0.5, 60).setTranslation(-hw - side, -0.5, 0));
      this.addGround(RAPIER.ColliderDesc.cuboid(side, 0.5, 60).setTranslation(hw + side, -0.5, 0));
      this.addGround(RAPIER.ColliderDesc.cuboid(hw, 0.5, end).setTranslation(0, -0.5, -hd - end));
      this.addGround(RAPIER.ColliderDesc.cuboid(hw, 0.5, end).setTranslation(0, -0.5, hd + end));
      this.buildHeightfield();
    } else {
      this.addGround(RAPIER.ColliderDesc.cuboid(60, 0.5, 60).setTranslation(0, -0.5, 0));
    }
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

  private addGround(desc: RAPIER.ColliderDesc): RAPIER.Collider {
    const c = this.world.createCollider(desc.setFriction(this.P.groundFriction).setRestitution(this.P.groundRestitution), this.groundBody);
    this.groundHandles.add(c.handle);
    return c;
  }

  /** (Re)build the heightfield from this throw's terrain grid. */
  private buildHeightfield(): void {
    if (this.heightfield) {
      this.groundHandles.delete(this.heightfield.handle);
      this.world.removeCollider(this.heightfield, false);
    }
    const scale = { x: TERRAIN_HALF_W * 2, y: 1, z: TERRAIN_HALF_D * 2 };
    this.heightfield = this.addGround(RAPIER.ColliderDesc.heightfield(PHYS_NZ - 1, PHYS_NX - 1, heightfieldData(this.terrain!), scale));
    this.terrainDirty = false;
  }

  /** Ground height under a point (0 where the ground can't deform). */
  private groundUnder(x: number, z: number): number {
    return this.terrain ? this.terrain.heightAt(x, z) : 0;
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
    const collider = this.world.createCollider(colliderFor(kind).setFriction(P.woodFriction).setRestitution(P.woodRestitution), body);
    const b: SimBody = { id, kind, body, collider, onGrass: false, v: [0, 0, 0] };
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
      const t = b.body.translation();
      const onGrass = t.y - this.groundUnder(t.x, t.z) < P.grassContactHeight[b.kind];
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
        b.v = [0, 0, 0];
        continue;
      }
      const v = b.body.linvel();
      const w = b.body.angvel();
      const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
      if (v2 > sl2 || w.x * w.x + w.y * w.y + w.z * w.z > sa2) calm = false;
      if (this.collectImpacts || this.terrain) this.detectImpact(b, v);
      b.v = [v.x, v.y, v.z];
    }
    // The ground changes under whatever is on it from the next step on.
    if (this.terrainDirty) this.buildHeightfield();
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

  /**
   * A hard contact is a velocity change beyond what gravity did this step. The
   * whole vector counts, so a glancing bounce that keeps its speed but turns
   * upwards registers too. Read only: never changes the simulation.
   */
  private detectImpact(b: SimBody, v: { x: number; y: number; z: number }): void {
    const dx = v.x - b.v[0];
    const dy = v.y - b.v[1] + this.P.gravity * this.P.timestep;
    const dz = v.z - b.v[2];
    const dv = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dv < CFG.audio.impactMinDv) return;
    // Wood if it's touching another piece or a stake, else ground if it's touching that or
    // its lowest point is at the ground. (A fast body's hit is resolved by CCD, which can
    // leave no contact behind, so contacts alone miss some ground hits.)
    let wood = false;
    let ground = false;
    this.world.contactPairsWith(b.collider, (other) => {
      this.world.contactPair(b.collider, other, (m) => {
        let touching = m.numSolverContacts() > 0;
        for (let i = 0; i < m.numContacts(); i++) if (m.contactDist(i) < 0.01) touching = true;
        if (!touching) return;
        if (this.groundHandles.has(other.handle)) ground = true;
        else wood = true;
      });
    });
    const low = this.lowestPoint(b);
    if (!wood && !ground) ground = low[1] - this.groundUnder(low[0], low[2]) < 0.02;
    if (!wood && !ground) return;
    const t = b.body.translation();
    const dent = ground && !wood && this.terrain && dv >= CFG.terrain.minDv ? this.dig(b, low) : undefined;
    const p: Vec3 = wood ? [t.x, t.y, t.z] : low;
    if (this.collectImpacts) this.impacts.push({ p, strength: dv, surface: wood ? 'wood' : 'grass', dent });
  }

  /** The lowest point of a body's shape, from its pose (plain arithmetic, so deterministic). */
  private lowestPoint(b: SimBody): Vec3 {
    const t = b.body.translation();
    const { x, y, z, w } = b.body.rotation();
    // World images of the local axes (rotation matrix columns).
    const ax: Vec3 = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
    const ay: Vec3 = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
    const az: Vec3 = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
    const p: Vec3 = [t.x, t.y, t.z];
    const sub = (a: Vec3, k: number): void => {
      p[0] -= a[0] * k;
      p[1] -= a[1] * k;
      p[2] -= a[2] * k;
    };
    if (b.kind === 'baton') {
      const { length, radius } = CFG.pieces.baton;
      sub(ay, (ay[1] < 0 ? -1 : 1) * (length / 2));
      // Down the end face: straight down, minus its component along the axis.
      const d: Vec3 = [-ay[1] * ay[0], 1 - ay[1] * ay[1], -ay[1] * ay[2]];
      const n = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      if (n > 1e-9) sub(d, radius / n);
      return p;
    }
    const [hx, hy, hz] = (b.kind === 'king' ? CFG.pieces.king.size : CFG.pieces.kubb.size).map((v) => v / 2) as Vec3;
    sub(ax, (ax[1] < 0 ? -1 : 1) * hx);
    sub(ay, (ay[1] < 0 ? -1 : 1) * hy);
    sub(az, (az[1] < 0 ? -1 : 1) * hz);
    return p;
  }

  /** Dent the ground where b came down, with the velocity it had just before. */
  private dig(b: SimBody, at: Vec3): Dent | undefined {
    const d: Dent = [
      Math.round(at[0] * 1000),
      Math.round(at[2] * 1000),
      Math.round(b.v[0] * 100),
      Math.round(b.v[1] * 100),
      Math.round(b.v[2] * 100),
      Math.round(b.body.mass() * 1000),
    ];
    const box = this.terrain!.apply(d);
    if (!box) return undefined;
    this.dents.push(d);
    this.terrainDirty = true;
    // Wake anything resting on the patch that just changed.
    const x0 = box.x0 * CFG.terrain.cell - TERRAIN_HALF_W - 0.2;
    const x1 = box.x1 * CFG.terrain.cell - TERRAIN_HALF_W + 0.2;
    const z0 = box.z0 * CFG.terrain.cell - TERRAIN_HALF_D - 0.2;
    const z1 = box.z1 * CFG.terrain.cell - TERRAIN_HALF_D + 0.2;
    for (const o of this.bodies) {
      const u = o.body.translation();
      if (u.x >= x0 && u.x <= x1 && u.z >= z0 && u.z <= z1) o.body.wakeUp();
    }
    return d;
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
    return { pieces, batons, thrown: thrown!, steps: this.steps, dents: [...this.dents] };
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
