// Builds one AudienceState per perception tick: sanity checks, tracking,
// smoothing, distance, zones and events. Scenes and the director read only the
// result. Pure and deterministic: the same frames in give the same states out,
// which is what makes replay and simulation trustworthy.

import type { ShowConfig } from '../config.ts';
import type { AudienceEvent, AudienceState, Detection, Landmark, Person, Zone } from '../types.ts';
import { areaRect, bodyHeight, estimateDistance, fitTilt, hipCenter, shoulderWidthAt, shoulderWidthNorm, zoneFor, type AreaRect } from '../perception/geometry.ts';
import { logicalSize } from '../config.ts';
import { OneEuroFilter } from '../perception/oneEuro.ts';
import { Tracker } from '../perception/tracker.ts';
import type { PerceptionFrame } from './frame.ts';

interface PersonFilters {
  lm: { x: OneEuroFilter; y: OneEuroFilter }[];
  distance: OneEuroFilter;
  landmarks: Landmark[];
  areaLandmarks: Landmark[]; // landmarks relative to the active area; kept as the same array until either changes
  areaKey: string;
  distanceM: number;
  x: number;
  zone: Zone;
  approachMps: number;
  lateralPerS: number;
  lastUpdateMs: number;
  shoulderM: number | null; // this person's own shoulder width, learned while their feet are visible
}

export class AudienceBuilder {
  private tracker: Tracker;
  private filters = new Map<number, PersonFilters>();
  private tilt: number;
  private hadPeople = false;
  private cfg: ShowConfig;

  constructor(cfg: ShowConfig) {
    this.cfg = cfg;
    this.tracker = new Tracker(cfg.tracker, cfg.perception.numPoses);
    this.tilt = fitTilt(cfg.geometry);
  }

  setConfig(cfg: ShowConfig): void {
    this.cfg = cfg;
    this.tracker.setConfig(cfg.tracker, cfg.perception.numPoses);
    this.tilt = fitTilt(cfg.geometry);
    for (const f of this.filters.values()) {
      for (const p of f.lm) {
        p.x.params = this.landmarkParams();
        p.y.params = this.landmarkParams();
      }
      f.distance.params = this.distanceParams();
    }
  }

  reset(): void {
    this.tracker.reset();
    this.filters.clear();
    this.hadPeople = false;
  }

  private landmarkParams() {
    const s = this.cfg.smoothing;
    return { minCutoff: s.minCutoff, beta: s.beta, dCutoff: s.dCutoff };
  }

  private distanceParams() {
    const s = this.cfg.smoothing;
    return { minCutoff: s.distanceMinCutoff, beta: s.distanceBeta, dCutoff: s.dCutoff };
  }

  /** The camera's active area for this frame (see perception.activeArea). */
  area(frame: PerceptionFrame): AreaRect {
    const p = this.cfg.perception;
    const size = logicalSize(this.cfg.output.orientation);
    return areaRect(p.activeArea, size.width / size.height, frame.cameraAspect ?? p.cameraWidth / p.cameraHeight);
  }

