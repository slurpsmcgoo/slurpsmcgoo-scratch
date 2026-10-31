// MediaPipe Pose Landmarker, run in workers (poseWorker.ts). The WebAssembly
// runtime and model load from public/models/ (copied there by
// `npm run fetch-models`), so nothing comes from a CDN at runtime.
//
// `perception.poseWorkers` copies of the model can run, each in its own
// worker, with camera frames going to whichever is free. On a MacBook GPU one
// is best: the GPU runs one model at a time, so two workers measured the same
// throughput (~165 frames/s on an empty frame) with twice the delay per frame.
// More may help with the CPU delegate on a many-core machine. Frames that arrive while every worker is busy are dropped, never
// queued, so results are never stale and rendering never waits. A result that
// comes back after a newer one is dropped too. Results are converted to
// visitor-view Detections.

import { logicalSize, type ShowConfig } from '../config.ts';
import type { Detection, Landmark } from '../types.ts';
import type { PoseWorkerRequest, PoseWorkerResponse } from './poseWorker.ts';
import { areaRect, toVisitorX } from './geometry.ts';

/** Part of the raw camera frame (not visitor view), normalized 0..1. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Model timing, for the debug overlay. */
export interface PoseStats {
  delegate: 'GPU' | 'CPU' | null;
  workers: number; // workers ready
  inferMs: number; // model time per frame, smoothed
  fps: number;     // results per second, smoothed
}

interface Job {
  id: number;
  timeMs: number;
  crop: Crop;
  sentMs: number;
  onResult: (d: Detection[]) => void;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  job: Job | null;
}

/**
 * With cropToArea, the active area plus a margin, in raw camera coordinates:
 * the model never sees obstructions outside it, and people inside get more
 * pixels. Otherwise (or when the area covers nearly everything) the whole frame.
 */
