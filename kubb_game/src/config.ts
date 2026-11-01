// Typed access to config/kubb.json, plus constants derived from it.

import raw from '../config/kubb.json';

export const CFG = raw;
export type Config = typeof raw;
export type QualityName = keyof Config['quality'];
export type PhysicsParams = Config['physics'];

/** A setting (where the game is played): its look, and how it changes the physics. */
export interface SceneDef {
  label: string;
  surface: 'grass' | 'regolith' | 'sand';
  sunElevationDeg: number;
  sunAzimuthDeg: number;
  exposure: number;
  sunIntensity: number;
  physics: Partial<PhysicsParams>;
  // Earth-like settings
  turbidity?: number;
  rayleigh?: number;
  mieCoefficient?: number;
  mieDirectionalG?: number;
  fogColor?: string;
  fogNear?: number;
  fogFar?: number;
  grass?: string[];
  stripes?: boolean;
  treeColor?: string[];
  trees?: boolean;
  // Airless settings
  ground?: string[];
  earthAzimuthDeg?: number;
  earthElevationDeg?: number;
  stars?: number;
  craters?: number;
  // Underwater settings
  waterColor?: string;
  fogDensity?: number;
  kelp?: number;
  fish?: number;
}

export const SCENES = raw.scenes as unknown as Record<string, SceneDef>;
export const SCENE_NAMES = Object.keys(SCENES);

export function sceneDef(name: string): SceneDef {
  return SCENES[name] ?? SCENES.park!;
}

/** Physics for a setting: the base numbers with that setting's overrides. */
export function physicsFor(setting: string): PhysicsParams {
  return { ...CFG.physics, ...sceneDef(setting).physics };
}

export const DEG = Math.PI / 180;

/**
 * A piece counts as standing while its up axis is within 40° of vertical. Stored as a
 * literal cosine so every browser compares against exactly the same number.
 */
export const STANDING_COS = CFG.rules.standingCos;
