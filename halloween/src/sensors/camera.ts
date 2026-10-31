// USB webcam via getUserMedia. Reports each new frame (with its capture time,
// when the browser provides one) and its own health: 'stale' after a few
// seconds without frames, 'off' when permission is lost or no camera exists.
// Retries on a timer, so unplugging and replugging the camera recovers.

import type { ShowConfig } from '../config.ts';
import type { SensorStatus } from '../types.ts';

export class CameraSensor {
  readonly video: HTMLVideoElement;
  stream: MediaStream | null = null;
  private status: SensorStatus = 'off';
  private lastFrameMs = 0;
  private retryTimer: number | null = null;
  private starting = false;
  private onFrame: ((captureMs: number) => void) | null = null;

  constructor(private cfg: ShowConfig) {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
  }

  setConfig(cfg: ShowConfig): void {
    this.cfg = cfg;
  }

  get health(): SensorStatus {
    if (this.status === 'ok' && performance.now() - this.lastFrameMs > this.cfg.health.cameraStaleS * 1000) {
      this.status = 'stale';
      console.warn('[camera] no frames; marking stale and retrying');
      this.restartLater();
    }
    return this.status;
  }

  /** Calls `onFrame` for every new video frame. */
  async start(onFrame: (captureMs: number) => void): Promise<void> {
    this.onFrame = onFrame;
    if (this.starting) return;
    this.starting = true;
    const p = this.cfg.perception;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: p.cameraWidth }, height: { ideal: p.cameraHeight }, frameRate: { ideal: p.cameraFrameRate } },
        audio: false,
      });
      for (const t of this.stream.getVideoTracks()) t.addEventListener('ended', () => this.fail('camera disconnected'));
      this.video.srcObject = this.stream;
      await this.video.play();
      this.status = 'ok';
      this.lastFrameMs = performance.now();
      this.watchFrames();
    } catch (err) {
      this.fail(`camera unavailable: ${(err as Error).message}`);
    } finally {
      this.starting = false;
    }
  }

  private watchFrames(): void {
    const v = this.video;
    const stream = this.stream;
    if (typeof v.requestVideoFrameCallback === 'function') {
      const cb = (now: number, meta: VideoFrameCallbackMetadata) => {
        if (this.stream !== stream) return;
        this.lastFrameMs = performance.now();
        if (this.status === 'stale') this.status = 'ok';
        this.onFrame?.(meta.captureTime ?? meta.expectedDisplayTime ?? now);
        v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    } else {
      // Fallback: poll for new frames.
      let lastTime = -1;
      const poll = () => {
        if (this.stream !== stream) return;
        if (v.currentTime !== lastTime) {
          lastTime = v.currentTime;
          this.lastFrameMs = performance.now();
          this.onFrame?.(this.lastFrameMs);
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }
  }

  private fail(reason: string): void {
    console.warn(`[camera] ${reason}; retrying in ${this.cfg.health.cameraRetryS} s`);
    this.stop();
    this.status = 'off';
    this.restartLater();
  }

  private restartLater(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.stop();
      if (this.onFrame) void this.start(this.onFrame);
    }, this.cfg.health.cameraRetryS * 1000);
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
