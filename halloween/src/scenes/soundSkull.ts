// Sound Skull: a faint skull with a slow breathing glow whose jaw follows the
// crowd's loudness, so it seems to talk along with them. A shout (or any
// scare) makes the eyes flare and the skull scream back. Needs only audio.

import type { AudienceState, DirectorContext, DirectorState, Scene, SceneContext } from '../types.ts';
import { approach, clamp, easeOutCubic, envelope, lerp, num, str, withAlpha } from '../render/helpers.ts';

export function createSoundSkull(): Scene {
  let cfg: Record<string, unknown> = {};
  let t = 0;
  let jaw = 0;          // 0..1, envelope-followed loudness
  let activity = 0;     // 0..1, how awake the skull is
  let eyes = 0;         // 0..1 eye glow
  let scareT = -1;      // seconds since the scare began, -1 when not screaming
  let intensity: DirectorContext['intensity'] = 'normal';
  let state: DirectorState = 'idle';

  const scene: Scene = {
    id: 'soundSkull',
    title: 'Sound Skull',
    requires: { audio: true },
    scareDurationS: 1.8,

    async init(sc: SceneContext) {
      cfg = sc.config;
      scene.scareDurationS = num(cfg, 'scareDurationS');
    },

    update(dt: number, audience: AudienceState, director: DirectorContext) {
      t += dt;
      state = director.state;
      intensity = director.intensity;
      const { levelDb, baselineDb } = audience.audio;
      const loud = clamp((levelDb - baselineDb) / num(cfg, 'jawDbRange'), 0, 1);

      if (scareT >= 0) {
        scareT += dt;
        jaw = envelope(jaw, 1, dt, num(cfg, 'attackS'), num(cfg, 'releaseS'));
        eyes = approach(eyes, 1, dt, 0.05);
        if (scareT > scene.scareDurationS) scareT = -1;
      } else {
        jaw = envelope(jaw, loud, dt, num(cfg, 'attackS'), num(cfg, 'releaseS'));
        const awake = state === 'noticed' || state === 'engaged' ? 0.6 : 0;
        activity = approach(activity, Math.max(awake, loud), dt, loud > activity ? 0.1 : 1.2);
        eyes = approach(eyes, state === 'engaged' ? 0.5 : state === 'noticed' ? 0.25 : 0, dt, 0.4);
      }
    },

    onStateChange(_from: DirectorState, to: DirectorState) {
      if (to === 'scare') scareT = 0;
    },

    render(sc: SceneContext) {
      const { ctx, width: w, height: h } = sc;
      const gentle = intensity === 'gentle';
      const screaming = scareT >= 0;
      const k = screaming ? easeOutCubic(Math.min(1, scareT / 0.25)) : 0;
      const scale = 1 + (num(cfg, 'screamScale') - 1) * k * (gentle ? 0.3 : 1);
      const shake = screaming && !gentle ? num(cfg, 'shakePx') * (1 - scareT / scene.scareDurationS) : 0;
      const breathe = 0.78 + 0.22 * Math.sin((t / num(cfg, 'breathPeriodS')) * Math.PI * 2);
      const idleGlow = num(cfg, 'idleGlow');
      const glowLevel = screaming ? 1 : lerp(idleGlow * breathe, num(cfg, 'activeGlow'), activity);
      const u = (num(cfg, 'size') / 10) * scale;
      const cx = w / 2 + Math.sin(t * 61) * shake;
      const cy = h * 0.42 + Math.cos(t * 47) * shake;
      const jy = jaw * num(cfg, 'jawMaxOpenPx') * scale;
      const bone = str(cfg, 'boneColor');
      const glowColor = str(cfg, 'glowColor');
      const eyeColor = str(cfg, 'eyeColor');

      // Scream rings pushed out from the mouth.
      if (screaming) {
        ctx.save();
        ctx.lineWidth = 10;
        for (let i = 0; i < 4; i++) {
          const age = scareT - i * 0.22;
          if (age <= 0) continue;
          const r = age * num(cfg, 'ringSpeed');
          ctx.strokeStyle = withAlpha(eyeColor, (gentle ? 0.25 : 0.6) * Math.max(0, 1 - r / (w * 0.6)));
          ctx.beginPath();
          ctx.arc(cx, cy + 4.6 * u + jy / 2, r, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }

      const boneFill = () => {
        const g = ctx.createRadialGradient(cx, cy - 2.5 * u, u, cx, cy, 7 * u);
        g.addColorStop(0, withAlpha(bone, glowLevel));
        g.addColorStop(1, withAlpha(bone, glowLevel * 0.45));
        return g;
      };

      ctx.save();
      ctx.shadowColor = withAlpha(glowColor, Math.min(1, glowLevel * 1.2));
      ctx.shadowBlur = 30 + 60 * glowLevel;
      ctx.fillStyle = boneFill();

      // Cranium and upper face.
      ctx.beginPath();
      ctx.moveTo(cx - 4.3 * u, cy + 1.0 * u);
      ctx.bezierCurveTo(cx - 4.9 * u, cy - 3.5 * u, cx - 2.6 * u, cy - 5.6 * u, cx, cy - 5.6 * u);
      ctx.bezierCurveTo(cx + 2.6 * u, cy - 5.6 * u, cx + 4.9 * u, cy - 3.5 * u, cx + 4.3 * u, cy + 1.0 * u);
      ctx.quadraticCurveTo(cx + 4.1 * u, cy + 2.4 * u, cx + 3.0 * u, cy + 2.8 * u);
      ctx.lineTo(cx + 2.4 * u, cy + 3.7 * u);
      ctx.lineTo(cx - 2.4 * u, cy + 3.7 * u);
      ctx.lineTo(cx - 3.0 * u, cy + 2.8 * u);
      ctx.quadraticCurveTo(cx - 4.1 * u, cy + 2.4 * u, cx - 4.3 * u, cy + 1.0 * u);
      ctx.closePath();
      ctx.fill();

      // Jaw, hinged near the cheekbones and dropped by loudness.
      ctx.beginPath();
      ctx.moveTo(cx - 3.3 * u, cy + 2.5 * u);
      ctx.lineTo(cx - 2.7 * u, cy + 4.1 * u + jy);
      ctx.quadraticCurveTo(cx - 2.3 * u, cy + 5.7 * u + jy, cx, cy + 5.8 * u + jy);
      ctx.quadraticCurveTo(cx + 2.3 * u, cy + 5.7 * u + jy, cx + 2.7 * u, cy + 4.1 * u + jy);
      ctx.lineTo(cx + 3.3 * u, cy + 2.5 * u);
      ctx.lineTo(cx + 2.9 * u, cy + 2.6 * u);
      ctx.lineTo(cx + 2.3 * u, cy + 3.9 * u + jy);
      ctx.lineTo(cx - 2.3 * u, cy + 3.9 * u + jy);
      ctx.lineTo(cx - 2.9 * u, cy + 2.6 * u);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Teeth: upper row fixed, lower row rides on the jaw.
      ctx.save();
      ctx.fillStyle = withAlpha(bone, Math.min(1, glowLevel * 1.15));
      ctx.strokeStyle = '#000';
      ctx.lineWidth = Math.max(2, u * 0.08);
      const teeth = 8;
      const tw = (4.4 * u) / teeth;
      for (let i = 0; i < teeth; i++) {
        const x = cx - 2.2 * u + i * tw;
        ctx.fillRect(x, cy + 3.6 * u, tw, 0.75 * u);
        ctx.strokeRect(x, cy + 3.6 * u, tw, 0.75 * u);
        ctx.fillRect(x, cy + 3.25 * u + jy, tw, 0.65 * u);
        ctx.strokeRect(x, cy + 3.25 * u + jy, tw, 0.65 * u);
      }
      ctx.restore();

      // Glowing throat when screaming.
      if (screaming && jy > 4) {
        ctx.save();
        const g = ctx.createRadialGradient(cx, cy + 4.3 * u + jy / 2, 0, cx, cy + 4.3 * u + jy / 2, 2.2 * u);
        g.addColorStop(0, withAlpha(eyeColor, gentle ? 0.35 : 0.8));
        g.addColorStop(1, withAlpha(eyeColor, 0));
        ctx.fillStyle = g;
        ctx.fillRect(cx - 2.2 * u, cy + 4.35 * u, 4.4 * u, Math.max(0, jy - 0.7 * u));
        ctx.restore();
      }

      // Eye sockets, nose and cracks cut into the bone.
      ctx.save();
      ctx.fillStyle = '#000';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(cx + side * 1.8 * u, cy + 0.6 * u, 1.3 * u, 1.1 * u, side * -0.18, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(cx, cy + 1.7 * u);
      ctx.lineTo(cx - 0.6 * u, cy + 2.8 * u);
      ctx.quadraticCurveTo(cx, cy + 2.5 * u, cx + 0.6 * u, cy + 2.8 * u);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = Math.max(2, u * 0.07);
      ctx.beginPath();
      ctx.moveTo(cx + 0.6 * u, cy - 5.5 * u);
      ctx.lineTo(cx + 1.0 * u, cy - 4.3 * u);
      ctx.lineTo(cx + 0.5 * u, cy - 3.6 * u);
      ctx.lineTo(cx + 1.1 * u, cy - 2.6 * u);
      ctx.moveTo(cx - 3.9 * u, cy - 2.0 * u);
      ctx.lineTo(cx - 3.1 * u, cy - 1.6 * u);
      ctx.lineTo(cx - 3.3 * u, cy - 0.9 * u);
      ctx.stroke();
      ctx.restore();

      // Eyes: embers in the sockets that flare on a scream.
      const eyeLevel = eyes * (gentle ? 0.6 : 1);
      if (eyeLevel > 0.01) {
        ctx.save();
        ctx.shadowColor = eyeColor;
        ctx.shadowBlur = 20 + 70 * eyeLevel;
        for (const side of [-1, 1]) {
          const ex = cx + side * 1.75 * u;
          const ey = cy + 0.7 * u;
          const r = u * (0.25 + 0.45 * eyeLevel * (screaming ? 1.4 : 1));
          const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, r);
          g.addColorStop(0, withAlpha('#fff3c4', eyeLevel));
          g.addColorStop(0.35, withAlpha(eyeColor, eyeLevel));
          g.addColorStop(1, withAlpha(eyeColor, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(ex, ey, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    },

    dispose() {},
  };
  return scene;
}
