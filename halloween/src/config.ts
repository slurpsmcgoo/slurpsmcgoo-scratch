// Typed view of config/show.json. Every tunable number lives in that file;
// this module only describes its shape and checks it on load.

import type { Zone } from './types.ts';
import type { ActiveArea } from './perception/geometry.ts';

export type Pt = [number, number];
export type Orientation = 'landscape' | 'portrait';
export type Rotation = 0 | 90 | 180 | 270;

/** The logical canvas size for an orientation. */
export function logicalSize(o: Orientation): { width: number; height: number } {
  return o === 'portrait' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

export interface ShowConfig {
  display: { showOverlay: boolean; crossfadeS: number; hideCursor: boolean };
  output: {
    mirror: boolean;
    corners: Pt[];
    mask: Pt[];
    orientation: Orientation; // portrait: the picture is 1080 wide and 1920 tall
    rotation: Rotation;       // turns the picture on the projector, for one mounted on its side
  };
  source: { mode: 'live' | 'sim' | 'replay' };
  perception: {
    tickHz: number;
    fullRateForPoseScenes: boolean;
    numPoses: number;
    modelFile: string;
    delegate: 'GPU' | 'CPU';
    minPoseDetectionConfidence: number;
    minPosePresenceConfidence: number;
    minTrackingConfidence: number;
    cameraWidth: number;
    cameraHeight: number;
    cameraFrameRate: number;
    inferenceWidth: number; // camera frames are scaled down to this width before the pose model
    poseTimeoutMs: number;  // give up on a pose frame after this long
    poseWorkers: number;    // pose model workers; 1 is best on a GPU (see perception/pose.ts); read at page load
    predictMotion: boolean; // move poses forward to each drawn frame (see world/motionPredictor.ts)
    predictMs: number;
    maxPredictMs: number;
    cameraFeedMirrored: boolean;
    activeArea: ActiveArea | null; // the part of the camera that fills the window; null = the largest centered area (key A)
    ignoreOutsideArea: boolean;    // drop people whose hips are outside the active area
    cropToArea: boolean;           // run the pose model on just the area (plus cropMargin), for more pixels per person
    cropMargin: number;            // extra around the area, as a fraction of its size, so people at its edge stay whole
    minBodyHeight: number;
    minConfidence: number;
    minDistanceM: number;
    maxDistanceM: number;
  };
  tracker: { confirmFrames: number; dropAfterS: number; maxMatchDistance: number };
  smoothing: {
    minCutoff: number;
    beta: number;
    dCutoff: number;
    distanceMinCutoff: number;
    distanceBeta: number;
    velocityTimeS: number;
  };
  geometry: {
    cameraHeightM: number;
    verticalFovDeg: number;
    horizontalFovDeg: number;
    calibrationMarks: { footY: number; distanceM: number }[];
    footMinVisibility: number;
    footMaxY: number;
    shoulderWidthM: number;
  };
  zones: { nearM: number; midM: number; hysteresisM: number };
  audio: {
    enabled: boolean;
    analysisHz: number;
    baselineTimeS: number;
    shoutRiseDb: number;
    shoutWindowMs: number;
    shoutLockoutS: number;
    floorDb: number;
  };
  music: {
    enabled: boolean;
    fluxMaxHz: number;    // spectral flux (the beat tracker's onset signal) up to this frequency
    fluxBassHz: number;   // bins below this count double
    fluxLowMaxHz: number; // the low-end flux that places the beat (kick, bass, snare body) stops here
    fluxFloorDb: number;  // quieter than this counts as silence
    minBpm: number;
    maxBpm: number;
    windowS: number;
    analyzeEveryMs: number;
    clarityOn: number;
    clarityKeep: number;
    confirmS: number;
    holdS: number;
    pllGain: number;
    leadMs: number;       // lights hit this much before the detected beat, covering render + projector delay
    floorDb: number;
    fullDb: number;
  };
  ambient: {
    enabled: boolean;
    skipScenes: string[];  // scene ids that run without the ambient lights
    talkRiseDb: number;
    rangeDb: number;
    attackS: number;
    releaseS: number;
    flashRiseDb: number;
    flashRearmDb: number;
    flashMinGapS: number;
    glowColor: string;
    glowStrength: number;
    fireflyCount: number;
    fireflyColor: string;
    fireflyIdle: number;
    fireflySize: number;
    flashColor: string;
    flashStrength: number;
    boltColor: string;
  };
  director: {
    engageZone: Zone;
    lingerS: number;
    scareZone: Zone;
    scareOnShout: boolean;
    scareDelayMinS: number;
    scareDelayMaxS: number;
    cooldownS: number;
    emptyResetS: number;
    focusSwitchMarginM: number;
    gentleCooldownFactor: number;
  };
  sensitivity: {
    min: number;
    max: number;
    zoneFactorPerStep: number;
    lingerFactorPerStep: number;
    shoutDbPerStep: number;
  };
  show: { startScene: string; playlist: string[]; rotateEveryS: number };
  health: {
    cameraStaleS: number;
    cameraRetryS: number;
    audioStaleS: number;
    audioRetryS: number;
    heartbeatS: number;
  };
  sim: {
    defaultDistanceM: number;
    personHeightM: number;
    jitter: number;
    dropoutRate: number;
    wheelStepM: number;
    quietLevelDb: number;
    talkLevelDb: number;
    shoutLevelDb: number;
    walkSpeedMps: number;
    musicBpm: number;     // tempo of the simulated disco track (key K)
    musicLevelDb: number;
  };
  recorder: { enabled: boolean; recordVideo: boolean };
  server: { port: number };
  scenes: Record<string, Record<string, unknown>>;
}

const REQUIRED_SECTIONS: (keyof ShowConfig)[] = [
  'display', 'output', 'source', 'perception', 'tracker', 'smoothing', 'geometry', 'zones',
  'audio', 'music', 'ambient', 'director', 'sensitivity', 'show', 'health', 'sim', 'recorder', 'server', 'scenes',
];

/** Returns a list of problems; empty means the config is usable. */
export function validateConfig(raw: unknown): string[] {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null) return ['config is not an object'];
  const cfg = raw as Record<string, unknown>;
  for (const key of REQUIRED_SECTIONS) {
    if (typeof cfg[key] !== 'object' || cfg[key] === null) problems.push(`missing section "${key}"`);
  }
  if (problems.length) return problems;
  const c = raw as ShowConfig;
  const isPts = (v: unknown, min: number) =>
    Array.isArray(v) && v.length >= min && v.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
  if (!isPts(c.output.corners, 4) || c.output.corners.length !== 4) problems.push('output.corners must be 4 [x, y] points');
  if (!isPts(c.output.mask, 3)) problems.push('output.mask must have at least 3 [x, y] points');
  if (c.output.orientation !== 'landscape' && c.output.orientation !== 'portrait') problems.push('output.orientation must be "landscape" or "portrait"');
  if (![0, 90, 180, 270].includes(c.output.rotation)) problems.push('output.rotation must be 0, 90, 180 or 270');
  if (!(c.zones.nearM < c.zones.midM)) problems.push('zones.nearM must be less than zones.midM');
  if (c.geometry.calibrationMarks.length < 1) problems.push('geometry.calibrationMarks needs at least one mark');
  if (!(c.director.scareDelayMinS <= c.director.scareDelayMaxS)) problems.push('director.scareDelayMinS > scareDelayMaxS');
  if (!Array.isArray(c.show.playlist) || c.show.playlist.length === 0) problems.push('show.playlist is empty');
  return problems;
}

/**
 * Applies the operator's sensitivity level. Higher sensitivity means zones reach
 * farther out, lingering engages sooner, and a smaller jump in loudness counts as a shout.
 */
export function withSensitivity(cfg: ShowConfig, level: number): ShowConfig {
  const s = cfg.sensitivity;
  const step = Math.max(s.min, Math.min(s.max, level));
  if (step === 0) return cfg;
  const zoneFactor = 1 + step * s.zoneFactorPerStep;
  const lingerFactor = Math.max(0.1, 1 - step * s.lingerFactorPerStep);
  return {
    ...cfg,
    zones: { ...cfg.zones, nearM: cfg.zones.nearM * zoneFactor, midM: cfg.zones.midM * zoneFactor },
    director: { ...cfg.director, lingerS: cfg.director.lingerS * lingerFactor },
    audio: { ...cfg.audio, shoutRiseDb: Math.max(3, cfg.audio.shoutRiseDb - step * s.shoutDbPerStep) },
  };
}
