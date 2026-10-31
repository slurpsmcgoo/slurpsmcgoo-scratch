// src/types.ts — shared contract. Scenes import only from here.

export type Zone = 'far' | 'mid' | 'near';

/** A pose point in visitor-view coordinates: 0..1, x = 0 is the window's left edge as a visitor sees it. */
export interface Landmark {
  x: number;
  y: number;
  visibility: number; // 0..1, from the pose model
}

/** Raw output of a pose model or the simulator, before tracking. */
export interface Detection {
  timeMs: number;
  landmarks: Landmark[]; // 33 points, MediaPipe Pose order
  confidence: number;    // 0..1
}

export interface Person {
  id: number;              // stable while tracked
  x: number;               // 0..1 across the camera's active area, visitor view
  distanceM: number;       // estimated distance from the window, meters
  zone: Zone;
  approachMps: number;     // positive = moving toward the window
  lateralPerS: number;     // change in x per second
  landmarks: Landmark[];   // smoothed, visitor view, relative to the active area (see AudienceState.cameraArea)
  firstSeenMs: number;
  confidence: number;      // 0..1
}

export type AudienceEvent =
  | { type: 'enter'; personId: number }
  | { type: 'leave'; personId: number }
  | { type: 'zoneChange'; personId: number; from: Zone; to: Zone }
  | { type: 'shout'; db: number }
  | { type: 'empty' };

export interface AudioLevels {
  levelDb: number;
  baselineDb: number;
}

/** The beat of music playing near the microphone (a porch speaker), for light shows. */
export interface MusicState {
  playing: boolean; // a steady beat is being heard
  bpm: number;
  beat: number;     // whole beats counted since the music started
  phase: number;    // 0..1 position within the current beat; 0 = on the beat
  energy: number;   // 0..1, how loud the music is
}

export type SensorStatus = 'ok' | 'stale' | 'off';

export interface SensorHealth {
  camera: SensorStatus;
  audio: SensorStatus;
  source: 'live' | 'sim' | 'replay';
  perceptionLatencyMs: number;
}

export interface AudienceState {
  timeMs: number;
  people: Person[];
  nearest: Person | null;
  audio: AudioLevels;
  music: MusicState;
  events: AudienceEvent[];
  /**
   * The camera's active area (normalized camera coordinates, visitor view).
   * People's landmarks and x are relative to it: 0..1 spans the area, which
   * maps to the whole window. Distances are measured from the full picture.
   */
  cameraArea: { x: number; y: number; w: number; h: number }; // only events since the previous tick
  health: SensorHealth;
}

export type DirectorState = 'idle' | 'noticed' | 'engaged' | 'scare' | 'cooldown';

export interface DirectorContext {
  state: DirectorState;
  stateEnteredMs: number;
  focusPersonId: number | null; // who the scene should attend to
  intensity: 'gentle' | 'normal' | 'full';
}

export interface SceneRequirements {
  camera?: boolean;
  pose?: boolean; // needs full skeletons, not just presence
  audio?: boolean;
}

export interface SceneContext {
  ctx: CanvasRenderingContext2D;
  width: number;  // logical: 1920, or 1080 in portrait
  height: number; // logical: 1080, or 1920 in portrait
  config: Record<string, unknown>; // this scene's section of show.json
}

export interface Scene {
  id: string;
  title: string;
  requires: SceneRequirements;
  scareDurationS: number; // director leaves 'scare' after this
  init(sc: SceneContext): Promise<void>;
  update(dtS: number, audience: AudienceState, director: DirectorContext): void;
  render(sc: SceneContext): void; // canvas is already cleared to black
  onStateChange?(from: DirectorState, to: DirectorState, director: DirectorContext): void;
  dispose(): void;
}

export type OperatorCommand =
  | { type: 'nextScene' }
  | { type: 'prevScene' }
  | { type: 'setScene'; id: string }
  | { type: 'scareNow' }
  | { type: 'blackout'; on: boolean }
  | { type: 'pauseInteraction'; on: boolean }
  | { type: 'sensitivity'; delta: number }
  | { type: 'intensity'; level: 'gentle' | 'normal' | 'full' };
