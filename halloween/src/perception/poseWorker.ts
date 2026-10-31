// Runs MediaPipe Pose Landmarker off the main thread, so model time (which
// grows with every extra person in view) never holds up rendering. The main
// thread posts one downscaled camera frame at a time and draws with the most
// recent result while the next one is computed.
//
// Network: a worker does not inherit the page's Content-Security-Policy. The
// show server sends this script with its own CSP header (see server/app.ts),
// which keeps MediaPipe's usage telemetry blocked here too.

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

export interface PoseWorkerOptions {
  modelFile: string;
  delegate: 'GPU' | 'CPU';
  numPoses: number;
  minPoseDetectionConfidence: number;
  minPosePresenceConfidence: number;
  minTrackingConfidence: number;
}

export type PoseWorkerRequest =
  | { type: 'load'; options: PoseWorkerOptions }
  | { type: 'detect'; id: number; timeMs: number; frame: ImageBitmap };

export type PoseWorkerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'failed'; error: string }
  // poses: per pose, 33 × [x, y, visibility] flattened, in camera coordinates.
  | { type: 'result'; id: number; poses: Float32Array[]; inferMs: number }
  | { type: 'error'; id: number; error: string };

let landmarker: PoseLandmarker | null = null;
let lastTs = 0;

const post = (msg: PoseWorkerResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

async function load(o: PoseWorkerOptions): Promise<void> {
  try {
    // `true` picks the ES-module build of the WASM loader, which works in a module worker.
    const fileset = await FilesetResolver.forVisionTasks('/models/wasm', true);
    const make = (delegate: 'GPU' | 'CPU') =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `/models/${o.modelFile}`, delegate },
        runningMode: 'VIDEO',
        numPoses: o.numPoses,
        minPoseDetectionConfidence: o.minPoseDetectionConfidence,
        minPosePresenceConfidence: o.minPosePresenceConfidence,
        minTrackingConfidence: o.minTrackingConfidence,
      });
    let delegate = o.delegate;
    try {
      landmarker = await make(delegate);
    } catch (err) {
      if (delegate !== 'GPU') throw err;
      console.warn('[pose worker] GPU delegate failed, using CPU', err);
      delegate = 'CPU';
      landmarker = await make(delegate);
    }
    // The first run compiles GPU shaders and can take seconds; do it now on a
    // blank frame instead of on the first visitor.
    const blank = await createImageBitmap(new ImageData(64, 64));
    landmarker.detectForVideo(blank, ++lastTs);
    blank.close();
    post({ type: 'ready', delegate });
  } catch (err) {
    post({ type: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
}

function detect(id: number, timeMs: number, frame: ImageBitmap): void {
  try {
    if (!landmarker) throw new Error('model not loaded');
    // MediaPipe requires strictly increasing timestamps.
    const ts = Math.max(Math.round(timeMs), lastTs + 1);
    lastTs = ts;
    const t0 = performance.now();
    const result = landmarker.detectForVideo(frame, ts);
    const inferMs = performance.now() - t0;
    const poses = result.landmarks.map((pts) => {
      const a = new Float32Array(pts.length * 3);
      pts.forEach((q, i) => {
        a[i * 3] = q.x;
        a[i * 3 + 1] = q.y;
        a[i * 3 + 2] = q.visibility ?? 0;
      });
      return a;
    });
    post({ type: 'result', id, poses, inferMs }, poses.map((p) => p.buffer));
  } catch (err) {
    post({ type: 'error', id, error: err instanceof Error ? err.message : String(err) });
  } finally {
    frame.close();
  }
}

self.onmessage = (e: MessageEvent<PoseWorkerRequest>) => {
  const m = e.data;
  if (m.type === 'load') void load(m.options);
  else detect(m.id, m.timeMs, m.frame);
};
