// Turns the microphone level into lighting cues for the ambient layer: a
// smoothed "liveliness" (talking, laughing, trick-or-treat chatter) and
// discrete flashes on sudden loud sounds (a clap, a squeal, a shout). Pure
// logic with no canvas, so it is unit-tested.

import type { AudioLevels } from '../types.ts';

export interface SoundMoodConfig {
  talkRiseDb: number;   // dB above the room's baseline where liveliness starts
  rangeDb: number;      // further dB to reach full liveliness
  attackS: number;
  releaseS: number;
  flashRiseDb: number;  // a jump this far above baseline fires a flash
  flashRearmDb: number; // the level must fall this far below the trigger before the next flash
  flashMinGapS: number; // never flash more often than this
}

export class SoundMood {
  /** 0..1, follows talking and laughter with a quick attack and slow release. */
  liveliness = 0;
  private armed = true;
  private sinceFlashS = Infinity;

  constructor(private cfg: SoundMoodConfig) {}

  setConfig(cfg: SoundMoodConfig): void {
    this.cfg = cfg;
  }

  /** Advances by dt seconds. Returns true when a flash should fire this frame. */
  update(dtS: number, audio: AudioLevels, audioOk: boolean): boolean {
    const c = this.cfg;
    this.sinceFlashS += dtS;
    const rise = audioOk ? audio.levelDb - audio.baselineDb : -Infinity;
    const target = Math.max(0, Math.min(1, (rise - c.talkRiseDb) / Math.max(1, c.rangeDb)));
    const tau = target > this.liveliness ? c.attackS : c.releaseS;
    this.liveliness += (target - this.liveliness) * (1 - Math.exp(-dtS / Math.max(1e-3, tau)));

    if (rise < c.flashRiseDb - c.flashRearmDb) this.armed = true;
    if (this.armed && rise >= c.flashRiseDb && this.sinceFlashS >= c.flashMinGapS) {
      this.armed = false;
      this.sinceFlashS = 0;
      return true;
    }
    return false;
  }
}
