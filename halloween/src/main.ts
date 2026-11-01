// Boot, render loop and wiring. Data flows one way:
//   source (camera+mic | simulator | replay) → AudienceBuilder → Director → active scene → output transform
// Sensing runs at the perception tick rate; rendering runs at the display rate.

import fallbackConfig from '../config/show.json';
import { logicalSize, validateConfig, withSensitivity, type ShowConfig } from './config.ts';
import type { AudienceEvent, AudienceState, OperatorCommand, Scene } from './types.ts';
import { ServerLink } from './control/remoteClient.ts';
import { Director } from './director/director.ts';
import { Playlist } from './director/playlist.ts';
import { AudienceBuilder } from './world/audience.ts';
import { MotionPredictor } from './world/motionPredictor.ts';
import { NO_MUSIC, type PerceptionFrame, type PerceptionSource } from './world/frame.ts';
import { SimSource, SimWorld, ReplaySource, attachSimControls } from './sensors/sim.ts';
import { LiveSource } from './sensors/live.ts';
import { Output } from './render/output.ts';
import { SceneRunner } from './render/sceneRunner.ts';
import { Calibrator, saveOutputCalibration, turned } from './render/calibrate.ts';
import { AmbientLighting } from './render/ambient.ts';
import { AreaCalibrator } from './render/areaCalibrate.ts';
import { Overlay } from './debug/overlay.ts';
import { Recorder } from './debug/recorder.ts';
import { SCENE_FACTORIES } from './scenes/index.ts';

type SourceMode = ShowConfig['source']['mode'];

const params = new URLSearchParams(location.search);

async function loadConfig(): Promise<ShowConfig> {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    const raw = await res.json();
    const problems = validateConfig(raw);
    if (problems.length === 0) return raw as ShowConfig;
    console.error('[config] show.json has problems, using the built-in copy:', problems);
  } catch (err) {
    console.error('[config] could not load /api/config, using the built-in copy', err);
  }
  return fallbackConfig as unknown as ShowConfig;
}

const EMPTY_AUDIENCE: AudienceState = {
  timeMs: 0,
  people: [],
  nearest: null,
  audio: { levelDb: -90, baselineDb: -90 },
  music: NO_MUSIC,
  events: [],
  cameraArea: { x: 0, y: 0, w: 1, h: 1 },
  health: { camera: 'off', audio: 'off', source: 'live', perceptionLatencyMs: 0 },
};

/** JS heap in MB where Chrome exposes it, for the heartbeat and soak tests. */
function memoryMB(): number | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? Math.round(m.usedJSHeapSize / 1e5) / 10 : null;
}

