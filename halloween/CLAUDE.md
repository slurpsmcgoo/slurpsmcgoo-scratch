# halloween — rear-projected window show

A browser app that rear-projects reactive scenes onto a sheet in a front window. A webcam and microphone (or the simulator, or a replayed log) feed one shared `AudienceState`; a director state machine decides when to notice, engage, scare and cool down; scenes only decide how each state looks.

Design: [docs/architecture.md](docs/architecture.md), a snapshot of the live doc at https://claude.ai/artifact/MSDCeL7aJbTvWXMWDZMnp1 (the live doc wins if they differ).

## Commands

Run from `halloween/`.

| | |
|---|---|
| `npm run dev` | Dev server with the show server built in, at http://localhost:5173. Add `?source=sim` for the simulator, `&overlay=1` for the debug overlay. |
| `npm run typecheck` | `tsc` over everything, plus a stricter pass over `server/` and `scripts/` (Node runs those files directly). |
| `npm test` | Vitest: unit, end-to-end encounter, server, architecture-rule and 6-hour soak tests. About 2 s. |
| `npm run build` | Production bundle in `dist/`. |
| `npm run show` | Show server on port 8787 serving `dist/`. `scripts/start-show.sh` builds, runs it, and opens Chrome in kiosk mode. |
| `npm run fetch-models` | Copies MediaPipe's WASM runtime and downloads the pose model into `public/models/` (gitignored). Needed once, online. |

## Layout

```
config/show.json      every tunable number; pushed live to the page when it changes
src/types.ts          the contract between modules; change deliberately
src/sensors/          camera, audio (+ pure audioAnalysis: levels, shouts, spectral flux; beatTracker: tempo + phase by autocorrelation), sim (simulator, scenarios, replay, disco track), live (camera+pose+mic)
src/perception/       pose (main-thread side) + poseWorker (MediaPipe, in a Web Worker), tracker, oneEuro, geometry
src/world/            audience (builds AudienceState), frame (PerceptionFrame = one tick = one log line),
                      motionPredictor (moves poses forward to each drawn frame)
src/director/         director (encounter state machine), playlist (show layer)
src/scenes/           one file per scene + index.ts registry; parts/ holds drawing shared by scenes (creatures.ts, disco.ts)
src/render/           helpers (the only render code scenes may import), sceneRunner, output (WebGL warp), homography, calibrate,
                      ambient (sound-reactive lights over every scene) + soundMood (its pure trigger logic)
src/control/          remoteClient (WebSocket to the server)
src/debug/            overlay, recorder
server/               app.ts (shared by dev and show), index.ts (show mode)
remote/index.html     phone remote
tests/                vitest
```

## Rules

- **Scenes import only `types.ts`, `render/helpers.ts` and other code under `src/scenes/`** (such as `parts/`). Never sensors, perception or the director. `tests/rules.test.ts` enforces this, including for `parts/`.
- **Every tunable number lives in `config/show.json`.** Scenes read theirs with `num/bool/str(cfg, 'key')`; the rules test fails if a key is missing.
- **Scenes keep no timers.** Time advances only through `update(dt)`, so sim and replay stay deterministic. No `setTimeout`, `performance.now`, `Date.now` in scenes.
- **Scenes lay out from `sc.width` / `sc.height`,** never fixed pixel positions: the canvas is 1920x1080, or 1080x1920 in portrait (`output.orientation`), and scenes are re-initialized when it changes. `tests/sceneSmoke.test.ts` runs every scene both ways.
- **Every frame starts pure black.** Any pixel not deliberately lit is `#000000`.
- **Coordinates are visitor view:** x = 0 is the window's left edge as a visitor sees it. Perception flips camera x; nothing downstream flips again.
- **People reach scenes relative to the camera's active area** (`perception.activeArea`, key A): `Person.x` and landmarks are 0..1 across the area, which always has the window's proportions, so scenes map them straight to `sc.width`/`sc.height`. Distances and zones are computed from the full camera picture first. `AudienceState.cameraArea` says where the area is, for drawing on the camera image (overlay, helper).
- **Never write camera images or video to disk** unless `recorder.recordVideo` is true (development only). Logs are numbers only.
- **The page talks only to its own server.** `index.html` sets a Content-Security-Policy with `connect-src 'self'`; it also blocks MediaPipe's built-in usage telemetry. Don't loosen it. Workers don't inherit the page's CSP: the server sends `WORKER_CSP` with the pose worker script (`server/app.ts`), so keep that header if the worker is renamed.
- **Pose runs off the main thread.** `PoseModel` sends one downscaled frame at a time to `poseWorker.ts` and drops frames while it is busy; never call the model synchronously from the render loop. Extra workers don't help on a GPU (it runs one model at a time; measured), so `poseWorkers` defaults to 1. In dev, `vite.config.ts` serves MediaPipe's WASM loader from `public/` for the worker's `import()`.
- **Original art drawn in code only.** No copyrighted characters.
- **Ask before adding a dependency** beyond TypeScript, Vite, Vitest, `@mediapipe/tasks-vision`, `ws` and their `@types`. Pin exact versions.
- **`server/` and `scripts/` run under Node's type stripping:** no enums, namespaces or constructor parameter properties there.
- **Unit-test** the tracker, One Euro filter, geometry, director and anything else with logic that doesn't need a canvas.

## Adding a scene

1. Write `src/scenes/<name>.ts` exporting a factory that returns a `Scene`.
2. Register it in `src/scenes/index.ts`.
3. Add its section (including `scareDurationS`) under `scenes` in `show.json` and its id to `show.playlist`.
4. Check it in the simulator: `npm run dev`, open `?source=sim&overlay=1`, drag a person toward the window, press `Enter` for a scare.

## Verifying in a browser

`window.__show` exposes the director, playlist, simulator, runner and `applyCommand` for console checks. When the page is in a hidden tab, Chrome throttles `requestAnimationFrame` and timers, so frame-rate and timing numbers from it are meaningless; behavior over time is covered by `tests/encounter.test.ts` and `tests/soak.test.ts` on a simulated clock.
