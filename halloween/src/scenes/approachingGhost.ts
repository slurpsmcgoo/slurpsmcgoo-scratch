// Approaching Ghost: a translucent figure drifting on smooth noise paths. When
// noticed it freezes and turns to face the window; while engaged it drifts
// toward the focus person and grows as they come closer. On a scare it rushes
// to fill the window, then vanishes. Needs the camera.

import type { AudienceState, DirectorContext, DirectorState, Scene, SceneContext } from '../types.ts';
import { approach, clamp, easeInCubic, fbm1, invLerp, lerp, num, str, withAlpha } from '../render/helpers.ts';

export function createApproachingGhost(): Scene {
  let cfg: Record<string, unknown> = {};
  let t = 0;
  // Canvas size, set in init (1920x1080, or 1080x1920 in portrait).
  let cw = 1920;
  let ch = 1080;
  let x = 960;
  let y = 480;
  let scale = 1;
  let alpha = 0;
  let facing = 0;   // 0 = side-on drift, 1 = facing the window
  let dir = 1;      // drift direction for side-on eyes
  let state: DirectorState = 'idle';
  let intensity: DirectorContext['intensity'] = 'normal';
  let scareT = -1;
  let rushFrom = { x: 960, y: 480, scale: 1 };

  const scene: Scene = {
    id: 'approachingGhost',
    title: 'Approaching Ghost',
    requires: { camera: true },
    scareDurationS: 1.6,

    async init(sc: SceneContext) {
      cfg = sc.config;
      scene.scareDurationS = num(cfg, 'scareDurationS');
      cw = sc.width;
      ch = sc.height;
      x = cw / 2;
    },

    update(dt: number, audience: AudienceState, director: DirectorContext) {
      t += dt;
      state = director.state;
      intensity = director.intensity;
      const focus = audience.people.find((p) => p.id === director.focusPersonId) ?? audience.nearest;
      const baseAlpha = num(cfg, 'alpha');

      if (scareT >= 0) {
        scareT += dt;
        const rush = num(cfg, 'rushS');
        if (intensity === 'gentle') {
          // Gentle: a little startled hop, then a soft fade.
          y = rushFrom.y - Math.sin(Math.min(1, scareT / 0.4) * Math.PI) * 40;
          alpha = approach(alpha, 0, dt, 0.5);
        } else if (scareT < rush) {
          const k = easeInCubic(scareT / rush);
          x = lerp(rushFrom.x, cw / 2, k);
          y = lerp(rushFrom.y, 600, k);
          scale = lerp(rushFrom.scale, num(cfg, 'rushScale'), k);
          alpha = lerp(alpha, 1, k);
          facing = 1;
        } else {
          alpha = approach(alpha, 0, dt, num(cfg, 'vanishS') / 4);
        }
        return;
      }

      const drift = num(cfg, 'driftSpeed');
      if (state === 'idle') {
        const tx = cw * (0.5 + 0.38 * fbm1(t * drift + 3.7));
        const ty = ch * (0.44 + 0.1 * fbm1(t * drift * 1.3 + 50));
        const vx = tx - x;
        if (Math.abs(vx) > 2) dir = Math.sign(vx);
        x = approach(x, tx, dt, 0.8);
        y = approach(y, ty, dt, 0.8);
        scale = approach(scale, num(cfg, 'farScale'), dt, 1.5);
        facing = approach(facing, 0.15, dt, 0.8);
        alpha = approach(alpha, baseAlpha, dt, num(cfg, 'fadeInS') / 3);
      } else if (state === 'noticed') {
        // Freeze, then turn to look.
        facing = approach(facing, 1, dt, num(cfg, 'freezeS') / 3);
        alpha = approach(alpha, baseAlpha, dt, 0.5);
      } else if (state === 'engaged') {
        facing = approach(facing, 1, dt, 0.2);
        if (focus) {
          x = approach(x, focus.x * cw, dt, num(cfg, 'approachRate'));
          const close = clamp(invLerp(num(cfg, 'farDistanceM'), num(cfg, 'nearDistanceM'), focus.distanceM), 0, 1);
          scale = approach(scale, lerp(num(cfg, 'farScale'), num(cfg, 'nearScale'), close), dt, num(cfg, 'approachRate'));
          y = approach(y, 480 + close * 90, dt, num(cfg, 'approachRate'));
        }
        alpha = approach(alpha, Math.min(1, baseAlpha * 1.25), dt, 0.5);
      } else if (state === 'cooldown') {
        alpha = approach(alpha, 0, dt, 0.3);
        if (alpha < 0.02) {
          // Come back from somewhere else, small and far.
          x = cw * (0.5 + 0.38 * fbm1(t * drift + 3.7));
          scale = num(cfg, 'farScale');
          facing = 0;
        }
      }
    },

    onStateChange(_from: DirectorState, to: DirectorState) {
      if (to === 'scare') {
        scareT = 0;
        rushFrom = { x, y, scale };
      } else {
        scareT = -1;
      }
    },

    render(sc: SceneContext) {
      if (alpha < 0.01) return;
      const { ctx } = sc;
      const H = num(cfg, 'baseHeight') * scale * (ch / 1080);
      const R = H * 0.3;
      const bob = Math.sin(t * 1.7) * num(cfg, 'bobPx') * (scareT >= 0 ? 0 : 1);
      const cx = x;
      const top = y - H * 0.5 + bob;
      const hemY = y + H * 0.5 + bob;
      const color = str(cfg, 'color');
      const waves = Math.max(2, Math.round(num(cfg, 'hemWaves')));
      const sway = Math.sin(t * 1.3) * R * 0.25;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = str(cfg, 'glowColor');
      ctx.shadowBlur = 40 + 30 * scale;

      // Sheet: dome head, flaring body, wavy hem.
      const body = ctx.createLinearGradient(0, top, 0, hemY);
      body.addColorStop(0, withAlpha(color, 0.95));
      body.addColorStop(0.6, withAlpha(color, 0.7));
      body.addColorStop(1, withAlpha(color, 0.15));
      ctx.fillStyle = body;
      ctx.beginPath();
      const leftHem = cx - R * 1.35 + sway;
      const rightHem = cx + R * 1.35 + sway;
      ctx.moveTo(leftHem, hemY);
      ctx.bezierCurveTo(cx - R * 1.15, top + R * 2.2, cx - R * 1.1, top + R * 1.1, cx - R, top + R);
      ctx.arc(cx, top + R, R, Math.PI, 0);
      ctx.bezierCurveTo(cx + R * 1.1, top + R * 1.1, cx + R * 1.15, top + R * 2.2, rightHem, hemY);
      const step = (rightHem - leftHem) / waves;
      for (let i = waves - 1; i >= 0; i--) {
        const x0 = leftHem + step * i;
        const wob = Math.sin(t * 3 + i * 1.7) * R * 0.12;
        ctx.quadraticCurveTo(x0 + step / 2, hemY - R * 0.35 + wob, x0, hemY + wob * 0.5);
      }
      ctx.closePath();
      ctx.fill();

      // Little arms.
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(cx + side * R * 1.15 + sway * 0.5, top + R * 2.1 + Math.sin(t * 2 + side) * R * 0.1, R * 0.38, R * 0.18, side * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // Face: hollow eyes and mouth, sliding to one side when drifting side-on.
      ctx.save();
      ctx.globalAlpha = Math.min(1, alpha * 1.6);
      ctx.fillStyle = '#000';
      const off = (1 - facing) * dir * R * 0.45;
      const eyeR = R * (0.16 + 0.07 * facing) * (scareT >= 0 ? 1.3 : 1);
      for (const side of [-1, 1]) {
        if (facing < 0.4 && side === -dir) continue; // side-on: only the near eye shows
        ctx.beginPath();
        ctx.ellipse(cx + off + side * R * 0.38 * Math.max(0.4, facing), top + R * 0.95 + bob * 0, eyeR, eyeR * 1.45, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      const mouthOpen = scareT >= 0 ? 1 : 0.5 + 0.2 * Math.sin(t * 2.3);
      ctx.beginPath();
      ctx.ellipse(cx + off * 1.1, top + R * 1.55, R * 0.16 * Math.max(0.5, facing), R * 0.22 * mouthOpen, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },

    dispose() {},
  };
  return scene;
}
