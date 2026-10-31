<!-- Snapshot of the Claude Docs document "Halloween Window Projection — Architecture"
     (https://claude.ai/artifact/MSDCeL7aJbTvWXMWDZMnp1), taken 2026-10-31.
     The live doc is the source of truth; this copy is for agents without the docs connector. -->

# Halloween Window Projection — Architecture

Oct 31, 2026 · @Jack

## Summary and goals

A browser app, run full-screen on a laptop, rear-projects animated scenes onto a sheet hung in a front window. A webcam and microphone face the visitors, and every scene reacts to one shared description of who is outside. New effects are added as self-contained scenes, without touching sensing, behavior or output code.

**Design principles**

- **Scenes never touch sensors.** They read a normalized `AudienceState` object. That object can come from the real camera and microphone, a simulator, or a recorded log, and scenes cannot tell the difference.
- **Simulation first.** Every behavior must be testable at a desk with a mouse. Real trick-or-treaters show up one night a year, so the simulator is the main test tool, not an extra.
- **Pure black by default.** Any pixel not deliberately part of an effect is `#000000`. On a projector, black means no light, so figures appear to float instead of sitting in a glowing gray rectangle.
- **One place for behavior.** A director state machine decides when to notice, engage, scare and cool down. Scenes decide only how each state looks.
- **Degrade, never crash.** If a sensor fails, the show falls back to scenes that don't need it. Errors never appear on the projection.
- **Every tunable number lives in one config file**, never inside scene code.

**Goals**

- Five starter scenes from one codebase (see Scene catalog).
- Switch scenes from the laptop keyboard or a phone on home Wi-Fi.
- Run unattended for 4 or more hours.
- Work fully offline once installed.

**Non-goals:** multiple projectors, projection mapping onto 3D objects, cloud services, and storing video of visitors.

## Physical setup

The projector sits indoors behind a sheet in a front window, and the camera looks out at the front walk. These assumptions drive the output transform and the sensing design.

- **Projector:** behind the sheet, so the image must be mirrored left-to-right. Use the projector's "rear" mode or the software mirror flag. Throw distance is about image width × throw ratio: a 1.2 m wide window at a throw ratio of 1.5 needs about 1.8 m.
- **Sheet:** dense, diffusing material (a doubled bedsheet, frosted shower curtain or rear-projection fabric). Thin fabric shows a bright "hotspot" where viewers see the lens through it.
- **Room behind the sheet:** dark. Any lamp there lights the sheet from behind and turns black to gray.
- **Camera:** a USB webcam facing out at the walkway. Best is an adjacent window, or a corner of the same window between sheet and glass. Press the lens flat to the glass inside a black hood (foam or a cardboard tube). Without the hood, the glass reflects the glowing sheet into the camera and the system sees its own animation again.
- **Lighting:** porch light aimed down at the walkway, not at the window. The camera needs light on visitors; the sheet needs darkness. More light also shortens camera exposure, which reduces motion blur and improves pose detection.
- **Microphone:** a USB mic near the door or just outside. A built-in laptop mic behind glass mostly hears the room.
- **Optional:** a speaker by the door for scare sounds.

**Coordinate convention (a common source of bugs):** all positions in `AudienceState` use the *visitor's* view, with x = 0 at the left edge of the window as a visitor sees it. The camera looks the opposite direction, so perception flips camera x (`x = 1 - cameraX`). Whether the browser's camera feed is already mirrored is tested once in Phase 4, not assumed.

## System overview

Data flows one way: sensors, then perception, then a shared audience state, then the director and the active scene, then the output transform. The audience state is the seam that makes simulation and replay possible.

*[diagram: system pipeline · sensors to projector (see the live doc)]*

Scenes read the audience state directly (the arrow down the left) and take their current state from the director. Nothing after perception knows whether visitors are real, simulated or replayed. The config file feeds every module, and the debug overlay shows audience and director state live.

## Modules

Each module has one job and talks to the next through the types in `src/types.ts`. Sensing runs at 10–15 Hz; rendering runs at the display rate (usually 60 Hz), and the two loops are decoupled.

### Sensors

- **Camera** (`sensors/camera.ts`): `getUserMedia` (the browser's camera API) at 640×360 or 1280×720. Hands frames to perception at 10–15 Hz, independent of the render loop.
- **Audio** (`sensors/audio.ts`): Web Audio API `AnalyserNode`. Outputs loudness in dB, a slowly adapting baseline, and a `shout` event when loudness jumps a configurable amount above baseline within about 100 ms. The adapting baseline keeps a noisy street from triggering constantly.
- **Simulator** (`sensors/sim.ts`): the mouse and keyboard create fake people. Click adds a person, drag moves them, the scroll wheel changes distance, and a key fires a shout. Also plays scripted scenarios (a family of four approaches, lingers 20 s, leaves) and replays recorded logs. The simulator emits raw detections, so the tracker and director get exercised too.

### Perception

- **Pose model** (`perception/pose.ts`): MediaPipe Pose Landmarker, Google's on-device model that finds up to N people and 33 body points each. One model supplies presence, position, size and full skeleton, so all scenes share it. Start with the "lite" model and `numPoses = 4`.
- **Tracker** (`perception/tracker.ts`): matches detections frame to frame by nearest hip-center position to keep stable IDs. Hysteresis prevents flicker: a person must be seen in 3 consecutive frames to count, and missing for about 1 s to be removed.
- **Smoothing** (`perception/oneEuro.ts`): a One Euro filter on every point. It's an adaptive low-pass filter that smooths heavily when a point is still and lightly when it moves fast, so it removes jitter without adding visible lag.
- **Geometry** (`perception/geometry.ts`): flips camera x into visitor-view x. Estimates distance from where the feet (ankle points) appear vertically in the image, using camera height and tilt. Falls back to shoulder width when feet are hidden.
   - Why feet first: size-based distance confuses children and adults, since a child 2 m away looks like an adult much farther off. Foot position doesn't depend on body size.
   - Calibration: tape marks on the walk at two known distances (for example 2 m and 5 m).
- **Zones:** `far`, `mid` and `near`, set by distance thresholds in config.

### Audience state

`world/audience.ts` builds one `AudienceState` per perception tick: the tracked people, the nearest person, audio levels, discrete events since the last tick (enter, leave, zone change, shout, empty) and sensor health. Scenes and the director read only this. Each tick is logged as one JSON line for replay, holding numbers only, never images.

### Director

`director/director.ts` owns all behavior, in two layers.

- **Show layer:** picks the active scene. It rotates through a playlist every few minutes while the walk is empty, obeys operator commands, and skips scenes whose required sensors are down.
- **Encounter layer:** a state machine that runs once per group of visitors (diagram below). It also picks a `focusPersonId`, usually the nearest person, for scenes that react to one person.
- **Scare timing** gets a random delay of a fraction of a second to a couple of seconds, so it never feels mechanical. The ranges live in config.
- **Operator commands** override everything.

*[diagram: director encounter states · 5 states (see the live doc)]*

Cooldown is what keeps a group from getting five scares in a row; its length and the scare delay range live in config.

### Scenes

Scenes are plug-ins that follow the `Scene` interface. Each one declares the sensors it needs, runs an ambient loop when nobody is there, reacts to each director state, and draws on a fixed 1920×1080 logical canvas. Scenes keep no timers of their own outside `update(dt)`, which keeps them deterministic in simulation and replay.

### Render and output

- **One full-screen canvas** at 1920×1080 logical resolution, scaled to the display. Canvas 2D first; move a scene to WebGL (via PixiJS or three.js) only if particles or glow can't hold frame rate.
- **Every frame:** clear to pure black, render the active scene, apply any crossfade, apply the output transform, then draw the debug overlay (development only).
- **Output transform** (`render/output.ts`):
   - Mirror flip for rear projection.
   - Four-corner pin warp, a perspective mapping (homography) that lets you drag the image corners to fit the window when the projector is off-center.
   - A mask polygon that forces everything outside the window opening to black, so no light spills onto the frame or wall.
- **Calibration mode** (key `C`): shows a grid; drag corners and mask points; saves to config.
- **Scene changes** crossfade through black.

### Operator remote

The local server serves a `/remote` page to your phone on home Wi-Fi and relays commands over a WebSocket (a persistent two-way connection). Commands: next or previous scene, scare now, blackout, pause interaction, sensitivity up or down, and a gentle mode for very young visitors. The page also shows the director state and people count. Every command also has a laptop keyboard shortcut.

### Debug tools

- **Overlay** (key `D`): camera thumbnail with skeletons and IDs, zone lines, director state, frame rate, perception latency and a loudness meter. Off in show mode.
- **Recorder:** writes the perception log to disk through the server. Replay mode feeds a log back in as if it were live.

### Configuration

`config/show.json`, reloaded when it changes on disk. It holds zones, hysteresis counts, cooldowns, scare delay ranges, the scene playlist, audio thresholds and calibration (mirror, corners, mask).

## Core interfaces

These types are the contract between modules. Scenes import only from this file and render helpers; Claude Code can refine fields, but changes to these types should be deliberate.

```typescript
// src/types.ts — shared contract. Scenes import only from here.

export type Zone = 'far' | 'mid' | 'near';

/** A pose point in visitor-view coordinates: 0..1, x = 0 is the window's left edge as a visitor sees it. */
export interface Landmark {
  x: number;
  y: number;
  visibility: number; // 0..1, from the pose model
}

/** Raw output of a pose model or the simulator, before tracking. */
export interface Detection {
  timeMs: number;
  landmarks: Landmark[]; // 33 points, MediaPipe Pose order
  confidence: number;    // 0..1
}

export interface Person {
  id: number;              // stable while tracked
  x: number;               // 0..1, visitor view
  distanceM: number;       // estimated distance from the window, meters
  zone: Zone;
  approachMps: number;     // positive = moving toward the window
  lateralPerS: number;     // change in x per second
  landmarks: Landmark[];   // smoothed, visitor view
  firstSeenMs: number;
  confidence: number;      // 0..1
}

export type AudienceEvent =
  | { type: 'enter'; personId: number }
  | { type: 'leave'; personId: number }
  | { type: 'zoneChange'; personId: number; from: Zone; to: Zone }
  | { type: 'shout'; db: number }
  | { type: 'empty' };

export interface AudioLevels {
  levelDb: number;
  baselineDb: number;
}

export type SensorStatus = 'ok' | 'stale' | 'off';

export interface SensorHealth {
  camera: SensorStatus;
  audio: SensorStatus;
  source: 'live' | 'sim' | 'replay';
  perceptionLatencyMs: number;
}

export interface AudienceState {
  timeMs: number;
  people: Person[];
  nearest: Person | null;
  audio: AudioLevels;
  events: AudienceEvent[]; // only events since the previous tick
  health: SensorHealth;
}

export type DirectorState = 'idle' | 'noticed' | 'engaged' | 'scare' | 'cooldown';

export interface DirectorContext {
  state: DirectorState;
  stateEnteredMs: number;
  focusPersonId: number | null; // who the scene should attend to
  intensity: 'gentle' | 'normal' | 'full';
}

export interface SceneRequirements {
  camera?: boolean;
  pose?: boolean; // needs full skeletons, not just presence
  audio?: boolean;
}

export interface SceneContext {
  ctx: CanvasRenderingContext2D;
  width: number;  // logical, 1920
  height: number; // logical, 1080
  config: Record<string, unknown>; // this scene's section of show.json
}

export interface Scene {
  id: string;
  title: string;
  requires: SceneRequirements;
  scareDurationS: number; // director leaves 'scare' after this
  init(sc: SceneContext): Promise<void>;
  update(dtS: number, audience: AudienceState, director: DirectorContext): void;
  render(sc: SceneContext): void; // canvas is already cleared to black
  onStateChange?(from: DirectorState, to: DirectorState, director: DirectorContext): void;
  dispose(): void;
}

export type OperatorCommand =
  | { type: 'nextScene' }
  | { type: 'prevScene' }
  | { type: 'setScene'; id: string }
  | { type: 'scareNow' }
  | { type: 'blackout'; on: boolean }
  | { type: 'pauseInteraction'; on: boolean }
  | { type: 'sensitivity'; delta: number }
  | { type: 'intensity'; level: 'gentle' | 'normal' | 'full' };
```

## Scene catalog

Five starter scenes, ordered from no sensors to full body tracking. All art is original and drawn in code (no copyrighted characters). Simple, bold shapes with strong motion read best through fabric, since fine detail blurs.

- **Shadow Walker** (needs nothing). Build this first; it is also the fallback for every degraded mode.
   - Idle: a dim, warm-lit "room" behind the curtain. A dark silhouette crosses it every 40–90 s at random. This scene deliberately uses a lit background so the silhouette shows.
   - Noticed/engaged: the silhouette stops mid-window and turns toward the focus person.
   - Scare: it lunges at the glass, scaling up fast, then the room goes black.
- **Sound Skull** (needs audio). Works with no camera.
   - Idle: a faint skull with a slow breathing glow.
   - Interaction: the jaw opening follows loudness through an envelope follower (fast attack about 30 ms, slower release about 150 ms), so it seems to talk along with the crowd.
   - Scare: a shout event makes the eyes flare and the skull "screams back."
- **Watching Eyes** (needs camera; presence only).
   - Idle: darkness with occasional blinks from several pairs of eyes at random spots.
   - Noticed: one pair snaps open. Engaged: more pairs open.
   - Gaze: pupils shift briefly toward the focus person, then settle back to center. Eyes looking straight out on a flat surface seem to look at every viewer (the "Mona Lisa effect"), so the shift is a cue, not aim. Make the settle behavior a config flag so both versions can be tested.
   - Scare: every pair opens at once, then blackout.
- **Approaching Ghost** (needs camera).
   - Idle: a translucent figure drifting on smooth noise-driven paths.
   - Noticed: it freezes and turns. Engaged: it drifts toward the focus person's x position and grows as they approach.
   - Scare: in the near zone, it rushes to fill the window, then vanishes.
- **Skeleton Mirror** (needs pose).
   - Idle: a lone skeleton waves or dances using hand-made keyframes.
   - Interaction: draws bones over each tracked person's 33 points, with a skull at the head, for up to 4 people. This is the most latency-sensitive scene (see next section).
   - Scare: all skeletons collapse into a pile of bones.

## What matters most

Contrast on the sheet and trigger reliability decide whether the show works. Latency matters only for Skeleton Mirror, and tracking precision barely matters at all. Spend tuning time in that order.

1. **Black level and contrast (physical, not code).** Sheet density, a dark room behind it, and where the porch light points. No code fixes a gray sheet.
2. **Trigger reliability.** False triggers (scaring an empty street, or the projection triggering itself) and misses (ignoring a family at the door). Hysteresis counts, zone thresholds and cooldown length dominate this. Tune them with replay logs, not live.
3. **Latency, by scene.** Skeleton Mirror needs to feel attached to the body; aim for roughly 150 ms or less from motion to light. Eyes and Ghost tolerate 300–500 ms, which reads as a creature's reaction time. These thresholds are my estimates, not measured values.
4. **Tracking precision.** Visitors can't see a position error of 10–20% of the window width, especially for eyes, given the Mona Lisa effect.
5. **Rendering detail.** The fabric blurs fine detail anyway, so motion and timing beat polish.

**Latency budget.** These are rough estimates to measure, not specs:

- Camera exposure and delivery: 33–66 ms, longer in low light.
- Waiting for the next perception tick: on average half the interval, about 33 ms at 15 Hz. Skeleton Mirror should run perception at the camera's full frame rate.
- Pose inference, lite model on a laptop GPU: perhaps 15–60 ms (uncertain; depends on hardware).
- Smoothing lag: 0–50 ms, set by One Euro filter parameters.
- Render and display: 16–33 ms.
- Projector input lag: 15–60 ms or more; the projector's "game mode" usually lowers it.
- **Total:** roughly 110–300 ms end to end.

**Measuring it:** the debug overlay shows perception latency. For true end-to-end latency, film yourself and the sheet together in phone slow motion (240 frames per second) and count frames between a hand movement and the projected response.

## Robustness and fault handling

The show keeps running with any single part failed, by falling back to scenes that don't need it. Nothing ever shows an error on the projection.

**Degraded modes**, from best to worst:

1. **Full:** camera and audio both healthy; all scenes eligible.
2. **No camera** (no frames for 3 s, or permission lost): drop scenes that need the camera; run Sound Skull or Shadow Walker; retry the camera every 30 s.
3. **No audio:** drop Sound Skull.
4. **No sensors:** Shadow Walker on a timed loop. The phone remote and keyboard still work.

**Other protections**

- **Sanity checks on perception:** reject detections that are tiny, at an impossible distance, or more numerous than `numPoses`. Treat a sudden jump in people count as a glitch until hysteresis confirms it.
- **Scene isolation:** each scene's `update` and `render` run inside a try/catch. A scene that throws is disabled for the night, and the director moves on. Errors go to the console and the server log.
- **Heartbeat:** the page sends a heartbeat to the server every second. The phone remote shows when it goes stale, so you know the show froze without walking outside.
- **Offline:** MediaPipe's WebAssembly runtime and model file are copied into the repo at install. Nothing loads from a content delivery network at runtime. Wi-Fi is needed only for the phone remote.
- **Laptop settings:** on AC power, with sleep, screensaver and notifications turned off. A notification banner appearing across the projection is a real and easy-to-miss failure.
- **One-command start:** a script starts the server and opens Chrome in kiosk mode (full-screen, no browser UI) on the projector's display.

**Privacy:** most visitors are children. By default nothing stores images or video. Logs hold only numbers (positions and body points). Video recording is a development-only flag for testing with your own household.

## Tech stack and repo layout

TypeScript in Chrome, served from `localhost`, with a small Node server for the phone remote and logging. Browsers allow camera access on `localhost` without HTTPS, which keeps setup simple.

- **Language and build:** TypeScript with Vite, a dev server that reloads the page instantly on save.
- **Rendering:** Canvas 2D. Add PixiJS or three.js only for a scene that needs it.
- **Pose detection:** `@mediapipe/tasks-vision`, pinned to an exact version, with the WebAssembly files and `pose_landmarker_lite.task` copied into `public/models/`.
- **Server:** Node with `ws` (a WebSocket library). It relays remote commands, writes logs and serves the `/remote` page.
- **Tests:** Vitest for the tracker, filter, geometry and director.
- **Browser:** Chrome on the laptop, in kiosk mode for the show.

```text
halloween-projector/
  config/show.json            # every tunable number
  public/models/              # MediaPipe WASM + pose model (vendored)
  public/assets/              # sounds, optional images
  src/
    main.ts                   # boot, render loop, wiring
    types.ts                  # shared contract
    sensors/camera.ts
    sensors/audio.ts
    sensors/sim.ts            # mouse people, scripted scenarios, replay
    perception/pose.ts        # MediaPipe wrapper
    perception/tracker.ts     # stable IDs + hysteresis
    perception/oneEuro.ts
    perception/geometry.ts    # coordinate flip, distance from feet, zones
    world/audience.ts         # builds AudienceState
    director/director.ts      # encounter state machine
    director/playlist.ts      # show layer, scene eligibility
    scenes/index.ts           # scene registry
    scenes/shadowWalker.ts
    scenes/soundSkull.ts
    scenes/watchingEyes.ts
    scenes/approachingGhost.ts
    scenes/skeletonMirror.ts
    render/output.ts          # mirror, corner pin, mask
    render/calibrate.ts
    control/remoteClient.ts
    debug/overlay.ts
    debug/recorder.ts
  remote/index.html           # phone remote page
  server/index.ts             # WebSocket relay, log writer, /remote
  scripts/start-show.sh       # server + Chrome kiosk on projector display
  tests/
```

## Build plan for Claude Code

Build in eight phases and stop after each one for a hands-on test. The simulator and director come before the camera on purpose, so behavior can be tuned at a desk before any real sensing exists.

1. **App skeleton.** Vite + TypeScript, full-screen black canvas, render loop, `Scene` interface and registry, keyboard scene switching, config loading with reload, mirror flag, and debug overlay with frame rate. Scene: Shadow Walker.
   - Done when: Shadow Walker loops full-screen, `M` toggles mirror, `D` toggles the overlay, and editing `show.json` takes effect without a restart.
2. **Simulator, tracker and director.** Mouse people, tracker with hysteresis, `AudienceState`, encounter state machine, show-layer playlist.
   - Done when: dragging a fake person toward the window walks the overlay through idle, noticed, engaged, scare and cooldown, and unit tests cover every transition.
3. **Audio and Sound Skull.**
   - Done when: the jaw follows speech, a clap or shout triggers the scare, and steady background noise does not.
4. **Camera and pose perception.** MediaPipe wrapper, coordinate flip, distance from feet, zones, One Euro smoothing, recorder and replay.
   - Done when: walking the front path shows correct zones and stable IDs in the overlay, and a recorded walk replays identically.
5. **Watching Eyes and Approaching Ghost.**
   - Done when: both run against live camera and against replay logs, and scenes are skipped automatically when the camera is unplugged.
6. **Skeleton Mirror.**
   - Done when: up to 4 people get skeletons, and end-to-end latency has been measured with the slow-motion method.
7. **Calibration and phone remote.** Corner pin, window mask, `/remote` page, all operator commands.
   - Done when: the image fits the window opening with no spill, and every command works from the phone.
8. **Hardening.** Degraded modes, heartbeat, offline check, kiosk start script.
   - Done when: it boots with the internet disconnected, survives unplugging the camera and mic mid-show, and runs a 4-hour soak test without a frame-rate drop.

**Working rules for Claude Code**

- Work one phase at a time, and stop at the end of each for me to test.
- Ask before adding any dependency not listed in Tech stack.
- Keep every tunable number in `config/show.json`.
- Scenes import only from `types.ts` and render helpers, never from sensors, perception or the director.
- Every frame starts by clearing to pure black.
- Original art drawn in code only; no copyrighted characters.
- Unit-test the tracker, One Euro filter, geometry and director.
- Never write camera images or video to disk unless the development recording flag is on.

## Open questions

These are unknowns that testing should settle, roughly in order of how much they could change the design.

- **Does pose detection work on costumed kids at night?** Capes, inflatable costumes, masks and dim, motion-blurred frames may break MediaPipe's body model. This is the biggest technical risk, and I'm not confident how it plays out. If it fails often, add a simpler person detector for presence and keep pose only for Skeleton Mirror. Record test walks in costume early.
- **Where does the camera go?** Same window with a hood, adjacent window, or outdoors. This decides reflection risk and whether weatherproofing is needed.
- **How often are feet hidden?** In groups, children block each other's ankles. If the shoulder-width fallback runs most of the time, the distance estimate gets much noisier.
- **Centered gaze or tracking gaze for Watching Eyes?** Test both with real people standing at different angles.
- **Lite or full pose model?** Accuracy against frame rate on your laptop's GPU.
- **Canvas 2D or WebGL?** Start 2D; switch only if glow or particles can't hold frame rate.
- **How scary for small children?** Decide what gentle mode changes (no lunges, slower motion, no sound) and whether the operator sets it manually or the system infers it from body size.
- **Sound:** is a door speaker in scope? Sound adds a lot of scare per unit of effort, but it means audio output timing and a weatherproof speaker.
