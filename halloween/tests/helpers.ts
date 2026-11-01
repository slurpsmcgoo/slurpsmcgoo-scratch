// Shared test fixtures.

import fs from 'node:fs';
import path from 'node:path';
import type { ShowConfig } from '../src/config.ts';
import type { AudienceEvent, AudienceState, Person, Zone } from '../src/types.ts';
import { NO_MUSIC } from '../src/world/frame.ts';

export const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * show.json, minus the camera framing saved on show night (active area, ignore
 * zones), so tests don't depend on where the camera happens to point.
 */
export function loadConfig(): ShowConfig {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'show.json'), 'utf8')) as ShowConfig;
  return { ...cfg, perception: { ...cfg.perception, activeArea: null, ignoreZones: [] } };
}

export function person(id: number, distanceM: number, zone: Zone, x = 0.5): Person {
  return { id, x, distanceM, zone, approachMps: 0, lateralPerS: 0, landmarks: [], firstSeenMs: 0, confidence: 0.9 };
}

export function audience(timeMs: number, people: Person[], events: AudienceEvent[] = []): AudienceState {
  let nearest: Person | null = null;
  for (const p of people) if (!nearest || p.distanceM < nearest.distanceM) nearest = p;
  return {
    timeMs,
    people,
    nearest,
    audio: { levelDb: -60, baselineDb: -60 },
    music: NO_MUSIC,
    events,
    cameraArea: { x: 0, y: 0, w: 1, h: 1 },
    health: { camera: 'ok', audio: 'ok', source: 'sim', perceptionLatencyMs: 0 },
  };
}

/** Deterministic PRNG for tests. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
