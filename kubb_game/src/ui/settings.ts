// Player settings, remembered in this browser (when storage is allowed).

import type { QualityName } from '../config.ts';

export interface Settings {
  name: string;
  quality: 'auto' | QualityName;
  mode: 'flick' | 'meter';
  /** How spin is chosen: by how far you pull back before flicking, or with Q/E. */
  spinControl: 'pull' | 'keys';
  preview: boolean;
  kubbPaint: 'wood' | 'sets' | 'twoTone';
  /** Last choice for beer mode in game setup. */
  beer: boolean;
  volume: number;
  setting: string;
}

const KEY = 'kubb.settings.v1';

export function defaultQuality(): QualityName {
  const touch = matchMedia('(pointer: coarse)').matches;
  return touch ? 'low' : 'medium';
}

export function loadSettings(): Settings {
  const base: Settings = { name: '', quality: 'auto', mode: 'flick', spinControl: 'pull', preview: true, kubbPaint: 'wood', beer: false, volume: 0.8, setting: 'park' };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...base, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // storage blocked: use defaults
  }
  return base;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage blocked: settings last this visit only
  }
}

export function resolveQuality(s: Settings): QualityName {
  return s.quality === 'auto' ? defaultQuality() : s.quality;
}
