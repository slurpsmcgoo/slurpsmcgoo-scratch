// Copies MediaPipe's WebAssembly runtime out of node_modules and downloads the
// pose model into public/models/, so the show never loads anything from a CDN
// at runtime. Run once after `npm install`, with internet: `npm run fetch-models`.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const modelsDir = path.join(root, 'public', 'models');
const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = path.join(modelsDir, 'wasm');

const MODELS: Record<string, string> = {
  'pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
};

const wanted = process.argv.includes('--full') ? ['pose_landmarker_lite.task', 'pose_landmarker_full.task'] : ['pose_landmarker_lite.task'];

await fsp.mkdir(wasmDst, { recursive: true });
for (const f of await fsp.readdir(wasmSrc)) await fsp.copyFile(path.join(wasmSrc, f), path.join(wasmDst, f));
console.log(`copied MediaPipe WASM runtime to ${path.relative(root, wasmDst)}/`);

for (const name of wanted) {
  const dst = path.join(modelsDir, name);
  if (fs.existsSync(dst) && fs.statSync(dst).size > 1_000_000) {
    console.log(`${name} already present`);
    continue;
  }
  console.log(`downloading ${name} ...`);
  const res = await fetch(MODELS[name]!);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dst, buf);
  console.log(`saved ${path.relative(root, dst)} (${(buf.length / 1e6).toFixed(1)} MB)`);
}
