// The simulator: fake people driven by mouse and keyboard, scripted
// scenarios, and replay of recorded logs. It emits raw 33-point detections
// (and audio levels), so the tracker, smoothing, geometry and director all get
// exercised exactly as they would by the real camera.

import type { ShowConfig } from '../config.ts';
import type { Detection, Landmark, SensorStatus } from '../types.ts';
import { fitTilt, rowForPoint, widthAtDistance } from '../perception/geometry.ts';
import { NO_MUSIC, parseFrame, type PerceptionFrame, type PerceptionSource } from '../world/frame.ts';
import { BeatTracker } from './beatTracker.ts';

export interface SimPerson {
  key: number;
  x: number;          // 0..1 visitor view (hip center)
  distanceM: number;
  heightM: number;
  phase: number;      // walk cycle
  moving: boolean;
  waving: boolean;
  script?: { tS: number; x: number; d: number }[]; // keyframes relative to scriptStartMs
  scriptStartMs?: number;
}

/** Body points as [lateral offset, height] in units of a 1.7 m adult, for a person facing the window. */
const BODY: [number, number][] = [
  [0, 1.58],                                     // 0 nose
  [-0.02, 1.62], [-0.035, 1.62], [-0.05, 1.62],  // 1-3 left eye inner, eye, outer
  [0.02, 1.62], [0.035, 1.62], [0.05, 1.62],     // 4-6 right eye
  [-0.08, 1.6], [0.08, 1.6],                     // 7-8 ears
  [-0.03, 1.53], [0.03, 1.53],                   // 9-10 mouth
  [-0.19, 1.42], [0.19, 1.42],                   // 11-12 shoulders
  [-0.22, 1.13], [0.22, 1.13],                   // 13-14 elbows
  [-0.23, 0.86], [0.23, 0.86],                   // 15-16 wrists
  [-0.24, 0.78], [0.24, 0.78],                   // 17-18 pinky
  [-0.23, 0.77], [0.23, 0.77],                   // 19-20 index
  [-0.21, 0.8], [0.21, 0.8],                     // 21-22 thumb
  [-0.1, 0.92], [0.1, 0.92],                     // 23-24 hips
  [-0.1, 0.5], [0.1, 0.5],                       // 25-26 knees
  [-0.1, 0.08], [0.1, 0.08],                     // 27-28 ankles
  [-0.1, 0.03], [0.1, 0.03],                     // 29-30 heels
  [-0.1, 0.01], [0.1, 0.01],                     // 31-32 foot index
];

export const SIM_MAX_DISTANCE_M = 10;
export const SIM_MIN_DISTANCE_M = 0.6;

export class SimWorld {
  people: SimPerson[] = [];
  health: { camera: SensorStatus; audio: SensorStatus } = { camera: 'ok', audio: 'ok' };
  talking = false;
  /** Music on the porch speaker (key K cycles), at sim.musicBpm, run through the real beat tracker. */
  music: 'off' | 'disco' | 'shuffle' = 'off';
  private beat: BeatTracker;
  private lastBeatSampleMs: number | null = null;
  private nextKey = 1;
  private pendingShouts: number[] = [];
  private shoutUntilMs = 0;
  private baselineDb: number;
  private levelDb: number;
  private lastStepMs: number | null = null;
  private tilt: number;

  constructor(
    private cfg: ShowConfig,
    private rng: () => number = Math.random,
  ) {
    this.tilt = fitTilt(cfg.geometry);
    this.beat = new BeatTracker(cfg.music);
    this.baselineDb = cfg.sim.quietLevelDb;
    this.levelDb = cfg.sim.quietLevelDb;
  }

  setConfig(cfg: ShowConfig): void {
    this.cfg = cfg;
    this.tilt = fitTilt(cfg.geometry);
    this.beat.setConfig(cfg.music);
  }

