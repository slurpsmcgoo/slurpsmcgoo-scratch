// Moves each person's pose forward to the moment a frame is drawn. Pose
// results arrive at the camera/model rate (30 a second at best) and are
// already some tens of milliseconds old; drawing happens 60 times a second.
// Without this, bodies step between results and trail the real person.
//
// From the last two pose results of each person we get a velocity per body
// point, and extrapolate: by the time since the result arrived, plus
// `predictMs` to cover camera and model delay. Extrapolation is capped at
// `maxPredictMs`; past that the person's last pose is returned unchanged (the
// same array), so scenes can still tell that tracking has stalled.

import type { Landmark, Person } from '../types.ts';

export interface PredictConfig {
  predictMotion: boolean;
  predictMs: number;
  maxPredictMs: number;
}

interface Track {
  lm: Landmark[];
  prev: Landmark[] | null;
  frameMs: number;
  prevFrameMs: number;
  arrivedMs: number;
}

/** Furthest a point may be pushed, as a fraction of the frame; stops wild jumps from bad velocities. */
const MAX_SHIFT = 0.06;

export class MotionPredictor {
  private tracks = new Map<number, Track>();

  constructor(private cfg: PredictConfig) {}

  setConfig(cfg: PredictConfig): void {
    this.cfg = cfg;
  }

  reset(): void {
    this.tracks.clear();
  }

  /** Call with every new AudienceState: `frameMs` is the frame's time, `arrivedMs` the local clock now. */
  observe(people: Person[], frameMs: number, arrivedMs: number): void {
    const seen = new Set<number>();
    for (const p of people) {
      seen.add(p.id);
      const t = this.tracks.get(p.id);
      if (!t) {
        this.tracks.set(p.id, { lm: p.landmarks, prev: null, frameMs, prevFrameMs: frameMs, arrivedMs });
      } else if (t.lm !== p.landmarks) {
        t.prev = t.lm;
        t.prevFrameMs = t.frameMs;
        t.lm = p.landmarks;
        t.frameMs = frameMs;
        t.arrivedMs = arrivedMs;
      }
    }
    for (const id of this.tracks.keys()) if (!seen.has(id)) this.tracks.delete(id);
  }

  /** People with their poses moved forward to `nowMs` (local clock). */
  apply(people: Person[], nowMs: number): Person[] {
    if (!this.cfg.predictMotion) return people;
    return people.map((p) => {
      const t = this.tracks.get(p.id);
      if (!t || !t.prev || t.lm !== p.landmarks) return p;
      const since = nowMs - t.arrivedMs;
      if (since < 0 || since > this.cfg.maxPredictMs) return p;
      const dt = t.frameMs - t.prevFrameMs;
      if (dt <= 0 || dt > 250) return p;
      const ahead = Math.min(this.cfg.maxPredictMs, since + this.cfg.predictMs) / dt;
      const prev = t.prev;
      const landmarks = t.lm.map((q, i) => {
        const r = prev[i];
        if (!r) return q;
        const dx = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, (q.x - r.x) * ahead));
        const dy = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, (q.y - r.y) * ahead));
        return { x: q.x + dx, y: q.y + dy, visibility: q.visibility };
      });
      return { ...p, landmarks };
    });
  }
}