  /**
   * Rejects detections that are tiny, at an impossible distance, beyond
   * numPoses, or (with ignoreOutsideArea) standing outside the active area.
   */
  sanitize(detections: Detection[], area?: AreaRect): Detection[] {
    const p = this.cfg.perception;
    const inside = (d: Detection) => {
      if (!area || !p.ignoreOutsideArea) return true;
      const h = hipCenter(d.landmarks);
      return h.x >= area.x && h.x <= area.x + area.w && h.y >= area.y && h.y <= area.y + area.h;
    };
    return detections
      .filter((d) => d.landmarks.length === 33 && d.confidence >= p.minConfidence && bodyHeight(d.landmarks) >= p.minBodyHeight)
      .filter(inside)
      .filter((d) => {
        const est = estimateDistance(d.landmarks, this.cfg.geometry, this.tilt);
        return est !== null && est.distanceM >= p.minDistanceM && est.distanceM <= p.maxDistanceM;
      })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, p.numPoses);
  }

  ingest(frame: PerceptionFrame): AudienceState {
    const tS = frame.timeMs / 1000;
    const events: AudienceEvent[] = [];
    const area = this.area(frame);
    const areaKey = `${area.x},${area.y},${area.w},${area.h}`;
    const result = this.tracker.update(this.sanitize(frame.detections, area), frame.timeMs);
    const velTau = this.cfg.smoothing.velocityTimeS;

    for (const id of result.entered) events.push({ type: 'enter', personId: id });

    const people: Person[] = [];
    for (const track of result.tracks) {
      let f = this.filters.get(track.id);
      const fresh = track.seenThisTick;
      if (!f) {
        f = {
          lm: Array.from({ length: 33 }, () => ({ x: new OneEuroFilter(this.landmarkParams()), y: new OneEuroFilter(this.landmarkParams()) })),
          distance: new OneEuroFilter(this.distanceParams()),
          landmarks: [],
          areaLandmarks: [],
          areaKey: '',
          distanceM: 0,
          x: 0,
          zone: 'far',
          approachMps: 0,
          lateralPerS: 0,
          lastUpdateMs: frame.timeMs,
          shoulderM: null,
        };
        this.filters.set(track.id, f);
      }
      if (fresh) {
        const raw = track.detection.landmarks;
        const smoothed = raw.map((p, i) => ({
          x: f!.lm[i]!.x.filter(p.x, tS),
          y: f!.lm[i]!.y.filter(p.y, tS),
          visibility: p.visibility,
        }));
        const est = estimateDistance(smoothed, this.cfg.geometry, this.tilt, f.shoulderM ?? undefined);
        if (est?.method === 'feet') {
          // Learn this person's shoulder width so the fallback works for children too.
          const w = shoulderWidthNorm(smoothed);
          if (w !== null) {
            const m = shoulderWidthAt(w, est.distanceM, this.cfg.geometry);
            f.shoulderM = f.shoulderM === null ? m : f.shoulderM + 0.2 * (m - f.shoulderM);
          }
        }
        const prevD = f.distanceM;
        const prevX = f.x;
        const isNew = f.landmarks.length === 0;
        const d = f.distance.filter(est ? est.distanceM : prevD, tS);
        const x = hipCenter(smoothed).x;
        const dt = (frame.timeMs - f.lastUpdateMs) / 1000;
        if (!isNew && dt > 0) {
          const k = 1 - Math.exp(-dt / velTau);
          f.approachMps += k * ((prevD - d) / dt - f.approachMps);
          f.lateralPerS += k * ((x - prevX) / dt - f.lateralPerS);
        }
        const zone = zoneFor(d, this.cfg.zones, isNew ? undefined : f.zone);
        if (!isNew && zone !== f.zone) events.push({ type: 'zoneChange', personId: track.id, from: f.zone, to: zone });
        f.landmarks = smoothed;
        f.distanceM = d;
        f.x = x;
        f.zone = zone;
        f.lastUpdateMs = frame.timeMs;
      }
      if (f.landmarks.length === 0) continue;
      // Scenes see the person relative to the active area. Recompute only when
      // the pose or the area changed, so an unchanged pose stays the same array.
      if (fresh || f.areaKey !== areaKey) {
        f.areaLandmarks = f.landmarks.map((q) => ({ x: (q.x - area.x) / area.w, y: (q.y - area.y) / area.h, visibility: q.visibility }));
        f.areaKey = areaKey;
      }
      people.push({
        id: track.id,
        x: (f.x - area.x) / area.w,
        distanceM: f.distanceM,
        zone: f.zone,
        approachMps: f.approachMps,
        lateralPerS: f.lateralPerS / area.w,
        landmarks: f.areaLandmarks,
        firstSeenMs: track.firstSeenMs,
        confidence: track.detection.confidence,
      });
    }

    for (const id of result.left) {
      this.filters.delete(id);
      events.push({ type: 'leave', personId: id });
    }
    for (const db of frame.shouts) events.push({ type: 'shout', db });
    if (this.hadPeople && people.length === 0) events.push({ type: 'empty' });
    this.hadPeople = people.length > 0;

    people.sort((a, b) => a.id - b.id);
    let nearest: Person | null = null;
    for (const p of people) if (!nearest || p.distanceM < nearest.distanceM) nearest = p;

    return {
      timeMs: frame.timeMs,
      people,
      nearest,
      audio: frame.audio,
      music: frame.music,
      events,
      cameraArea: area,
      health: frame.health,
    };
  }
}
