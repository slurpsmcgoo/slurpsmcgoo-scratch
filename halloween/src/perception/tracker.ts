// Keeps stable IDs for people across ticks by matching each detection to the
// nearest existing track by hip-center position. Hysteresis prevents flicker:
// a new person must be seen in `confirmFrames` consecutive ticks to count, and
// a confirmed person must be missing for `dropAfterS` before they are removed.

import type { ShowConfig } from '../config.ts';
import type { Detection } from '../types.ts';
import { hipCenter } from './geometry.ts';

export interface Track {
  id: number;            // 0 while tentative; assigned on confirmation
  key: number;           // internal, stable from first sighting
  confirmed: boolean;
  hits: number;          // consecutive ticks seen (while tentative)
  firstSeenMs: number;
  lastSeenMs: number;
  hip: { x: number; y: number };
  detection: Detection;  // most recent
  seenThisTick: boolean;
}

export interface TrackerResult {
  tracks: Track[];  // confirmed tracks only, including ones briefly missing
  entered: number[];
  left: number[];
}

export class Tracker {
  private tracks: Track[] = [];
  private nextKey = 1;
  private nextId = 1;

  constructor(
    private cfg: ShowConfig['tracker'],
    private maxPeople = Infinity, // the pose model's numPoses
  ) {}

  setConfig(cfg: ShowConfig['tracker'], maxPeople = this.maxPeople): void {
    this.cfg = cfg;
    this.maxPeople = maxPeople;
  }

  reset(): void {
    this.tracks = [];
  }

  update(detections: Detection[], timeMs: number): TrackerResult {
    const entered: number[] = [];
    const left: number[] = [];
    for (const t of this.tracks) t.seenThisTick = false;

    // Greedy nearest-pair matching, closest pairs first.
    const pairs: { d: number; ti: number; di: number }[] = [];
    const hips = detections.map((d) => hipCenter(d.landmarks));
    this.tracks.forEach((t, ti) => {
      hips.forEach((h, di) => {
        const d = Math.hypot(h.x - t.hip.x, h.y - t.hip.y);
        if (d <= this.cfg.maxMatchDistance) pairs.push({ d, ti, di });
      });
    });
    pairs.sort((a, b) => a.d - b.d || a.ti - b.ti || a.di - b.di);
    const usedT = new Set<number>();
    const usedD = new Set<number>();
    for (const p of pairs) {
      if (usedT.has(p.ti) || usedD.has(p.di)) continue;
      usedT.add(p.ti);
      usedD.add(p.di);
      const t = this.tracks[p.ti]!;
      t.detection = detections[p.di]!;
      t.hip = hips[p.di]!;
      t.lastSeenMs = timeMs;
      t.seenThisTick = true;
      if (!t.confirmed) {
        t.hits++;
        if (t.hits >= this.cfg.confirmFrames) {
          t.confirmed = true;
          t.id = this.nextId++;
          entered.push(t.id);
        }
      }
    }

    // New tentative tracks for unmatched detections.
    detections.forEach((det, di) => {
      if (usedD.has(di)) return;
      const t: Track = {
        id: 0,
        key: this.nextKey++,
        confirmed: false,
        hits: 1,
        firstSeenMs: timeMs,
        lastSeenMs: timeMs,
        hip: hips[di]!,
        detection: det,
        seenThisTick: true,
      };
      if (this.cfg.confirmFrames <= 1) {
        t.confirmed = true;
        t.id = this.nextId++;
        entered.push(t.id);
      }
      this.tracks.push(t);
    });

    // Tentative tracks must be seen every tick; confirmed ones get a grace period.
    this.tracks = this.tracks.filter((t) => {
      if (t.seenThisTick) return true;
      if (!t.confirmed) return false;
      if (timeMs - t.lastSeenMs > this.cfg.dropAfterS * 1000) {
        left.push(t.id);
        return false;
      }
      return true;
    });

    // The camera never sees more than maxPeople at once, so if a newcomer pushes
    // the count over, whoever has been missing longest has really left.
    let confirmed = this.tracks.filter((t) => t.confirmed);
    while (confirmed.length > this.maxPeople) {
      const missing = confirmed.filter((t) => !t.seenThisTick).sort((a, b) => a.lastSeenMs - b.lastSeenMs);
      const gone = missing[0];
      if (!gone) break;
      left.push(gone.id);
      this.tracks = this.tracks.filter((t) => t !== gone);
      confirmed = confirmed.filter((t) => t !== gone);
    }

    return { tracks: confirmed, entered, left };
  }
}