  /**
   * Feeds the beat tracker 100 onset-strength samples a second up to `nowMs`,
   * shaped like spectral flux from the porch speaker when music is on (key K
   * cycles: off, disco, shuffle). Disco: a kick on every beat, claps on 2 and
   * 4, octave bass and hi-hats on the "and". Shuffle (Monster Mash): a backbeat
   * snare, a walking bass on every beat, swung piano and hats two-thirds
   * through the beat. Slightly sloppy timing and room noise throughout.
   */
  private listen(nowMs: number): void {
    const sim = this.cfg.sim;
    let t = this.lastBeatSampleMs ?? nowMs - 10;
    const beatMs = 60000 / sim.musicBpm;
    const hit = (offset: number) => {
      const k = Math.floor((t - offset) / beatMs);
      const start = k * beatMs + offset;
      return t - 10 < start && start <= t ? k : null;
    };
    for (; t + 10 <= nowMs; t += 10) {
      let onset = this.rng() * 0.6;
      let low = this.rng() * 0.3;
      let level = sim.quietLevelDb;
      if (this.music !== 'off') {
        level = sim.musicLevelDb;
        const k = hit(0);
        if (this.music === 'disco') {
          if (k !== null) {
            onset += 6 + (k % 2 === 1 ? 3 : 0); // kick (+ clap on 2 and 4)
            low += 6;
          }
          if (hit(beatMs / 2) !== null) {
            onset += 3.5; // octave bass + hat
            low += 2;
          }
        } else {
          if (k !== null) {
            onset += k % 2 === 1 ? 6 : 3.5; // snare backbeat, or a soft kick
            low += 3; // walking bass note
          }
          if (hit((beatMs * 2) / 3) !== null) onset += 3; // swung piano + hat
        }
        onset += this.rng() * 1.2;
      }
      this.beat.update(t, onset, low, level);
    }
    this.lastBeatSampleMs = t;
  }

  /** The simulator's beat tracker, for the debug overlay's beat graph. */
  get beatTracker(): BeatTracker {
    return this.beat;
  }

  add(x: number, distanceM = this.cfg.sim.defaultDistanceM, heightM = this.cfg.sim.personHeightM): SimPerson {
    const p: SimPerson = { key: this.nextKey++, x, distanceM, heightM, phase: this.rng() * 6, moving: false, waving: false };
    this.people.push(p);
    return p;
  }

  remove(key: number): void {
    this.people = this.people.filter((p) => p.key !== key);
  }

  clear(): void {
    this.people = [];
  }

  move(key: number, x: number, distanceM: number): void {
    const p = this.people.find((q) => q.key === key);
    if (!p) return;
    p.moving = Math.abs(p.distanceM - distanceM) + Math.abs(p.x - x) > 1e-4;
    p.x = Math.min(1.1, Math.max(-0.1, x));
    p.distanceM = Math.min(SIM_MAX_DISTANCE_M, Math.max(SIM_MIN_DISTANCE_M, distanceM));
    delete p.script;
  }

  shout(nowMs: number): void {
    this.pendingShouts.push(this.cfg.sim.shoutLevelDb);
    this.shoutUntilMs = nowMs + 350;
  }

  /** Scripted scenarios for testing whole encounters without touching the mouse. */
  playScenario(name: 'family' | 'passerby' | 'lurker', nowMs: number): void {
    const v = this.cfg.sim.walkSpeedMps;
    const add = (heightM: number, script: { tS: number; x: number; d: number }[]) => {
      const p = this.add(script[0]!.x, script[0]!.d, heightM);
      p.script = script;
      p.scriptStartMs = nowMs;
    };
    if (name === 'family') {
      // A family of four approaches, lingers 20 s at the door, then leaves.
      const members: [number, number, number][] = [[1.78, 0.38, 2.0], [1.65, 0.5, 2.2], [1.15, 0.44, 1.4], [1.05, 0.58, 1.6]];
      members.forEach(([h, x, stop], i) => {
        const start = 9 + i * 0.4;
        const tArrive = (start - stop) / v;
        add(h, [
          { tS: 0, x: x - 0.1, d: start },
          { tS: tArrive, x, d: stop },
          { tS: tArrive + 20, x: x + 0.02, d: stop },
          { tS: tArrive + 20 + (10 - stop) / v, x: x + 0.15, d: 10 },
        ]);
      });
    } else if (name === 'passerby') {
      // Someone walks along the street without approaching: should notice, never scare.
      add(1.75, [{ tS: 0, x: -0.05, d: 6.5 }, { tS: 9, x: 1.05, d: 6.5 }]);
    } else {
      // One person drifts in to mid range and lingers: tests the linger rule.
      add(1.7, [{ tS: 0, x: 0.8, d: 8 }, { tS: 4, x: 0.65, d: 3.5 }, { tS: 30, x: 0.6, d: 3.3 }, { tS: 36, x: 0.9, d: 9.5 }]);
    }
  }

  private runScripts(nowMs: number): void {
    const done: number[] = [];
    for (const p of this.people) {
      if (!p.script || p.scriptStartMs === undefined) continue;
      const t = (nowMs - p.scriptStartMs) / 1000;
      const ks = p.script;
      const last = ks[ks.length - 1]!;
      if (t >= last.tS) {
        done.push(p.key);
        continue;
      }
      let i = 0;
      while (i < ks.length - 2 && t > ks[i + 1]!.tS) i++;
      const a = ks[i]!;
      const b = ks[i + 1]!;
      const k = b.tS > a.tS ? (t - a.tS) / (b.tS - a.tS) : 1;
      const x = a.x + (b.x - a.x) * k;
      const d = a.d + (b.d - a.d) * k;
      p.moving = Math.abs(b.d - a.d) + Math.abs(b.x - a.x) > 0.05;
      p.x = x;
      p.distanceM = d;
    }
    for (const key of done) this.remove(key);
  }

