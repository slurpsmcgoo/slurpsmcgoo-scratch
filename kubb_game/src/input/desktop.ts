// Mouse, trackpad and touch. Aim by pointing at the ground (or tapping on a
// touch screen); throw with a flick (press, pull back, push forward, let go)
// or the power meter (press, release at the power you want). Raise kubbs by
// clicking a ghost; place penalty kubbs by clicking a legal spot.

import { CFG, DEG } from '../config.ts';
import type { GameController } from '../game/controller.ts';
import { rotate, yawQuat } from '../sim/math.ts';
import { HALF_W, forward, other } from '../sim/pitch.ts';
import { kubbsToThrow, raiseCandidates, throwLineZ, throwingTeam, validPenaltySpot } from '../sim/rules.ts';
import { FlickTracker } from '../throw/flick.ts';
import { dispersionRadius, flickOffset, meterOffset, offsetTarget, type DiscOffset } from '../throw/dispersion.ts';
import { arcPoints, makeIntent, mediumOf, releasePoint, solveSpeed, speedScale } from '../throw/model.ts';
import type { Stage } from '../render/stage.ts';
import { emptyOverlay, type Overlay } from '../render/view.ts';
import type { Vec3 } from '../types.ts';

export interface InputSettings {
  mode: 'flick' | 'meter';
  spinControl: 'pull' | 'keys';
  preview: boolean;
}

export interface InputCallbacks {
  thrown(speed: number): void;
  message(text: string): void;
  key(key: string): boolean;
}

export class DesktopInput {
  overlay: Overlay = emptyOverlay();
  /** 0..1 power for the HUD: live while throwing, and the power that would reach the reticle. */
  power = 0;
  targetPower = 0;
  powerVisible = false;
  loft: Record<'baton' | 'kubb', number> = { baton: CFG.throw.defaultLoftDeg, kubb: CFG.throw.defaultKubbLoftDeg };
  practiceKind: 'baton' | 'kubb' = 'baton';
  /** Spin multiplier set with Q/E (spinControl 'keys', and always for the power meter). */
  spinLevel = 1;
  /** The spin the next throw will get, for the HUD; -1 while it's still to be set by the pull-back. */
  spin = 1;
  /** Beer mode: how drunk the local thrower is (set by the app each frame). */
  drunk = { impairment: 0, flow: 0, sway: [0, 0] as [number, number] };
  enabled = true;
  private aim: Vec3 | null = null;
  private standOffset = 0;
  private tracker = new FlickTracker(innerHeight);
  private dragging = false;
  private downAt: [number, number] = [0, 0];
  private pointer: [number, number] | null = null;
  private meterT = -1;
  private hover: 0 | 1 | null = null;
  private lastAimSend = 0;
  private time = 0;
  /** While zoomed (right button or Z held), the camera looks at where the reticle was. */
  private zoomLook: Vec3 | null = null;

  constructor(
    private readonly stage: Stage,
    private readonly getCtl: () => GameController | null,
    private readonly settings: InputSettings,
    private readonly cb: InputCallbacks,
  ) {
    const c = stage.canvas;
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', () => this.cancel());
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
  }

  private ctl(): GameController | null {
    return this.enabled ? this.getCtl() : null;
  }

  private throwKind(): 'baton' | 'kubb' | null {
    const act = this.ctl()?.localHuman()?.act;
    if (act === 'throwBaton') return 'baton';
    if (act === 'throwKubb') return 'kubb';
    if (act === 'practice') return this.practiceKind;
    return null;
  }

  private onMove(e: PointerEvent): void {
    this.pointer = [e.clientX, e.clientY];
    if (this.dragging) {
      this.tracker.move(e.clientX, e.clientY, e.timeStamp);
      return;
    }
    if (e.pointerType === 'mouse' && this.throwKind()) this.aimAt(e.clientX, e.clientY);
  }

  private aimAt(x: number, y: number): void {
    const ctl = this.ctl();
    const hit = this.stage.pickGround(x, y);
    if (!ctl || !hit) return;
    const s = ctl.state;
    const T = throwingTeam(s);
    const fwd = forward(T);
    const line = throwLineZ(s);
    // Keep the aim in front of the thrower, within reason.
    const ahead = Math.max(1, Math.min(14, (hit.z - line) * fwd));
    this.aim = [Math.max(-6, Math.min(6, hit.x)), 0, line + ahead * fwd];
  }

  private setZoom(on: boolean): void {
    if (on && this.throwKind()) this.zoomLook = this.overlay.reticle ? [...this.overlay.reticle] : null;
    else if (!on) this.zoomLook = null;
    this.stage.rig.zoom = this.zoomLook !== null;
  }

