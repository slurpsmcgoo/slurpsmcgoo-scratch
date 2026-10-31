// The real sensors: camera + pose model + microphone, producing one
// PerceptionFrame per tick. Ticks follow pose results: camera frames are
// throttled to the perception rate (or every frame for Skeleton Mirror) and
// handed to the pose worker one at a time. If the camera or model is down, a
// timer keeps ticks coming so audio and health still flow.

import type { ShowConfig } from '../config.ts';
import type { Detection, SensorStatus } from '../types.ts';
import type { PerceptionFrame, PerceptionSource } from '../world/frame.ts';
import { PoseModel, type PoseStats } from '../perception/pose.ts';
import { AudioSensor } from './audio.ts';
import type { BeatTracker } from './beatTracker.ts';
import { CameraSensor } from './camera.ts';

export class LiveSource implements PerceptionSource {
  readonly kind = 'live' as const;
  private camera: CameraSensor;
  private audio: AudioSensor;
  private pose: PoseModel;
  private onFrameCb: ((f: PerceptionFrame) => void) | null = null;
  private fullRate = false;
  private lastTickMs = 0;
  private fallbackTimer: number | null = null;
  private started = false;
  private running = false;

  constructor(private cfg: ShowConfig) {
    this.camera = new CameraSensor(cfg);
    this.audio = new AudioSensor(cfg);
    this.pose = new PoseModel(cfg);
  }

  get video(): HTMLVideoElement {
    return this.camera.video;
  }

  get videoStream(): MediaStream | null {
    return this.camera.stream;
  }

  setConfig(cfg: ShowConfig): void {
    this.cfg = cfg;
    this.camera.setConfig(cfg);
    this.audio.setConfig(cfg);
    this.pose.setConfig(cfg);
  }

  setFullRate(on: boolean): void {
    this.fullRate = on;
  }

  resumeAudio(): void {
    void this.audio.resume();
  }

  start(onFrame: (f: PerceptionFrame) => void): void {
    this.onFrameCb = onFrame;
    this.running = true;
    if (!this.started) {
      this.started = true;
      this.pose.load();
      void this.camera.start((captureMs) => this.onCameraFrame(captureMs));
      void this.audio.start();
    }
    // Keeps ticks flowing (audio, health) when the camera or model produces
    // nothing. Not while camera frames are flowing to the model: an empty tick
    // between two slow frames (a webcam in the dark can drop to 7 fps) would
    // look like everyone vanished and stop new people from being confirmed.
    this.fallbackTimer = window.setInterval(() => {
      if (performance.now() - this.lastTickMs <= 2000 / this.cfg.perception.tickHz) return;
      if (this.camera.health === 'ok' && this.pose.ready) return;
      this.tick(null);
    }, 1000 / this.cfg.perception.tickHz);
  }

  stop(): void {
    // Sensors stay open so switching back from the simulator is instant.
    this.running = false;
    if (this.fallbackTimer !== null) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  get beatTracker(): BeatTracker {
    return this.audio.beatTracker;
  }

  get poseStats(): PoseStats {
    return this.pose.stats;
  }

  private onCameraFrame(captureMs: number): void {
    if (!this.running) return;
    const now = performance.now();
    const interval = this.fullRate ? 0 : 1000 / this.cfg.perception.tickHz;
    if (now - this.lastTickMs < interval * 0.9) return;
    if (!this.pose.ready || this.camera.health !== 'ok') return this.tick(null);
    // The pose worker takes one frame at a time; frames that arrive while it
    // is busy are skipped. The tick is emitted when the result comes back.
    const submitted = this.pose.submit(this.camera.video, now, (detections) => {
      if (this.running) this.tick(detections, captureMs);
    });
    if (submitted) this.lastTickMs = now;
  }

  /** Emits one frame. `detections` is null when there is no pose result to report. */
  private tick(detections: Detection[] | null, captureMs?: number): void {
    const now = performance.now();
    this.lastTickMs = now;
    let cameraStatus: SensorStatus = this.camera.health;
    if (this.pose.failed) cameraStatus = 'off'; // no model means no presence detection
    else if (!this.pose.ready && cameraStatus === 'ok') cameraStatus = 'stale'; // model still loading
    const a = this.audio.take();
    this.onFrameCb?.({
      timeMs: now,
      detections: cameraStatus === 'ok' ? detections ?? [] : [],
      audio: a.audio,
      shouts: a.shouts,
      music: a.music,
      onsets: a.onsets,
      cameraAspect: this.camera.video.videoWidth && this.camera.video.videoHeight ? this.camera.video.videoWidth / this.camera.video.videoHeight : undefined,
      health: {
        camera: cameraStatus,
        audio: a.status,
        source: 'live',
        perceptionLatencyMs: captureMs === undefined ? 0 : now - captureMs,
      },
    });
  }
}