  private pose(p: SimPerson): Landmark[] {
    const g = this.cfg.geometry;
    const s = p.heightM / 1.7;
    const jitter = this.cfg.sim.jitter;
    const swing = p.moving ? Math.sin(p.phase) : 0;
    return BODY.map(([lat, h], i) => {
      let lx = lat * s;
      let hy = h * s;
      // Walking toward the camera: alternate feet lift, arms swing a little.
      if (i >= 25 && i <= 32) {
        const left = i % 2 === 1;
        const lift = Math.max(0, left ? swing : -swing) * 0.12 * s * (i >= 27 ? 1 : 0.5);
        hy += lift;
      }
      if (i === 15 || i === 17 || i === 19 || i === 21) lx += swing * 0.04 * s;
      if (i === 16 || i === 18 || i === 20 || i === 22) lx -= swing * 0.04 * s;
      if (p.waving && (i === 14 || i === 16 || i === 18 || i === 20 || i === 22)) {
        const wave = Math.sin(p.phase * 2.5) * 0.08 * s;
        if (i === 14) [lx, hy] = [0.32 * s, 1.5 * s];
        else [lx, hy] = [0.36 * s + wave, 1.78 * s];
      }
      const x = p.x + widthAtDistance(lx, p.distanceM, g) + (this.rng() - 0.5) * 2 * jitter;
      const y = rowForPoint(p.distanceM, hy, g, this.tilt) + (this.rng() - 0.5) * 2 * jitter;
      const offFrame = y > 1 || y < 0 || x < 0 || x > 1;
      return { x, y, visibility: offFrame ? 0.1 : 0.95 };
    });
  }

  step(nowMs: number): PerceptionFrame {
    const dt = this.lastStepMs === null ? 0 : (nowMs - this.lastStepMs) / 1000;
    this.lastStepMs = nowMs;
    this.runScripts(nowMs);

    const detections: Detection[] = [];
    if (this.health.camera === 'ok') {
      for (const p of this.people) {
        p.phase += dt * (p.moving ? 7 : 1);
        if (this.rng() < this.cfg.sim.dropoutRate) continue;
        const lm = this.pose(p);
        if (lm.every((q) => q.visibility < 0.5)) continue;
        detections.push({ timeMs: nowMs, landmarks: lm, confidence: 0.9 });
      }
    }

    // Audio: a quiet street, speech-like wobble while talking, a spike on a shout.
    const sim = this.cfg.sim;
    let target = sim.quietLevelDb + (this.rng() - 0.5) * 3;
    if (this.talking) target = sim.talkLevelDb + Math.sin(nowMs / 90) * 6 + Math.sin(nowMs / 37) * 4;
    if (nowMs < this.shoutUntilMs) target = sim.shoutLevelDb;
    this.levelDb = target;
    const audioOk = this.health.audio === 'ok';
    this.listen(nowMs);
    const shouts = audioOk ? this.pendingShouts : [];
    this.pendingShouts = [];

    return {
      timeMs: nowMs,
      detections,
      audio: audioOk ? { levelDb: this.levelDb, baselineDb: this.baselineDb } : { levelDb: sim.quietLevelDb, baselineDb: sim.quietLevelDb },
      shouts,
      music: audioOk && this.cfg.music.enabled ? this.beat.state(nowMs) : NO_MUSIC,
      health: { camera: this.health.camera, audio: this.health.audio, source: 'sim', perceptionLatencyMs: 0 },
    };
  }
}

/** Runs a SimWorld at the perception tick rate. */
export class SimSource implements PerceptionSource {
  readonly kind = 'sim' as const;
  private timer: number | null = null;

  constructor(
    readonly world: SimWorld,
    private tickHz: () => number,
  ) {}

  start(onFrame: (frame: PerceptionFrame) => void): void {
    const tick = () => {
      onFrame(this.world.step(performance.now()));
      this.timer = window.setTimeout(tick, 1000 / Math.max(1, this.tickHz()));
    };
    tick();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Plays a recorded perception log back as if it were live, looping at the end. */
export class ReplaySource implements PerceptionSource {
  readonly kind = 'replay' as const;
  private timer: number | null = null;
  private frames: PerceptionFrame[] = [];
  loaded: Promise<number>;

  constructor(readonly logName: string) {
    this.loaded = fetch(`/api/logs/${encodeURIComponent(logName)}`)
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        this.frames = text.split('\n').map(parseFrame).filter((f): f is PerceptionFrame => f !== null);
        return this.frames.length;
      })
      .catch(() => 0);
  }