  private onDown(e: PointerEvent): void {
    if (e.button === 2) {
      this.setZoom(true);
      return;
    }
    if (e.button !== 0) return;
    this.stage.canvas.setPointerCapture(e.pointerId);
    this.cb.key('unlock');
    const ctl = this.ctl();
    const actor = ctl?.localHuman();
    if (!ctl || !actor) return;
    this.downAt = [e.clientX, e.clientY];
    if (actor.act === 'raise') {
      this.updateHover(e.clientX, e.clientY);
      if (this.hover !== null) this.raise(this.hover);
      return;
    }
    if (actor.act === 'penalty') {
      const hit = this.stage.pickGround(e.clientX, e.clientY);
      if (!hit) return;
      const id = ctl.state.penaltyQueue[0]!;
      if (!validPenaltySpot(ctl.state, other(ctl.state.turn), hit.x, hit.z)) {
        this.cb.message('Not there: stay in the half, a baton length from the king and stakes');
        return;
      }
      const err = ctl.act({ type: 'placePenalty', kubbId: id, x: round(hit.x), z: round(hit.z) });
      if (err) this.cb.message(err);
      return;
    }
    if (!this.throwKind()) return;
    if (this.settings.mode === 'flick') {
      this.tracker.begin(e.clientX, e.clientY, e.timeStamp, innerHeight);
      this.dragging = true;
    } else {
      this.meterT = 0;
      this.dragging = true;
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.button === 2) {
      this.setZoom(false);
      return;
    }
    if (!this.dragging) return;
    this.dragging = false;
    const moved = Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]);
    if (this.settings.mode === 'meter') {
      const p = this.meterValue();
      this.meterT = -1;
      if (moved < 10 && e.pointerType !== 'mouse' && p < 0.05) {
        this.aimAt(e.clientX, e.clientY);
        return;
      }
      this.throwAt(meterOffset(p, (Math.random() - 0.5) * 0.5), this.spinLevel);
      return;
    }
    const spin = this.currentSpin();
    const r = this.tracker.end(e.timeStamp);
    if (!r.pulledBack || r.forward < 0.15) {
      // A tap (or a touch drag that never flicked): aim there instead.
      if (moved < 12 || e.pointerType !== 'mouse') this.aimAt(e.clientX, e.clientY);
      else this.cb.message('Pull back, then flick forward');
      return;
    }
    this.throwAt(flickOffset(r), spin);
  }

  private cancel(): void {
    this.dragging = false;
    this.meterT = -1;
  }

  private onWheel(e: WheelEvent): void {
    const kind = this.throwKind();
    if (!kind) return;
    e.preventDefault();
    this.nudgeLoft(kind, e.deltaY < 0 ? 1 : -1);
  }

  private nudgeLoft(kind: 'baton' | 'kubb', dir: number): void {
    const t = CFG.throw;
    this.loft[kind] = Math.max(t.minLoftDeg, Math.min(t.maxLoftDeg, this.loft[kind] + dir * t.loftStepDeg));
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'z') {
      if (!e.repeat) this.setZoom(down);
      return;
    }
    if (!down) {
      if (k === ' ' && this.meterT >= 0) {
        const p = this.meterValue();
        this.meterT = -1;
        this.dragging = false;
        this.throwAt(meterOffset(p, (Math.random() - 0.5) * 0.5), this.spinLevel);
      }
      return;
    }
    if (this.cb.key(k)) return;
    const kind = this.throwKind();
    if (kind && (k === 'w' || k === 'arrowup')) this.nudgeLoft(kind, 1);
    else if (kind && (k === 's' || k === 'arrowdown')) this.nudgeLoft(kind, -1);
    else if (k === 'a' && this.ctl()?.localHuman()?.act === 'raise') this.autoRaise();
    else if (kind && (k === 'a' || k === 'arrowleft')) this.standOffset = Math.max(-HALF_W, this.standOffset - 0.1);
    else if (kind && (k === 'd' || k === 'arrowright')) this.standOffset = Math.min(HALF_W, this.standOffset + 0.1);
    else if (k === '1' || k === '2') this.raise(k === '1' ? 0 : 1);
    else if (kind && (k === 'q' || k === 'e')) this.nudgeSpin(k === 'e' ? 1 : -1);
    else if (k === ' ' && kind && this.meterT < 0 && !e.repeat) {
      this.meterT = 0;
      this.dragging = true;
      e.preventDefault();
    } else return;
    e.preventDefault();
  }

  private nudgeSpin(dir: number): void {
    const sp = CFG.throw.spin;
    this.spinLevel = Math.round(Math.max(sp.min, Math.min(sp.max, this.spinLevel + dir * sp.step)) * 100) / 100;
    if (this.settings.spinControl === 'pull' && this.settings.mode === 'flick') this.cb.message('Spin comes from your pull-back (switch to Q/E in Settings)');
  }

  /** Spin multiplier: from the wind-up depth when flicking with pull control, else the Q/E level. */
  private currentSpin(): number {
    const sp = CFG.throw.spin;
    if (this.settings.mode === 'flick' && this.settings.spinControl === 'pull') {
      return sp.min + (sp.max - sp.min) * this.tracker.maxPull(sp.pullFullScreen);
    }
    return this.spinLevel;
  }

  raise(end: 0 | 1): void {
    const ctl = this.ctl();
    if (ctl?.localHuman()?.act !== 'raise') return;
    const err = ctl.act({ type: 'raise', kubbId: ctl.state.raiseQueue[0]!, end });
    if (err) this.cb.message(err);
  }

  /** Raise every waiting kubb on the end towards our own baseline. */
  autoRaise(): void {
    const ctl = this.ctl();
    if (!ctl) return;
    for (let guard = 0; guard < 12 && ctl.localHuman()?.act === 'raise'; guard++) {
      const s = ctl.state;
      const k = s.pieces.find((p) => p.id === s.raiseQueue[0])!;
      const [c0, c1] = raiseCandidates(k);
      const thrower = throwLineZ({ ...s, phase: 'kubbThrow' });
      const end: 0 | 1 = Math.abs(c0[2] - thrower) >= Math.abs(c1[2] - thrower) ? 0 : 1;
      if (ctl.act({ type: 'raise', kubbId: k.id, end })) break;
    }
  }

  private speedScale(): number {
    const ctl = this.ctl();
    return ctl ? speedScale(ctl.state) : 1;
  }

  private maxSpeed(): number {
    return CFG.throw.maxSpeed * this.speedScale();
  }

  private meterValue(): number {
    if (this.meterT < 0) return 0;
    const ph = (this.meterT / CFG.throw.meter.periodS) % 1;
    return ph < 0.5 ? ph * 2 : 2 - ph * 2;
  }

  private geometry() {
    const ctl = this.ctl();
    const kind = this.throwKind();
    if (!ctl || !kind) return null;
    const s = ctl.state;
    const T = throwingTeam(s);
    const fwd = forward(T);
    const line = throwLineZ(s);
    const base: Vec3 = this.aim ?? [0, 0, line + fwd * (kind === 'kubb' ? 5 : 8)];
    // Drunk: the aim point drifts.
    const aim: Vec3 = [base[0] + this.drunk.sway[0], 0, base[2] + this.drunk.sway[1]];
    const standX = Math.max(-HALF_W, Math.min(HALF_W, aim[0] * 0.5 + this.standOffset));
    const from = releasePoint(s, standX);
    const dir: [number, number] = [aim[0] - from[0], aim[2] - from[2]];
    const loft = this.loft[kind] * DEG;
    const radius = dispersionRadius(Math.hypot(dir[0], dir[1]), kind, this.drunk);
    return { ctl, s, kind, aim, standX, from, dir, loft, radius, medium: mediumOf(s) };
  }

  /** Where a throw with this disc offset goes, after beer-mode effects. */
  private landingFor(g: NonNullable<ReturnType<DesktopInput['geometry']>>, o: DiscOffset, jitter: DiscOffset | null): Vec3 {
    const d = CFG.throw.dispersion;
    // In the zone, your throw drifts towards the middle of the circle; past it, it shakes.
    const pull = 1 - this.drunk.flow * d.flowPull;
    let along = o.along * pull;
    let side = o.side * pull;
    if (jitter) {
      along += jitter.along * this.drunk.impairment * d.impairedJitter;
      side += jitter.side * this.drunk.impairment * d.impairedJitter;
    }
    const len = Math.hypot(along, side);
    if (len > 1) {
      along /= len;
      side /= len;
    }
    return offsetTarget(g.from, [g.aim[0], 0.06, g.aim[2]], { along, side }, g.radius);
  }

  private throwAt(offset: DiscOffset, spin: number): void {
    const g = this.geometry();
    if (!g) return;
    const target = this.landingFor(g, offset, { along: gaussian(), side: gaussian() });
    const speed = solveSpeed(g.from, target, g.loft, g.medium) ?? this.maxSpeed();
    const dir: [number, number] = [target[0] - g.from[0], target[2] - g.from[2]];
    const kubbId = g.kind === 'kubb' && g.s.phase === 'kubbThrow' ? kubbsToThrow(g.s)[0]?.id : undefined;
    const intent = makeIntent({ kind: g.kind, kubbId, from: g.from, dir, loft: g.loft, speed, spin });
    const err = g.ctl.act({ type: 'throw', intent });
    if (err) this.cb.message(err);
    else this.cb.thrown(speed);
  }

  private updateHover(x: number, y: number): void {
    const ctl = this.ctl();
    const hit = this.stage.pickGround(x, y);
    const s = ctl?.state;
    if (!s || !hit || s.phase !== 'raise') {
      this.hover = null;
      return;
    }
    const k = s.pieces.find((p) => p.id === s.raiseQueue[0]);
    if (!k) return;
    const [c0, c1] = raiseCandidates(k);
    const d0 = Math.hypot(hit.x - c0[0], hit.z - c0[2]);
    const d1 = Math.hypot(hit.x - c1[0], hit.z - c1[2]);
    this.hover = Math.min(d0, d1) > 0.6 ? null : d0 <= d1 ? 0 : 1;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.meterT >= 0) this.meterT += dt;
    const ov = emptyOverlay();
    ov.overview = this.overlay.overview;
    this.powerVisible = false;
    const ctl = this.ctl();
    const actor = ctl?.localHuman();
    if (ctl && actor) {
      const g = this.geometry();
      if (g) {
        ov.firstPerson = actor.player.id;
        ov.reticle = g.aim;
        ov.aimLook = this.zoomLook;
        ov.standX = g.standX;
        ov.holding = g.kind;
        ov.circle = { p: g.aim, r: g.radius };
        // The bar shows short ↔ long within the circle; the tick in the middle is dead on.
        this.targetPower = 0.5;
        let live: DiscOffset | null = null;
        if (this.settings.mode === 'meter' && this.meterT >= 0) {
          live = meterOffset(this.meterValue(), 0);
          ov.windup = 0.3 + this.meterValue() * 0.7;
        } else if (this.dragging) {
          const r = this.tracker.current(performance.now());
          live = r.forward > 0.05 ? flickOffset(r) : null;
          ov.windup = this.tracker.pull();
        }
        this.power = live ? (live.along + 1) / 2 : 0;
        const landing = live ? this.landingFor(g, live, null) : [g.aim[0], 0.06, g.aim[2]] as Vec3;
        if (live) ov.mark = [landing[0], 0, landing[2]];
        const pullSpin = this.settings.mode === 'flick' && this.settings.spinControl === 'pull';
        this.spin = pullSpin && !this.dragging ? -1 : this.currentSpin();
        this.powerVisible = true;
        if (this.settings.preview) {
          const speed = solveSpeed(g.from, landing, g.loft, g.medium) ?? 0;
          const dx = landing[0] - g.from[0];
          const dz = landing[2] - g.from[2];
          const len = Math.hypot(dx, dz) || 1;
          const c = Math.cos(g.loft);
          ov.arc = arcPoints(g.from, [(dx / len) * c * speed, Math.sin(g.loft) * speed, (dz / len) * c * speed], g.medium);
        }
        if (this.time - this.lastAimSend > 1 / CFG.net.aimHz) {
          this.lastAimSend = this.time;
          ctl.sendAim({ player: actor.player.id, x: g.standX, dir: g.dir, windup: ov.windup });
        }
      } else if (actor.act === 'raise') {
        const s = ctl.state;
        const k = s.pieces.find((p) => p.id === s.raiseQueue[0]);
        if (k) {
          if (this.pointer) this.updateHover(this.pointer[0], this.pointer[1]);
          const a = rotate(k.q, [0, 1, 0]);
          ov.raise = { kubbId: k.id, cands: raiseCandidates(k), q: yawQuat(a[0], a[2]), hover: this.hover };
        }
      } else if (actor.act === 'penalty' && this.pointer) {
        const hit = this.stage.pickGround(this.pointer[0], this.pointer[1]);
        if (hit) ov.penalty = { p: [hit.x, 0, hit.z], valid: validPenaltySpot(ctl.state, other(ctl.state.turn), hit.x, hit.z) };
      }
    }
    this.overlay = ov;
  }

  toggleZoom(): void {
    this.setZoom(this.zoomLook === null);
  }

  toggleOverview(): void {
    this.overlay.overview = !this.overlay.overview;
  }

  /** Called when a new turn or game starts: forget the old aim. */
  reset(): void {
    this.setZoom(false);
    this.aim = null;
    this.standOffset = 0;
    this.dragging = false;
    this.meterT = -1;
  }
}

function gaussian(): number {
  let s = 0;
  for (let i = 0; i < 6; i++) s += Math.random();
  return (s - 3) / Math.sqrt(0.5);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
