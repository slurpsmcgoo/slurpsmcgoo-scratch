// Microphone input via the Web Audio API. Analyzes loudness at `analysisHz`
// (faster than the perception tick, so shouts are caught within ~100 ms) and
// the bass band for the beat tracker, and hands the latest level, any shouts
// and the beat clock to perception on each tick.
//
// With `music.inputDevice` set (say "BlackHole", a loopback device carrying
// the computer's own sound), the beat tracker listens to that input instead of
// the microphone; the microphone still hears shouts. If the device isn't
// there, the beat tracker falls back to the microphone and keeps looking.

import type { ShowConfig } from '../config.ts';
import type { AudioLevels, MusicState, SensorStatus } from '../types.ts';
import { NO_MUSIC } from '../world/frame.ts';
import { LevelTracker, pickInput, rmsDb, spectralFlux } from './audioAnalysis.ts';
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
  // The separate music input, when music.inputDevice names one that is present.
  private musicStream: MediaStream | null = null;
  private musicAnalyser: AnalyserNode | null = null;
  private musicBuf: Float32Array<ArrayBuffer> | null = null;
  private musicLabel = '';
  private musicWanted = '';
  private attaching = false;
  private onDeviceChange = () => void this.attachMusicInput();

  constructor(private cfg: ShowConfig) {
    this.tracker = new LevelTracker(cfg.audio);
    this.beat = new BeatTracker(cfg.music);
    this.latest = { levelDb: cfg.audio.floorDb, baselineDb: cfg.audio.floorDb };
  }

  setConfig(cfg: ShowConfig): void {
    this.cfg = cfg;
    this.tracker.setConfig(cfg.audio);
    this.beat.setConfig(cfg.music);
    if ((cfg.music.inputDevice ?? '') !== this.musicWanted && this.ctx) {
      this.detachMusicInput();
      void this.attachMusicInput();
    }
  }

  /** What the beat tracker is listening to, for the overlay. */
  get musicInput(): string {
    if (this.musicLabel) return this.musicLabel;
    const wanted = this.cfg.music.inputDevice ?? '';
    return wanted ? `microphone ("${wanted}" not found)` : 'microphone';
  }

  /**
   * Opens music.inputDevice as a second input for the beat tracker. Safe to
   * call again: it does nothing when that device is already open.
   */
  private async attachMusicInput(): Promise<void> {
    const wanted = this.cfg.music.inputDevice ?? '';
    if (!this.ctx || this.attaching || (this.musicStream && wanted === this.musicWanted)) return;
    this.musicWanted = wanted;
    if (!wanted) return;
    this.attaching = true;
    try {
      const device = pickInput(await navigator.mediaDevices.enumerateDevices(), wanted);
      if (!device) {
        console.warn(`[audio] no audio input named like "${wanted}"; the beat tracker uses the microphone`);
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: device.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      if (!this.ctx || (this.cfg.music.inputDevice ?? '') !== wanted) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = this.analyser?.fftSize ?? 1024;
      analyser.smoothingTimeConstant = 0;
      this.ctx.createMediaStreamSource(stream).connect(analyser);
      for (const t of stream.getAudioTracks()) {
        t.addEventListener('ended', () => {
          console.warn('[audio] music input disconnected; the beat tracker uses the microphone');
          this.detachMusicInput();
        });
      }
      this.musicStream = stream;
      this.musicAnalyser = analyser;
      this.musicBuf = new Float32Array(analyser.fftSize);
      this.musicLabel = device.label;
      this.prevFreq?.fill(-200);
      console.info(`[audio] beat tracker listening to ${device.label}`);
    } catch (err) {
      console.warn(`[audio] could not open music input "${wanted}": ${(err as Error).message}; the beat tracker uses the microphone`);
    } finally {
      this.attaching = false;
    }
  }

  private detachMusicInput(): void {
    this.musicStream?.getTracks().forEach((t) => t.stop());
    this.musicStream = null;
    this.musicAnalyser = null;
    this.musicBuf = null;
    this.musicLabel = '';
    this.prevFreq?.fill(-200);
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
      navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
      void this.attachMusicInput();
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
      // The separate music input when there is one, else the microphone.
      const source = this.musicAnalyser ?? this.analyser;
      let levelDb = u.levelDb;
      if (this.musicAnalyser && this.musicBuf) {
        this.musicAnalyser.getFloatTimeDomainData(this.musicBuf);
        levelDb = rmsDb(this.musicBuf, this.cfg.audio.floorDb);
      }
      source.getFloatFrequencyData(this.freq);
      const binHz = this.ctx.sampleRate / source.fftSize;
      const flux = spectralFlux(this.prevFreq, this.freq, binHz, m.fluxMaxHz, m.fluxBassHz, m.fluxFloorDb);
      const lowFlux = spectralFlux(this.prevFreq, this.freq, binHz, m.fluxLowMaxHz, 0, m.fluxFloorDb);
      [this.prevFreq, this.freq] = [this.freq, this.prevFreq];
      this.beat.update(now, flux, lowFlux, levelDb);
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
    navigator.mediaDevices?.removeEventListener('devicechange', this.onDeviceChange);
    this.detachMusicInput();
    this.musicWanted = '';
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