  start(onFrame: (frame: PerceptionFrame) => void): void {
    void this.loaded.then(() => {
      if (this.frames.length === 0) {
        console.warn(`[replay] log "${this.logName}" is empty or missing`);
        return;
      }
      let i = 0;
      let offset = performance.now() - this.frames[0]!.timeMs;
      const play = () => {
        const f = this.frames[i]!;
        onFrame({ ...f, timeMs: f.timeMs + offset, health: { ...f.health, source: 'replay' } });
        i++;
        if (i >= this.frames.length) {
          i = 0;
          offset = performance.now() + 1000 - this.frames[0]!.timeMs;
        }
        const wait = this.frames[i]!.timeMs + offset - performance.now();
        this.timer = window.setTimeout(play, Math.max(0, wait));
      };
      play();
    });
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

// ---------- mouse controls on the simulator's walk map ----------

export interface Rect { x: number; y: number; w: number; h: number }

export function walkMapToWorld(r: Rect, px: number, py: number): { x: number; d: number } {
  const x = (px - r.x) / r.w;
  const t = (py - r.y) / r.h; // 0 at the top (far), 1 at the bottom (the window)
  const d = SIM_MAX_DISTANCE_M - t * (SIM_MAX_DISTANCE_M - SIM_MIN_DISTANCE_M);
  return { x, d };
}

export function worldToWalkMap(r: Rect, x: number, d: number): { px: number; py: number } {
  const t = (SIM_MAX_DISTANCE_M - d) / (SIM_MAX_DISTANCE_M - SIM_MIN_DISTANCE_M);
  return { px: r.x + x * r.w, py: r.y + t * r.h };
}

/**
 * Click on the walk map adds a person, drag moves them (down = toward the
 * window), the wheel changes distance, right-click removes.
 */
export function attachSimControls(el: HTMLElement, world: SimWorld, mapRect: () => Rect | null, cfg: () => ShowConfig): () => void {
  let dragKey: number | null = null;
  const toCanvas = (e: MouseEvent) => {
    const b = el.getBoundingClientRect();
    const scale = (el as HTMLCanvasElement).width / b.width || 1;
    return { px: (e.clientX - b.left) * scale, py: (e.clientY - b.top) * scale };
  };
  const inside = (r: Rect, px: number, py: number) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  const hit = (r: Rect, px: number, py: number) => {
    let best: SimPerson | null = null;
    let bestD = 22 * ((el as HTMLCanvasElement).width / el.getBoundingClientRect().width || 1);
    for (const p of world.people) {
      const m = worldToWalkMap(r, p.x, p.distanceM);
      const d = Math.hypot(m.px - px, m.py - py);
      if (d < bestD) [best, bestD] = [p, d];
    }
    return best;
  };

  const down = (e: PointerEvent) => {
    const r = mapRect();
    if (!r || e.button !== 0) return;
    const { px, py } = toCanvas(e);
    if (!inside(r, px, py)) return;
    e.preventDefault();
    const existing = hit(r, px, py);
    if (existing) dragKey = existing.key;
    else {
      const w = walkMapToWorld(r, px, py);
      dragKey = world.add(w.x, w.d).key;
    }
    el.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    const r = mapRect();
    if (!r || dragKey === null) return;
    const { px, py } = toCanvas(e);
    const w = walkMapToWorld(r, px, py);
    world.move(dragKey, w.x, w.d);
  };
  const up = (e: PointerEvent) => {
    if (dragKey !== null) {
      const p = world.people.find((q) => q.key === dragKey);
      if (p) p.moving = false;
    }
    dragKey = null;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };
  const wheel = (e: WheelEvent) => {
    const r = mapRect();
    if (!r) return;
    const { px, py } = toCanvas(e);
    if (!inside(r, px, py)) return;
    e.preventDefault();
    const p = hit(r, px, py) ?? world.people[world.people.length - 1];
    if (p) world.move(p.key, p.x, p.distanceM + Math.sign(e.deltaY) * cfg().sim.wheelStepM);
  };
  const context = (e: MouseEvent) => {
    const r = mapRect();
    if (!r) return;
    const { px, py } = toCanvas(e);
    if (!inside(r, px, py)) return;
    e.preventDefault();
    const p = hit(r, px, py);
    if (p) world.remove(p.key);
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('wheel', wheel, { passive: false });
  el.addEventListener('contextmenu', context);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('wheel', wheel);
    el.removeEventListener('contextmenu', context);
  };
}