async function boot(): Promise<void> {
  let baseCfg = await loadConfig();
  let sensitivity = 0;
  let cfg = withSensitivity(baseCfg, sensitivity);

  const displayCanvas = document.getElementById('display') as HTMLCanvasElement;
  const overlayCanvas = document.getElementById('overlay') as HTMLCanvasElement;

  const link = new ServerLink({
    onCommand: (cmd) => applyCommand(cmd),
    onConfig: (raw) => {
      const problems = validateConfig(raw);
      if (problems.length) {
        console.error('[config] ignoring invalid show.json update:', problems);
        link.reportError(`invalid show.json update ignored: ${problems.join('; ')}`);
        return;
      }
      baseCfg = raw as ShowConfig;
      applyConfig();
      console.info('[config] reloaded show.json');
    },
  });
  link.connect();

  // Errors go to the console and the server log, never onto the projection.
  window.addEventListener('error', (e) => link.reportError(`${e.message} at ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => link.reportError(`unhandled rejection: ${String(e.reason)}`));

  const output = new Output(displayCanvas, cfg.output);
  const overlay = new Overlay(overlayCanvas);
  const playlistRef: { current: Playlist | null } = { current: null };
  const runner = new SceneRunner((id, err) => {
    console.error(`[scene] ${id} threw and is disabled for the night`, err);
    link.reportError(`scene ${id} threw and was disabled: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    playlistRef.current?.disable(id);
  }, logicalSize(cfg.output.orientation));

  const scenes: Scene[] = SCENE_FACTORIES.map((f) => f());
  await Promise.all(scenes.map((s) => runner.register(s, cfg.scenes[s.id] ?? {})));
  const playlist = new Playlist(scenes.map((s) => ({ id: s.id, requires: s.requires })), cfg.show);
  playlistRef.current = playlist;

  const director = new Director(cfg.director);
  const builder = new AudienceBuilder(cfg);
  const predictor = new MotionPredictor(cfg.perception);
  const simWorld = new SimWorld(cfg);
  const calibrator = new Calibrator(overlayCanvas, output, () => cfg.output);
  // Camera active area (key A): edits apply live, and are saved when it closes.
  const areaCal = new AreaCalibrator(
    overlayCanvas,
    () => ({ cfg, video: liveSource?.video ?? null, audience }),
    (s) => {
      baseCfg = { ...baseCfg, perception: { ...baseCfg.perception, ...s } };
      applyConfig();
    },
  );
  const recorder = new Recorder(link, () => cfg);
  const ambient = new AmbientLighting(cfg.ambient);

  let blackout = false;
  let showOverlay = params.get('overlay') === '1' || cfg.display.showOverlay;
  let audience: AudienceState = EMPTY_AUDIENCE;
  let pendingEvents: AudienceEvent[] = [];
  let source: PerceptionSource | null = null;
  let mode: SourceMode = (params.get('source') as SourceMode | null) ?? cfg.source.mode;
  let liveSource: LiveSource | null = null;
  let sourceGeneration = 0;

  function applyConfig(): void {
    cfg = withSensitivity(baseCfg, sensitivity);
    builder.setConfig(cfg);
    predictor.setConfig(cfg.perception);
    director.setConfig(cfg.director);
    playlist.setConfig(cfg.show);
    simWorld.setConfig(cfg);
    liveSource?.setConfig(cfg);
    ambient.setConfig(cfg.ambient);
    runner.setSceneConfigs(cfg.scenes);
    if (!calibrator.active) output.setCalibration(cfg.output);
  }

  function onFrame(gen: number, frame: PerceptionFrame): void {
    if (gen !== sourceGeneration) return; // a frame from a source we already stopped
    recorder.write(frame);
    audience = builder.ingest(frame);
    predictor.observe(audience.people, frame.timeMs, performance.now());
    pendingEvents.push(...audience.events);
  }

  function startSource(next: SourceMode): void {
    source?.stop();
    builder.reset();
    predictor.reset();
    pendingEvents = [];
    mode = next;
    const gen = ++sourceGeneration;
    if (next === 'sim') {
      source = new SimSource(simWorld, () => cfg.perception.tickHz);
    } else if (next === 'replay') {
      const log = params.get('log');
      if (!log) {
        console.warn('[replay] add ?log=<name> from /api/logs; falling back to the simulator');
        return startSource('sim');
      }
      source = new ReplaySource(log);
    } else {
      liveSource ??= new LiveSource(cfg);
      source = liveSource;
    }
    source.start((f) => onFrame(gen, f));
  }

  function switchScene(id: string | null): void {
    if (id !== null) runner.switchTo(id);
  }

  function applyCommand(cmd: OperatorCommand): void {
    const now = performance.now();
    const health = audience.health;
    switch (cmd.type) {
      case 'nextScene':
        switchScene(playlist.step(1, now, health));
        break;
      case 'prevScene':
        switchScene(playlist.step(-1, now, health));
        break;
      case 'setScene':
        switchScene(playlist.choose(cmd.id, now, health));
        break;
      case 'scareNow':
        director.scareNow();
        break;
      case 'blackout':
        blackout = cmd.on;
        break;
      case 'pauseInteraction':
        director.setPaused(cmd.on);
        break;
      case 'sensitivity':
        sensitivity = Math.max(baseCfg.sensitivity.min, Math.min(baseCfg.sensitivity.max, sensitivity + Math.sign(cmd.delta)));
        applyConfig();
        break;
      case 'intensity':
        director.setIntensity(cmd.level);
        break;
    }
  }

  // ---------- keyboard ----------
  const INTENSITIES = ['gentle', 'normal', 'full'] as const;
  window.addEventListener('keydown', (e) => {
    if (calibrator.active && calibrator.handleKey(e)) return;
    if (areaCal.active && areaCal.handleKey(e)) return;
    const k = e.key;
    if (k === 'ArrowRight') applyCommand({ type: 'nextScene' });
    else if (k === 'ArrowLeft') applyCommand({ type: 'prevScene' });
    else if (/^[1-9]$/.test(k)) {
      const id = cfg.show.playlist[Number(k) - 1];
      if (id) applyCommand({ type: 'setScene', id });
    } else if (k === 'Enter') applyCommand({ type: 'scareNow' });
    else if (k === 'b' || k === 'B') applyCommand({ type: 'blackout', on: !blackout });
    else if (k === 'p' || k === 'P') applyCommand({ type: 'pauseInteraction', on: !director.isPaused });
    else if (k === '=' || k === '+') applyCommand({ type: 'sensitivity', delta: 1 });
    else if (k === '-' || k === '_') applyCommand({ type: 'sensitivity', delta: -1 });
    else if (k === 'g' || k === 'G') {
      const i = INTENSITIES.indexOf(director.context.intensity);
      applyCommand({ type: 'intensity', level: INTENSITIES[(i + 1) % INTENSITIES.length]! });
    } else if (k === 'o' || k === 'O') {
      // Landscape ↔ portrait (Shift: a quarter turn for a projector on its side). Saved straight away.
      const next = turned(output.calibration, e.shiftKey);
      output.setCalibration(next);
      saveOutputCalibration(next).catch((err) => console.error('[output] could not save orientation', err));
    } else if (k === 'm' || k === 'M') {
      output.setCalibration({ ...output.calibration, mirror: !output.calibration.mirror });
    } else if (k === 'd' || k === 'D') showOverlay = !showOverlay;
    else if (k === 'l' || k === 'L') ambient.enabled = !ambient.enabled;
    else if (k === 'c' || k === 'C') calibrator.toggle();
    else if (k === 'a' || k === 'A') areaCal.toggle();
    else if (k === 't' || k === 'T') {
      // High-contrast skeletons (for a translucent screen). For this session; set
      // scenes.skeletonMirror.highContrast in show.json to keep it.
      const sm = baseCfg.scenes.skeletonMirror ?? {};
      baseCfg = { ...baseCfg, scenes: { ...baseCfg.scenes, skeletonMirror: { ...sm, highContrast: !sm.highContrast } } };
      applyConfig();
    }
    else if (k === 'f' || k === 'F') {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen().catch(() => {});
    } else if (k === 's' || k === 'S') startSource(mode === 'sim' ? 'live' : 'sim');
    else if (k === 'r' || k === 'R') recorder.toggle(liveSource?.videoStream ?? null);
    // Simulator controls.
    else if (mode === 'sim') {
      const now = performance.now();
      if (k === 'x' || k === 'X') simWorld.shout(now);
      else if (k === 'v' || k === 'V') simWorld.talking = true;
      else if (k === 'k' || k === 'K') simWorld.music = simWorld.music === 'off' ? 'disco' : simWorld.music === 'disco' ? 'shuffle' : 'off';
      else if (k === 'j' || k === 'J') simWorld.playScenario('family', now);
      else if (k === 'h' || k === 'H') simWorld.playScenario('passerby', now);
      else if (k === 'u' || k === 'U') simWorld.playScenario('lurker', now);
      else if (k === 'Backspace') simWorld.clear();
      else if (k === '[') simWorld.health.camera = simWorld.health.camera === 'ok' ? 'off' : 'ok';
      else if (k === ']') simWorld.health.audio = simWorld.health.audio === 'ok' ? 'off' : 'ok';
      else return;
    } else return;
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'v' || e.key === 'V') simWorld.talking = false;
  });
  // Browsers only start audio after a user gesture unless Chrome runs with the
  // kiosk script's autoplay flag; any key or click retries.
  const resumeAudio = () => liveSource?.resumeAudio();
  window.addEventListener('pointerdown', resumeAudio);
  window.addEventListener('keydown', resumeAudio);

  attachSimControls(overlayCanvas, simWorld, () => (mode === 'sim' && !calibrator.active && !areaCal.active ? overlay.walkMapRect() : null), () => cfg);

  // ---------- heartbeat to the server (and on to the phone remote) ----------
  let fps = 60;
  window.setInterval(() => {
    const active = runner.active;
    link.heartbeat({
      scene: playlist.activeId,
      sceneTitle: active?.title ?? 'black',
      scenes: scenes.map((s) => ({ id: s.id, title: s.title, eligible: playlist.eligible(audience.health).includes(s.id) })),
      state: director.context.state,
      people: audience.people.length,
      fps: Math.round(fps),
      health: audience.health,
      paused: director.isPaused,
      blackout,
      intensity: director.context.intensity,
      sensitivity,
      recording: recorder.recording,
      memoryMB: memoryMB(),
    });
  }, cfg.health.heartbeatS * 1000);

  // Soak test (?source=sim&soak=1): random encounters, shouts and scene changes, forever.
  if (params.get('soak') === '1') {
    const scenarios = ['family', 'passerby', 'lurker'] as const;
    let nextAction = performance.now() + 5000;
    window.setInterval(() => {
      const now = performance.now();
      if (mode !== 'sim' || now < nextAction) return;
      const r = Math.random();
      if (r < 0.55) simWorld.playScenario(scenarios[Math.floor(Math.random() * scenarios.length)]!, now);
      else if (r < 0.7) simWorld.shout(now);
      else if (r < 0.85) applyCommand({ type: 'nextScene' });
      else simWorld.clear();
      nextAction = now + 15_000 + Math.random() * 30_000;
    }, 1000);
  }

  // ---------- render loop ----------
  startSource(mode);
  let last = performance.now();
  let lastFullRate: boolean | null = null;

  const loop = (now: number) => {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (dt > 0) fps += (1 / dt - fps) * 0.05;

    // Poses moved forward to this exact frame, so bodies glide at the display
    // rate instead of stepping at the camera rate, and keep up with the dancer.
    const a: AudienceState = { ...audience, people: predictor.apply(audience.people, now), events: pendingEvents };
    pendingEvents = [];

    const changed = playlist.update(now, a.health, director.context.state, a.people.length === 0);
    if (changed !== null || (playlist.activeId === null && runner.active !== null)) runner.switchTo(playlist.activeId);

    const active = runner.active;
    for (const t of director.update(now, a, active?.scareDurationS ?? 2)) {
      runner.notifyStateChange(t.from, t.to, director.context);
    }

    // Skeleton Mirror needs perception at the camera's full frame rate.
    const fullRate = cfg.perception.fullRateForPoseScenes && !!active?.requires.pose;
    if (fullRate !== lastFullRate) {
      source?.setFullRate?.(fullRate);
      lastFullRate = fullRate;
    }

    // Follow the output's orientation (O key, calibration, or a show.json edit).
    runner.setSize(logicalSize(output.calibration.orientation));
    ambient.update(dt, a, director.context, playlist.activeId);
    if (calibrator.active) calibrator.renderGrid(runner.canvas);
    else {
      runner.frame(dt, a, director.context, cfg.display.crossfadeS, blackout ? 0 : 1);
      if (!blackout) ambient.render(runner.ctx, runner.canvas.width, runner.canvas.height);
    }
    output.present(runner.canvas);

    const scheduled = director.scheduledScareMs;
    const showMap = mode === 'sim' && !calibrator.active;
    if (areaCal.active) areaCal.draw();
    else if (calibrator.active) calibrator.draw();
    else if (showOverlay || showMap) {
      overlay.draw(
        {
          fps,
          sceneTitle: active?.title ?? 'black',
          director: director.context,
          scheduledScareInS: scheduled === null ? null : Math.max(0, (scheduled - now) / 1000),
          sensitivity,
          paused: director.isPaused,
          blackout,
          recording: recorder.recording,
          serverConnected: link.connected,
          outputMode: output.usingWebGl ? 'webgl' : '2d',
          pose: mode === 'live' ? liveSource?.poseStats ?? null : null,
          beat: mode === 'live' ? liveSource?.beatTracker ?? null : mode === 'sim' ? simWorld.beatTracker : null,
          musicInput: mode === 'live' ? liveSource?.musicInput ?? null : null,
          ambient: { on: ambient.enabled, liveliness: ambient.liveliness },
          disabledScenes: playlist.disabledIds,
          audience: a,
          cfg,
          video: liveSource?.video ?? null,
          simPeople: mode === 'sim' ? simWorld.people : null,
          showDetail: showOverlay,
          nowMs: now,
        },
        showMap,
      );
    } else overlay.clear();

    const hideCursor = cfg.display.hideCursor && !showOverlay && !calibrator.active && !areaCal.active && mode !== 'sim';
    document.body.classList.toggle('hide-cursor', hideCursor);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // Exposed for debugging from the console and for automated checks.
  (window as unknown as Record<string, unknown>).__show = { director, playlist, simWorld, runner, output, get audience() { return audience; }, get cfg() { return cfg; }, get fps() { return fps; }, ambient, applyCommand, startSource };
}

void boot();
