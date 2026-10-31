// Watching Eyes: darkness with the occasional blink from eyes at random spots.
// When someone is noticed, one pair snaps open; while engaged, more open. The
// pupils shift toward the focus person, then settle back to center (flat eyes
// looking straight out seem to look at every viewer, so the shift is a cue,
// not aim; `gazeSettle: false` keeps them tracking instead). On a scare every
// pair opens at once, then blackout. Needs the camera (presence only).

import type { AudienceState, DirectorContext, DirectorState, Scene, SceneContext } from '../types.ts';
import { approach, bool, clamp, makeRng, num, randRange, str, withAlpha } from '../render/helpers.ts';

interface Pair {
  x: number;
  y: number;
  w: number;       // width of one eye
  open: number;    // 0..1 current lid opening
  target: number;  // 0..1
  blinkIn: number; // seconds to next blink
  blinkT: number;  // -1, or seconds into a blink
  gaze: number;    // -1..1 pupil offset, current
  holdUntil: number;
}

export function createWatchingEyes(): Scene {
  let cfg: Record<string, unknown> = {};
  let pairs: Pair[] = [];
  let t = 0;
  let rng = makeRng(1);
  let state: DirectorState = 'idle';
  let intensity: DirectorContext['intensity'] = 'normal';
  let idleNext = 0;
  let idlePair = -1;
  let idleCloseAt = 0;
  let engagedNextOpen = 0;
  let scareT = -1;
  let focusX: number | null = null;
  let lastFocus: number | null = null;
  let gazeTarget = 0;
  let gazeLookUntil = 0;
  let nextRetarget = 0;

  // Canvas size, set in init (1920x1080, or 1080x1920 in portrait).
  let cw = 1920;
  let ch = 1080;

  function layout(): void {
    rng = makeRng(num(cfg, 'seed'));
    const n = Math.max(1, Math.round(num(cfg, 'pairs')));
    const w = num(cfg, 'eyeWidth');
    pairs = [{ x: cw / 2, y: ch * 0.435, w: num(cfg, 'mainEyeWidth'), open: 0, target: 0, blinkIn: 3, blinkT: -1, gaze: 0, holdUntil: 0 }];
    let tries = 0;
    while (pairs.length < n && tries++ < 500) {
      const pw = w * randRange(rng, 0.6, 1.15);
      const x = randRange(rng, 160, cw - 160);
      const y = randRange(rng, 140, ch - 140);
      const clear = pairs.every((p) => Math.abs(p.x - x) > (p.w + pw) * 1.5 || Math.abs(p.y - y) > (p.w + pw) * 0.75);
      if (clear) pairs.push({ x, y, w: pw, open: 0, target: 0, blinkIn: randRange(rng, 1, 5), blinkT: -1, gaze: 0, holdUntil: 0 });
    }
  }

  const scene: Scene = {
    id: 'watchingEyes',
    title: 'Watching Eyes',
    requires: { camera: true },
    scareDurationS: 2.2,

    async init(sc: SceneContext) {
      cfg = sc.config;
      scene.scareDurationS = num(cfg, 'scareDurationS');
      cw = sc.width;
      ch = sc.height;
      layout();
      idleNext = randRange(rng, num(cfg, 'idleOpenMinS'), num(cfg, 'idleOpenMaxS'));
    },

    update(dt: number, audience: AudienceState, director: DirectorContext) {
      t += dt;
      state = director.state;
      intensity = director.intensity;
      const focus = audience.people.find((p) => p.id === director.focusPersonId) ?? audience.nearest;
      focusX = focus ? focus.x : null;
      const main = pairs[0]!;

      // Lid targets by state.
      if (state === 'idle') {
        for (const p of pairs) p.target = 0;
        idleNext -= dt;
        if (idlePair < 0 && idleNext <= 0 && pairs.length > 1) {
          idlePair = 1 + Math.floor(rng() * (pairs.length - 1));
          idleCloseAt = t + num(cfg, 'idleOpenHoldS');
        }
        if (idlePair >= 0) {
          pairs[idlePair]!.target = 1;
          if (t >= idleCloseAt) {
            idlePair = -1;
            idleNext = randRange(rng, num(cfg, 'idleOpenMinS'), num(cfg, 'idleOpenMaxS'));
          }
        }
      } else if (state === 'noticed') {
        idlePair = -1;
        for (const p of pairs) p.target = 0;
        main.target = 1;
        engagedNextOpen = t + num(cfg, 'engagedOpenEveryS');
      } else if (state === 'engaged') {
        main.target = 1;
        const limit = Math.min(pairs.length, 1 + num(cfg, 'maxEngagedPairs') + audience.people.length - 1);
        const openCount = pairs.filter((p) => p.target > 0).length;
        if (t >= engagedNextOpen && openCount < limit) {
          const closed = pairs.filter((p) => p.target === 0);
          const pick = closed[Math.floor(rng() * closed.length)];
          if (pick) pick.target = 1;
          engagedNextOpen = t + num(cfg, 'engagedOpenEveryS');
        }
      } else if (state === 'scare') {
        const holding = scareT >= 0 && scareT < num(cfg, 'scareOpenS');
        for (const p of pairs) p.target = holding ? 1 : 0;
      } else {
        for (const p of pairs) p.target = 0;
      }
      if (scareT >= 0) scareT += dt;

      // Gaze: look toward the focus person when they appear or move, then settle.
      const settle = bool(cfg, 'gazeSettle');
      if (focus && (focus.id !== lastFocus || t >= nextRetarget)) {
        gazeLookUntil = t + num(cfg, 'gazeHoldS');
        nextRetarget = t + num(cfg, 'gazeRetargetS');
      }
      lastFocus = focus?.id ?? null;

      const openS = num(cfg, 'openS');
      const closeS = num(cfg, 'closeS');
      for (const p of pairs) {
        const snap = state === 'scare' ? openS * 0.4 : openS;
        p.open = approach(p.open, p.target, dt, (p.target > p.open ? snap : closeS) / 3);
        // Blinks while open.
        if (p.blinkT >= 0) {
          p.blinkT += dt;
          if (p.blinkT > num(cfg, 'blinkS')) p.blinkT = -1;
        } else if (p.open > 0.9 && state !== 'scare') {
          p.blinkIn -= dt;
          if (p.blinkIn <= 0) {
            p.blinkT = 0;
            p.blinkIn = randRange(rng, num(cfg, 'blinkMinS'), num(cfg, 'blinkMaxS'));
          }
        }
        const looking = focusX !== null && (!settle || t < gazeLookUntil);
        gazeTarget = looking ? clamp(((focusX! * cw - p.x) / cw) * 2 * num(cfg, 'gazeShift') * 2, -1, 1) : 0;
        p.gaze = approach(p.gaze, gazeTarget, dt, num(cfg, 'gazeEaseS'));
      }
    },

    onStateChange(_from: DirectorState, to: DirectorState) {
      scareT = to === 'scare' ? 0 : -1;
    },

    render(sc: SceneContext) {
      const { ctx } = sc;
      const iris = str(cfg, 'irisColor');
      const glowC = str(cfg, 'glowColor');
      const scaring = scareT >= 0 && state === 'scare';
      const flare = scaring ? Math.max(0, 1 - scareT / num(cfg, 'scareOpenS')) : 0;
      const gentle = intensity === 'gentle';
      for (const p of pairs) {
        const blink = p.blinkT >= 0 ? Math.abs(Math.cos((p.blinkT / num(cfg, 'blinkS')) * Math.PI)) : 1;
        const open = p.open * blink;
        if (open < 0.02) continue;
        const gap = p.w * num(cfg, 'pairGap') * 0.5;
        for (const side of [-1, 1]) {
          drawEye(ctx, p.x + side * gap, p.y, p.w, open, p.gaze, side, iris, glowC, scaring && !gentle ? flare : 0, num(cfg, 'scarePupilScale'));
        }
      }
    },

    dispose() {},
  };

  function drawEye(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number, w: number, open: number, gaze: number, side: number,
    iris: string, glowC: string, flare: number, scarePupil: number,
  ): void {
    const hw = w / 2;
    const hh = w * 0.32 * open;
    // Outer corners raised a little, for a menacing look.
    const lift = w * 0.1;
    const leftY = side < 0 ? cy - lift : cy;
    const rightY = side > 0 ? cy - lift : cy;
    const almond = () => {
      ctx.beginPath();
      ctx.moveTo(cx - hw, leftY);
      ctx.quadraticCurveTo(cx, cy - hh * 2 - lift * 0.5, cx + hw, rightY);
      ctx.quadraticCurveTo(cx, cy + hh * 2 - lift * 0.5, cx - hw, leftY);
      ctx.closePath();
    };
    ctx.save();
    ctx.shadowColor = withAlpha(glowC, 0.9);
    ctx.shadowBlur = 25 + 50 * flare;
    almond();
    const px = cx + gaze * hw * 0.45;
    const g = ctx.createRadialGradient(px, cy, 0, px, cy, hw * 1.05);
    g.addColorStop(0, withAlpha('#fff6c9', 0.9 + 0.1 * flare));
    g.addColorStop(0.25, iris);
    g.addColorStop(0.75, glowC);
    g.addColorStop(1, '#3a0d00');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    ctx.save();
    almond();
    ctx.clip();
    const pupilW = w * 0.07 * (1 + (scarePupil - 1) * flare);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(px, cy, pupilW, w * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  return scene;
}
