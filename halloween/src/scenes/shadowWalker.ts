// Shadow Walker: a dim, warm-lit "room" behind the curtain. A silhouette
// crosses now and then. When visitors are noticed it stops mid-window and turns
// toward them; on a scare it lunges at the glass and the room goes black.
// Needs no sensors, so it is also the fallback for every degraded mode.

import type { AudienceState, DirectorContext, DirectorState, Scene, SceneContext } from '../types.ts';
import { approach, clamp, easeInCubic, easeOutCubic, fbm1, lerp, limb, makeRng, num, randRange } from '../render/helpers.ts';

type FigureMode = 'off' | 'walking' | 'arriving' | 'facing' | 'lunging' | 'fading';

export function createShadowWalker(): Scene {
  let cfg: Record<string, unknown> = {};
  const rng = makeRng(7);
  let t = 0;
  let light = 1;            // room light multiplier, 0 = black
  let lightTarget = 1;
  let nextCrossIn = 0;
  let dirState: DirectorState = 'idle';
  let intensity: DirectorContext['intensity'] = 'normal';
  let focusX: number | null = null;

  const fig = {
    mode: 'off' as FigureMode,
    x: 0,
    dir: 1,          // +1 walking right, -1 walking left
    phase: 0,        // walk cycle
    facing: 0,       // 0 = side profile, 1 = facing the window
    scale: 1,
    lean: 0,
    reach: 0,        // arms raised toward the glass
    alpha: 1,
    modeT: 0,
    targetX: 960,
  };

  // Canvas size, set in init (1920x1080, or 1080x1920 in portrait).
  let W = 1920;
  let H = 1080;
  let floorY = 1010;

  function startCross(): void {
    fig.dir = rng() < 0.5 ? 1 : -1;
    fig.x = fig.dir > 0 ? -200 : W + 200;
    fig.mode = 'walking';
    fig.facing = 0;
    fig.scale = 1;
    fig.reach = 0;
    fig.alpha = 1;
    fig.modeT = 0;
  }

  function setMode(mode: FigureMode): void {
    fig.mode = mode;
    fig.modeT = 0;
  }

  const scene: Scene = {
    id: 'shadowWalker',
    title: 'Shadow Walker',
    requires: {},
    scareDurationS: 2.5,

    async init(sc: SceneContext) {
      cfg = sc.config;
      scene.scareDurationS = num(cfg, 'scareDurationS');
      nextCrossIn = num(cfg, 'firstCrossS');
      W = sc.width;
      H = sc.height;
      floorY = H - 70;
      fig.targetX = W / 2;
    },

    update(dt: number, audience: AudienceState, director: DirectorContext) {
      t += dt;
      fig.modeT += dt;
      intensity = director.intensity;
      const focus = audience.people.find((p) => p.id === director.focusPersonId) ?? audience.nearest;
      focusX = focus ? focus.x * W : null;
      const walkSpeed = num(cfg, 'walkSpeed');
      const state = director.state;

      if (state === 'idle') {
        lightTarget = 1;
        if (fig.mode === 'off') {
          nextCrossIn -= dt;
          if (nextCrossIn <= 0) {
            startCross();
            nextCrossIn = randRange(rng, num(cfg, 'crossMinS'), num(cfg, 'crossMaxS'));
          }
        } else if (fig.mode === 'facing' || fig.mode === 'arriving') {
          // Visitors left mid-encounter: turn away and walk off.
          fig.dir = fig.x < W / 2 ? -1 : 1;
          setMode('walking');
        }
      } else if (state === 'noticed' || state === 'engaged') {
        lightTarget = 1;
        if (fig.mode === 'off' || fig.mode === 'fading') {
          // Enter from the side away from the visitor, so it walks toward them.
          const fromLeft = focusX === null ? rng() < 0.5 : focusX > W / 2;
          fig.dir = fromLeft ? 1 : -1;
          fig.x = fromLeft ? -200 : W + 200;
          fig.scale = 1;
          fig.reach = 0;
          fig.alpha = 1;
          setMode('arriving');
        } else if (fig.mode === 'walking') {
          setMode('arriving');
        }
        fig.targetX = W / 2 + (focusX === null ? 0 : (focusX - W / 2) * 0.25);
      } else if (state === 'scare') {
        if (fig.mode !== 'lunging' && fig.mode !== 'fading') {
          if (fig.mode === 'off') {
            fig.x = focusX ?? W / 2;
            fig.facing = 1;
            fig.alpha = 1;
          }
          setMode(intensity === 'gentle' ? 'fading' : 'lunging');
        }
      } else if (state === 'cooldown') {
        if (fig.mode !== 'off' && fig.mode !== 'fading') setMode('fading');
        lightTarget = 1;
      }

      // Figure motion by mode.
      switch (fig.mode) {
        case 'walking':
          fig.x += fig.dir * walkSpeed * dt;
          fig.phase += dt * walkSpeed / 70;
          fig.facing = approach(fig.facing, 0, dt, 0.2);
          if (fig.x < -260 || fig.x > W + 260) fig.mode = 'off';
          break;
        case 'arriving': {
          const dx = fig.targetX - fig.x;
          fig.dir = Math.sign(dx) || fig.dir;
          const step = Math.min(Math.abs(dx), walkSpeed * dt);
          fig.x += Math.sign(dx) * step;
          fig.phase += dt * walkSpeed / 70;
          if (Math.abs(dx) < 4) setMode('facing');
          break;
        }
        case 'facing': {
          const turn = num(cfg, 'turnTimeS');
          fig.facing = approach(fig.facing, 1, dt, turn / 3);
          fig.phase = approach(fig.phase, Math.round(fig.phase / Math.PI) * Math.PI, dt, 0.2);
          fig.lean = approach(fig.lean, focusX === null ? 0 : clamp((focusX - fig.x) / 600, -1, 1), dt, 0.4);
          const s = state === 'engaged' ? num(cfg, 'approachScale') : 1;
          fig.scale = approach(fig.scale, s, dt, 2);
          fig.x = approach(fig.x, fig.targetX, dt, 1.5);
          break;
        }
        case 'lunging': {
          const lt = num(cfg, 'lungeTimeS');
          const k = clamp(fig.modeT / lt, 0, 1);
          fig.facing = 1;
          fig.scale = lerp(fig.scale, num(cfg, 'lungeScale'), easeInCubic(k) * 0.35 + k * 0.05);
          fig.reach = easeOutCubic(k);
          fig.x = approach(fig.x, W / 2, dt, 0.25);
          if (fig.modeT > lt + num(cfg, 'darkAfterLungeS')) {
            lightTarget = 0;
            light = 0;
            fig.mode = 'off';
          }
          break;
        }
        case 'fading':
          fig.alpha = approach(fig.alpha, 0, dt, 0.5);
          if (intensity === 'gentle' && state === 'scare') lightTarget = 0.25;
          if (fig.alpha < 0.02) fig.mode = 'off';
          break;
        case 'off':
          break;
      }

      // Lights: snap off instantly, come back slowly with a flicker.
      if (lightTarget < light) light = approach(light, lightTarget, dt, 0.15);
      else light = approach(light, lightTarget, dt, num(cfg, 'relightS') / 3);
    },

    onStateChange(_from: DirectorState, to: DirectorState) {
      dirState = to;
      if (to === 'cooldown' && fig.mode === 'off') light = Math.min(light, 0.02);
    },

    render(sc: SceneContext) {
      const { ctx, width: w, height: h } = sc;
      const bright = num(cfg, 'roomBrightness');
      const hue = num(cfg, 'roomHue');
      const flick = 1 - num(cfg, 'flickerAmount') * (0.5 + 0.5 * fbm1(t * 3.1, 3));
      // Relighting after a scare stutters like an old bulb.
      const stutter = light < 0.98 && dirState !== 'scare' ? (fbm1(t * 22) > -0.2 ? 1 : 0.35) : 1;
      const L = clamp(bright * light * flick * stutter, 0, 1);
      if (L <= 0.003) return;

      // Warm lamp glow on the curtain.
      const g = ctx.createRadialGradient(w * 0.5, h * 0.32, 40, w * 0.5, h * 0.45, w * 0.62);
      g.addColorStop(0, `hsl(${hue}, 85%, ${(L * 62).toFixed(1)}%)`);
      g.addColorStop(0.45, `hsl(${hue - 6}, 75%, ${(L * 34).toFixed(1)}%)`);
      g.addColorStop(1, `hsl(${hue - 12}, 70%, ${(L * 7).toFixed(1)}%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      // Soft vertical folds, so it reads as fabric with light behind it.
      ctx.save();
      ctx.globalAlpha = 0.18 * L;
      for (let i = 0; i < 14; i++) {
        const x = (i + 0.5) * (w / 14) + Math.sin(i * 1.7) * 30;
        const fold = ctx.createLinearGradient(x - 60, 0, x + 60, 0);
        fold.addColorStop(0, 'rgba(0,0,0,0)');
        fold.addColorStop(0.5, 'rgba(0,0,0,1)');
        fold.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = fold;
        ctx.fillRect(x - 60, 0, 120, h);
      }
      ctx.restore();

      // Floor shadow.
      const fg = ctx.createLinearGradient(0, h * 0.8, 0, h);
      fg.addColorStop(0, 'rgba(0,0,0,0)');
      fg.addColorStop(1, 'rgba(0,0,0,0.85)');
      ctx.fillStyle = fg;
      ctx.fillRect(0, h * 0.8, w, h * 0.2);

      if (fig.mode !== 'off') drawFigure(ctx);
    },

    dispose() {},
  };

  function drawFigure(ctx: CanvasRenderingContext2D): void {
    const figH = num(cfg, 'figureHeight') * fig.scale * (H / 1080);
    const u = figH / 8;
    const x = fig.x;
    const foot = floorY + (fig.scale - 1) * 260 * (H / 1080);
    const swing = Math.sin(fig.phase) * (1 - fig.facing);
    const f = fig.facing;
    const lean = fig.lean * u * 0.5;

    ctx.save();
    ctx.globalAlpha = fig.alpha;
    ctx.filter = `blur(${(num(cfg, 'softnessPx') * (0.6 + fig.scale * 0.4)).toFixed(1)}px)`;
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const hipY = foot - 4 * u;
    const shY = foot - 6.5 * u;
    const shoulderHalf = lerp(0.35, 1.0, f) * u;
    const hipHalf = lerp(0.3, 0.6, f) * u;

    // Legs: scissor in profile, planted apart when facing.
    for (const side of [-1, 1]) {
      const a = side * swing * 0.45;
      const hipX = x + side * hipHalf * 0.8;
      const kneeX = hipX + Math.sin(a) * 2 * u + side * f * 0.1 * u;
      const kneeY = hipY + Math.cos(a) * 2 * u;
      const footX = kneeX + Math.sin(a - Math.abs(a) * 0.6 * fig.dir) * 2 * u + side * f * 0.25 * u;
      limb(ctx, hipX, hipY, kneeX, kneeY, u * 0.42);
      limb(ctx, kneeX, kneeY, footX, foot, u * 0.36);
    }

    // Long coat torso.
    ctx.beginPath();
    ctx.moveTo(x - shoulderHalf + lean, shY);
    ctx.lineTo(x + shoulderHalf + lean, shY);
    ctx.lineTo(x + hipHalf * 1.6, hipY + u * 0.9);
    ctx.lineTo(x - hipHalf * 1.6, hipY + u * 0.9);
    ctx.closePath();
    ctx.fill();

    // Arms: swing in profile, hang long when facing, claw forward on a lunge.
    for (const side of [-1, 1]) {
      const sx = x + side * shoulderHalf * 0.9 + lean;
      const sw = -side * swing * 0.5;
      const reachSpread = fig.reach * 1.3;
      const ex = sx + Math.sin(sw) * 1.6 * u + side * (f * 0.2 + reachSpread * 0.8) * u;
      const ey = shY + Math.cos(sw) * 1.6 * u - fig.reach * 2.2 * u;
      const hx = ex + Math.sin(sw * 1.2) * 1.6 * u + side * reachSpread * 0.9 * u;
      const hy = ey + 1.7 * u - fig.reach * 3.4 * u;
      limb(ctx, sx, shY + u * 0.15, ex, ey, u * 0.34);
      limb(ctx, ex, ey, hx, hy, u * 0.28);
      // Long fingers.
      for (let k = -1; k <= 1; k++) {
        const fa = Math.atan2(hy - ey, hx - ex) + k * 0.35;
        limb(ctx, hx, hy, hx + Math.cos(fa) * u * 0.7, hy + Math.sin(fa) * u * 0.7, u * 0.09);
      }
    }

    // Neck, head and a tall hat.
    const headX = x + lean * 1.6 + (1 - f) * fig.dir * u * 0.15;
    const headY = shY - u * 0.85;
    limb(ctx, x + lean, shY, headX, headY, u * 0.3);
    ctx.beginPath();
    ctx.ellipse(headX, headY, u * lerp(0.42, 0.48, f), u * 0.56, fig.lean * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(headX - u * 0.95, headY - u * 0.62, u * 1.9, u * 0.16);
    ctx.fillRect(headX - u * 0.52, headY - u * 1.9, u * 1.04, u * 1.3);

    ctx.restore();
  }

  return scene;
}