export function inferenceCrop(cfg: ShowConfig, cameraAspect: number): Crop {
  const p = cfg.perception;
  const full = { x: 0, y: 0, w: 1, h: 1 };
  if (!p.cropToArea) return full;
  const size = logicalSize(cfg.output.orientation);
  const r = areaRect(p.activeArea, size.width / size.height, cameraAspect);
  const mx = r.w * p.cropMargin;
  const my = r.h * p.cropMargin;
  const x0 = Math.max(0, r.x - mx);
  const y0 = Math.max(0, r.y - my);
  const x1 = Math.min(1, r.x + r.w + mx);
  const y1 = Math.min(1, r.y + r.h + my);
  if (x1 - x0 > 0.95 && y1 - y0 > 0.95) return full;
  if (x1 <= x0 || y1 <= y0) return full;
  // The area is in visitor view; the raw frame is flipped unless the feed is already mirrored.
  const rawX0 = p.cameraFeedMirrored ? x0 : 1 - x1;
  return { x: rawX0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export class PoseModel {
  private slots: Slot[] = [];
  private nextId = 1;
  private lastResultMs = 0;
  private lastDeliveredTimeMs = -Infinity;
  failed = false;
  readonly stats: PoseStats = { delegate: null, workers: 0, inferMs: 0, fps: 0 };

  constructor(private cfg: ShowConfig) {}

  setConfig(cfg: ShowConfig): void {
    this.cfg = cfg;
  }

  get ready(): boolean {
    return this.slots.some((s) => s.ready);
  }

  load(): void {
    const p = this.cfg.perception;
    const n = Math.max(1, Math.min(4, Math.round(p.poseWorkers)));
    for (let i = 0; i < n; i++) {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./poseWorker.ts', import.meta.url), { type: 'module', name: `pose-${i + 1}` });
      } catch (err) {
        console.error(`[pose] could not start pose worker ${i + 1}: ${(err as Error).message}`);
        continue;
      }
      const slot: Slot = { worker, ready: false, job: null };
      worker.onmessage = (e: MessageEvent<PoseWorkerResponse>) => this.onMessage(slot, e.data);
      worker.onerror = (e) => this.dropSlot(slot, `pose worker crashed: ${e.message}`);
      this.slots.push(slot);
      this.post(slot, {
        type: 'load',
        options: {
          modelFile: p.modelFile,
          delegate: p.delegate,
          numPoses: p.numPoses,
          minPoseDetectionConfidence: p.minPoseDetectionConfidence,
          minPosePresenceConfidence: p.minPosePresenceConfidence,
          minTrackingConfidence: p.minTrackingConfidence,
        },
      });
    }
    if (this.slots.length === 0) this.fail('no pose worker could start');
  }

  /** A ready worker with nothing to do (jobs past the timeout are given up on). */
  private freeSlot(): Slot | null {
    const now = performance.now();
    for (const s of this.slots) {
      if (s.job && now - s.job.sentMs > this.cfg.perception.poseTimeoutMs) {
        console.warn('[pose] no result in time; dropping that frame');
        s.job = null;
      }
    }
    return this.slots.find((s) => s.ready && !s.job) ?? null;
  }

  /** True while every worker is busy. */
  get busy(): boolean {
    return this.freeSlot() === null;
  }

  /**
   * Starts detection on the current video frame. Returns false (and does
   * nothing) if no model is ready or every worker is still busy.
   */
  submit(video: HTMLVideoElement, timeMs: number, onResult: (d: Detection[]) => void): boolean {
    if (video.readyState < 2 || !video.videoWidth) return false;
    const slot = this.freeSlot();
    if (!slot) return false;
    const p = this.cfg.perception;
    const crop = this.crop(video.videoWidth / video.videoHeight);
    const sw = Math.max(1, Math.round(crop.w * video.videoWidth));
    const sh = Math.max(1, Math.round(crop.h * video.videoHeight));
    const scale = Math.min(1, p.inferenceWidth / sw);
    const job: Job = { id: this.nextId++, timeMs, crop, sentMs: performance.now(), onResult };
    slot.job = job;
    createImageBitmap(video, Math.round(crop.x * video.videoWidth), Math.round(crop.y * video.videoHeight), sw, sh, {
      resizeWidth: Math.max(1, Math.round(sw * scale)),
      resizeHeight: Math.max(1, Math.round(sh * scale)),
      resizeQuality: 'low',
    }).then(
      (frame) => {
        if (slot.job !== job) return frame.close();
        this.post(slot, { type: 'detect', id: job.id, timeMs, frame }, [frame]);
      },
      (err) => {
        if (slot.job === job) slot.job = null;
        console.warn('[pose] could not grab a camera frame', err);
      },
    );
    return true;
  }

  private crop(cameraAspect: number): Crop {
    return inferenceCrop(this.cfg, cameraAspect);
  }

  private onMessage(slot: Slot, m: PoseWorkerResponse): void {
    if (m.type === 'ready') {
      slot.ready = true;
      this.stats.delegate = m.delegate;
      this.stats.workers = this.slots.filter((s) => s.ready).length;
      console.info(`[pose] model ready (${m.delegate}), ${this.stats.workers} of ${this.slots.length} workers`);
    } else if (m.type === 'failed') {
      this.dropSlot(slot, `could not load the pose model. Run \`npm run fetch-models\`. ${m.error}`);
    } else {
      const job = slot.job;
      if (!job || job.id !== m.id) return; // timed out earlier
      slot.job = null;
      if (m.type === 'error') {
        console.error('[pose] detection failed', m.error);
        return;
      }
      // Two workers can finish out of order; never step back in time.
      if (job.timeMs <= this.lastDeliveredTimeMs) return;
      this.lastDeliveredTimeMs = job.timeMs;
      const now = performance.now();
      if (this.lastResultMs) this.stats.fps += (1000 / Math.max(1, now - this.lastResultMs) - this.stats.fps) * 0.1;
      this.lastResultMs = now;
      this.stats.inferMs += (m.inferMs - this.stats.inferMs) * 0.1;
      job.onResult(this.toDetections(m.poses, job.timeMs, job.crop));
    }
  }

  /** Takes a broken worker out of the pool; the model fails only when none are left. */
  private dropSlot(slot: Slot, reason: string): void {
    console.error(`[pose] ${reason}`);
    slot.worker.terminate();
    this.slots = this.slots.filter((s) => s !== slot);
    this.stats.workers = this.slots.filter((s) => s.ready).length;
    if (this.slots.length === 0) this.fail('no pose workers left; camera scenes will be skipped');
  }

  /** Model output (relative to the crop) → visitor-view Detections over the full camera frame. */
  private toDetections(poses: Float32Array[], timeMs: number, crop: Crop): Detection[] {
    const mirrored = this.cfg.perception.cameraFeedMirrored;
    return poses.map((a) => {
      const landmarks: Landmark[] = [];
      for (let i = 0; i < a.length; i += 3) {
        landmarks.push({ x: toVisitorX(crop.x + a[i]! * crop.w, mirrored), y: crop.y + a[i + 1]! * crop.h, visibility: a[i + 2]! });
      }
      const key = [0, 11, 12, 23, 24].map((i) => landmarks[i]?.visibility ?? 0);
      return { timeMs, landmarks, confidence: key.reduce((s, v) => s + v, 0) / key.length };
    });
  }

  private post(slot: Slot, m: PoseWorkerRequest, transfer: Transferable[] = []): void {
    slot.worker.postMessage(m, transfer);
  }

  private fail(reason: string): void {
    this.failed = true;
    console.error(`[pose] ${reason}`);
  }
}
