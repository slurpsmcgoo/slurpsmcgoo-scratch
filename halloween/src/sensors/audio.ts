// Microphone input via the Web Audio API. Analyzes loudness at `analysisHz`
// (faster than the perception tick, so shouts are caught within ~100 ms) and
// the bass band for the beat tracker, and hands the latest level, any shouts
// and the beat clock to perception on each tick.

import type { ShowConfig } from '../config.ts';
import type { AudioLevels, MusicState, SensorStatus } from '../types.ts';
import { NO_MUSIC } from '../world/frame.ts';
import { LevelTracker, rmsDb, spectralFlux } from './audioAnalysis.ts';
import { BeatTracker } from './beatTracker.ts';

export class AudioSensor {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private buf: Float32Array<ArrayBuffer> | null = null;
  private freq: Float32Array<ArrayBuffer> | null = null;
  private prevFreq: Float32Array<ArrayBuffer> | null = null;
  private onsets: number[] = [];
  private beat: BeatTracker;
  private timer: number | null = null;
  private tracker: LevelTracker;
  private latest: AudioLevels;
  private shouts: number[] = [];
  private lastSampleMs = 0;
  private status: SensorStatus = 'off';
  private retryTimer: number | null = null;
  private starting = false;

  constructor(private cfg: ShowConfig) {
    this.tracker = new LevelTracker(cfg.audio);
    this.beat = new BeatTracker(cfg.music);
    this.latest = { levelDb: cfg.audio.floorDb, baselineDb: cfg.audio.floorDb };
  }

  setConfig(cfg: ShowConfig): void {
    this.cfg = cfg;
    this.tracker.setConfig(cfg.audio);
    this.beat.setConfig(cfg.music);
  }

  async start(): Promise<void> {
    if (!this.cfg.audio.enabled || this.starting) return;
    this.starting = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      // No smoothing between spectra: it would smear kick drums into each other.
      this.analyser.smoothingTimeConstant = 0;
      this.buf = new Float32Array(this.analyser.fftSize);
      this.freq = new Float32Array(this.analyser.frequencyBinCount);
      this.prevFreq = new Float32Array(this.analyser.frequencyBinCount).fill(-200);
      src.connect(this.analyser);
      for (const t of this.stream.getAudioTracks()) t.addEventListener('ended', () => this.fail('microphone disconnected'));
      this.lastSampleMs = performance.now();
      this.status = 'ok';
      this.timer = window.setInterval(() => this.sample(), 1000 / this.cfg.audio.analysisHz);
      void this.resume();
    } catch (err) {
      this.fail(`microphone unavailable: ${(err as Error).message}`);
    } finally {
      this.starting = false;
    }
  }

  /** Chrome keeps an AudioContext suspended until a user gesture (or the kiosk autoplay flag). */
  async resume(): Promise<void> {
    if (this.ctx?.state === 'suspended') await this.ctx.resume().catch(() => {});
  }

  private sample(): void {
    if (!this.analyser || !this.buf || !this.ctx) return;
    if (this.ctx.state !== 'running') return; // counts toward staleness
    this.analyser.getFloatTimeDomainData(this.buf);
    const now = performance.now();
    const u = this.tracker.update(now, rmsDb(this.buf, this.cfg.audio.floorDb));
    this.latest = { levelDb: u.levelDb, baselineDb: u.baselineDb };
    if (u.shoutDb !== null) this.shouts.push(u.shoutDb);
    if (this.freq && this.prevFreq && this.cfg.music.enabled) {
      const m = this.cfg.music;
      this.analyser.getFloatFrequencyData(this.freq);
      const binHz = this.ctx.sampleRate / this.analyser.fftSize;
      const flux = spectralFlux(this.prevFreq, this.freq, binHz, m.fluxMaxHz, m.fluxBassHz, m.fluxFloorDb);
      const lowFlux = spectralFlux(this.prevFreq, this.freq, binHz, m.fluxLowMaxHz, 0, m.fluxFloorDb);
      [this.prevFreq, this.freq] = [this.freq, this.prevFreq];
      this.beat.update(now, flux, lowFlux, u.levelDb);
      this.onsets.push(Math.round(flux * 100) / 100);
    }
    this.lastSampleMs = now;
  }

  private fail(reason: string): void {
    console.warn(`[audio] ${reason}; retrying in ${this.cfg.health.audioRetryS} s`);
    this.stop();
    this.status = 'off';
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.start();
    }, this.cfg.health.audioRetryS * 1000);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
  }

  /** The beat tracker, for the debug overlay's beat graph. */
  get beatTracker(): BeatTracker {
    return this.beat;
  }

  /** Latest levels, shouts and onset samples since the last call, and the beat clock now. */
  take(): { audio: AudioLevels; shouts: number[]; onsets: number[]; music: MusicState; status: SensorStatus } {
    const shouts = this.shouts;
    this.shouts = [];
    const onsets = this.onsets;
    this.onsets = [];
    if (this.status === 'ok' && performance.now() - this.lastSampleMs > this.cfg.health.audioStaleS * 1000) {
      this.status = 'stale';
      this.scheduleRetry();
    } else if (this.status === 'stale' && performance.now() - this.lastSampleMs < 500) {
      this.status = 'ok';
    }
    const status = this.cfg.audio.enabled ? this.status : 'off';
    const music = status === 'ok' && this.cfg.music.enabled ? this.beat.state(performance.now()) : NO_MUSIC;
    return { audio: this.latest, shouts, onsets, music, status };
  }
}
