// One tick of raw perception input, before tracking. Live sensors, the
// simulator and replayed logs all produce these, so everything downstream is
// the same code path. A tick is also exactly what the recorder writes: one
// JSON line of numbers, never images.

import type { AudioLevels, Detection, MusicState, SensorHealth } from '../types.ts';

export interface PerceptionFrame {
  timeMs: number;
  detections: Detection[];
  audio: AudioLevels;
  shouts: number[]; // loudness (dB) of each shout detected since the previous tick
  music: MusicState; // the beat clock at timeMs
  cameraAspect?: number; // the camera picture's width / height (from the live video; else perception.cameraWidth/Height)
  onsets?: number[]; // beat-tracker onset strength samples (100 a second) since the previous tick; numbers only, for tuning from recordings
  health: SensorHealth;
}

export const NO_MUSIC: MusicState = { playing: false, bpm: 120, beat: 0, phase: 0, energy: 0 };

export interface PerceptionSource {
  readonly kind: SensorHealth['source'];
  start(onFrame: (frame: PerceptionFrame) => void): void;
  stop(): void;
  /** Run perception at the camera's full frame rate (Skeleton Mirror) or the normal tick rate. */
  setFullRate?(on: boolean): void;
}

/** Rounds numbers so log lines stay small. Four decimals is ~0.1 mm on a 2 m wide frame. */
export function serializeFrame(frame: PerceptionFrame): string {
  return JSON.stringify(frame, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v));
}

export function parseFrame(line: string): PerceptionFrame | null {
  try {
    const f = JSON.parse(line) as PerceptionFrame;
    if (typeof f.timeMs !== 'number' || !Array.isArray(f.detections)) return null;
    f.shouts ??= [];
    f.music ??= NO_MUSIC; // logs recorded before music tracking
    return f;
  } catch {
    return null;
  }
}
