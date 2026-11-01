# kubb_game — 3D kubb in the browser

Physics-based kubb with teams and rotating throwers, computer players, practice, online play peer to peer, an optional beer mode, and experimental WebXR. Runs in a browser on laptops and desktops; iPads work through touch. Settings (where you play) are presets, each with its own physics: a summer park, the Moon and the ocean floor.

Design: [docs/architecture.md](docs/architecture.md).

## Commands

Run from `kubb_game/`.

| | |
|---|---|
| `npm run dev` | Dev server at http://localhost:5174. `?net=local` makes online play use a BroadcastChannel between tabs of one browser (no internet). `?debug=1` shows FPS and sim state. |
| `npm run typecheck` | `tsc` over src, tests and configs. |
| `npm test` | Vitest: rules, physics, determinism, throw model, bots, whole bot games (park and moon), host/client sync (including late join and disconnect mid-throw), architecture rules. About 10 s. |
| `npm run build` | Production bundle in `dist/` (relative paths, for GitHub Pages). |
| `npm run preview` | Serves `dist/`. |

Pushes to `main` that touch `kubb_game/` deploy to GitHub Pages via `.github/workflows/kubb-pages.yml`; CI runs typecheck, tests and build in `.github/workflows/ci.yml`.

## Layout

```
config/kubb.json   every tunable: pitch, pieces, rules switches, physics, throw input, bots, camera, audio, quality, scenes (settings) with physics overrides
src/types.ts       the contract between modules; GameState travels over the network as JSON
src/config.ts      typed config, sceneDef(), physicsFor(setting)
src/sim/           rules.ts (pure reducer), physics.ts (ThrowSim), pitch, setup, math, hash, rng  — no three, no DOM
src/throw/         model.ts (ThrowIntent, ballistic solve with or without water drag, arc), flick.ts (gesture), dispersion.ts (aim circle: flick → where in it)
src/bot/           computer players
src/game/          session.ts (state + live ThrowSim + action queue), controller.ts (who acts; bots; network port), bac.ts (beer-mode BAC model and effects)
src/net/           protocol, transport (PeerJS, BroadcastChannel, memory), room (host/client)
src/input/         desktop.ts (mouse, trackpad, touch), xr.ts (WebXR, untested on hardware)
src/render/        stage, environment (park, moon), ocean, impacts (lasting lunar dents), textures (procedural), pieces, cans, avatars, camera, view, dust
src/audio/         synthesised sound
src/ui/            menu, hud, settings, dom helpers, styles.css
src/debug/         scenarios for browser checks
src/app.ts         wires everything; src/main.ts boots it
tests/             vitest
```

## Rules

- **The sim is deterministic.** Everything under `src/sim/` imports only `types.ts`, `config.ts`, other sim files and Rapier, and never uses `Math.random`, clocks, the DOM, `**` or transcendental `Math` functions (`sin`, `cos`, `pow`, `hypot`, …). Peers exchange only throw intents and must get bit-identical results. `tests/architecture.test.ts` enforces this.
- **A throw is a pure function of (state, intent).** `ThrowSim` builds a fresh world each throw. Don't keep physics state between throws.
- **Throw intents are rounded** (`quantize` in `throw/model.ts`) before anyone simulates them. Build every throw through `makeIntent`.
- **Settings that change physics put it in their scene's `physics` block**, read through `physicsFor(state.setting)`. The setting is part of `GameState` so every peer simulates the same world.
- **Rendering never changes game state.** `render/` reads the controller; the architecture test fails if it calls the reducers.
- **Every tunable number lives in `config/kubb.json`.**
- **Beer mode lives in the state** (`beer`, `clock`, `drinks`), so every peer computes the same BAC from the game clock. Its effects on a throw are applied on the thrower's side before the intent is built (`throw/dispersion.ts`), never in the sim.
- **No brand names or logos.** Beer cans use colour schemes only, with generic words.
- **No asset files.** Meshes, textures and sounds are generated in code. Keep it that way unless the user agrees otherwise (licences, size, agent-editability).
- **Only `render/`, `input/`, `ui/` and `app.ts` import three.js.**
- **Ask before adding a dependency** beyond three, Rapier (deterministic compat), PeerJS, TypeScript, Vite, Vitest and their types. Pin exact versions.
- **Unit-test** rules, physics behaviour, throw maths and net sync; whole bot games are the end-to-end test.

## Verifying in a browser

Start the `kubb-dev` preview (`.claude/launch.json`). When the browser pane is hidden, Chrome throttles `requestAnimationFrame`, so the game barely advances. Drive it from the console instead: `__kubb.app.step(1/60)` advances and renders one frame.

- `__kubb.scenario('raise' | 'penalty' | 'kingShot' | 'advantage' | 'kubbThrow', 'park' | 'moon' | 'ocean')` jumps to a situation where you (Red) act next.
- `__kubb.app.ctl` is the running game's controller; `ctl.state` the state, `ctl.session.sim` the throw in flight.
- `__kubb.CFG` is the live config object; changing a number takes effect on the next throw (handy for tuning).
- Modules can be imported in the console in dev: `await import('/src/bot/bot.ts')`.
- Online play without internet: two tabs at `?net=local`, one hosts, the other opens the invite link.
- A screenshot taken right after a big change can show the previous frame; step once more and retake.
