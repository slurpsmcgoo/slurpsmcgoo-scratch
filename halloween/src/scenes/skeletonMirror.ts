// Skeleton Mirror: dresses each tracked person as a cute Halloween creature
// drawn over their 33 body points, like a magic mirror. The first person is a
// skeleton, the next a mummy, then a ghost, then a stitched-together monster
// (order set by `forms` in show.json). With nobody there, a lone creature
// dances from hand-made keyframes, changing costume every few seconds.
//
// High-contrast mode (`highContrast`, key T) is for a thin or translucent
// screen such as a shower curtain: everyone is a skeleton in pure white with
// thicker bones, and there is no glow, disco ball, lasers or light spots, since
// any haze spreads through the curtain and washes out the bones.
//
// With music on the porch, a disco ball and laser show move to the beat
// behind the creatures (never over them), and the idle dancer dances in time.
//
// Creatures stay on screen for as long as their person is there. On a scare
// they react in place: skeletons and mummies rattle, ghosts puff up with a
// BOO, and monsters get zapped. When a person leaves, their skeleton falls
// into a pile of bones (a mummy unravels, leaving its eyes hanging in the air)
// that fades after a few seconds; ghosts and monsters fade away. Needs full pose. This is the most latency-sensitive scene: main.ts
// runs perception at the camera's full frame rate while it is active.

import type { AudienceState, DirectorContext, DirectorState, Landmark, Scene, SceneContext } from '../types.ts';
import { BONES, LM, approach, bool, easeInOutSine, lerp, makeRng, num, str, withAlpha } from '../render/helpers.ts';
import { DiscoLights, type DiscoOptions } from './parts/disco.ts';
import { FORMS, blink, drawBones, drawCreature, drawSkull, girdles, headOf, type Form, type P, type Palette } from './parts/creatures.ts';

interface Piece {
  kind: 'bone' | 'skull' | 'strip' | 'eyes';
  x: number;
  y: number;
  vx: number;
  vy: number;
  a: number;   // angle
  av: number;  // angular velocity
  len: number; // bone/strip length, or skull/eye radius
  w: number;
  seed: number;
}

interface Body {
  id: number;
  pts: P[];
  form: Form;
  seed: number;
  alpha: number;
  staleS: number;          // how long since this person's pose last updated
  lastLm: Landmark[] | null;
}

// Dance keyframes: torso lean and hip offset (fractions of height), then limb
// angles in radians from straight down, positive = outward. [upper, lower bend].
interface Key { lean: number; hipX: number; hipY: number; la: [number, number]; ra: [number, number]; ll: [number, number]; rl: [number, number] }
const DANCE: Key[] = [
  { lean: 0.0, hipX: -0.02, hipY: 0.0, la: [2.6, 0.3], ra: [0.5, -1.2], ll: [0.12, 0], rl: [0.55, 0.7] },
  { lean: 0.06, hipX: 0.0, hipY: 0.035, la: [0.7, 1.4], ra: [0.7, 1.4], ll: [0.25, 0.45], rl: [0.25, 0.45] },
  { lean: 0.0, hipX: 0.02, hipY: 0.0, la: [0.5, -1.2], ra: [2.6, 0.3], ll: [0.55, 0.7], rl: [0.12, 0] },
  { lean: -0.06, hipX: 0.0, hipY: 0.035, la: [1.3, 1.6], ra: [1.3, 1.6], ll: [0.25, 0.45], rl: [0.25, 0.45] },
];

/** Forms made of parts that can fall apart when their person leaves. */
const fallsApart = (f: Form) => f === 'skeleton' || f === 'mummy';

export function createSkeletonMirror(): Scene {
  let cfg: Record<string, unknown> = {};
  let t = 0;
  const bodies = new Map<number, Body>();
  let danceAlpha = 1;
  // One pile per person who left: falling pieces that fade after a while.
  let piles: { born: number; pieces: Piece[] }[] = [];
  let state: DirectorState = 'idle';
  let scareT = -1;
  let intensity: DirectorContext['intensity'] = 'normal';
  let shiver = 0;
  const rng = makeRng(13);
  const disco = new DiscoLights();
  // Bodies are drawn sharp onto this layer, then composited with a single
  // glow pass; per-shape shadowBlur was too slow with four people on screen.
  let layer: HTMLCanvasElement | null = null;
  let lctx: CanvasRenderingContext2D | null = null;

  // Canvas size, set in init (1920x1080, or 1080x1920 in portrait).
  let cw = 1920;
  let ch = 1080;

  /**
   * Pose to canvas pixels. Landmarks are relative to the camera's active area,
   * which always has the window's proportions (see perception.activeArea), so
   * this is a straight scale with nobody stretched.
   */
  function toCanvas(lm: Landmark[]): P[] {
    return lm.map((p) => ({ x: p.x * cw, y: p.y * ch, v: p.visibility }));
  }

  /** Floor line for the dancer and fallen pieces. */
  const floorY = () => ch - num(cfg, 'floorMarginPx');

  const highContrast = () => bool(cfg, 'highContrast');
  /** Bone width, thicker in high-contrast mode. */
  const boneWidth = () => num(cfg, 'boneWidth') * (highContrast() ? num(cfg, 'contrastBoneScale') : 1);
  const discoOn = () => bool(cfg, 'disco') && !highContrast();

  /** Costume order, e.g. "skeleton,mummy,ghost,monster". Unknown names are ignored. Only skeletons in high-contrast mode. */
  function formOrder(): Form[] {
    if (highContrast()) return ['skeleton'];
    const list = str(cfg, 'forms').split(',').map((s) => s.trim()).filter((s): s is Form => (FORMS as readonly string[]).includes(s));
    return list.length ? list : ['skeleton'];
  }

  /** The first costume in the order that nobody is wearing; if all are taken, the least worn. */
  function pickForm(): Form {
    const order = formOrder();
    const worn = order.map((f) => [...bodies.values()].filter((b) => b.form === f).length);
    let best = 0;
    for (let i = 1; i < order.length; i++) if (worn[i]! < worn[best]!) best = i;
    return order[best]!;
  }

  function dancerForm(): Form {
    const order = formOrder();
    return order[Math.floor(t / num(cfg, 'idleFormCycleS')) % order.length]!;
  }

  /** Fades the dancer out and back in around each costume change. */
  function dancerSwapFade(): number {
    if (formOrder().length < 2) return 1; // only one costume: nothing to change into
    const cycle = num(cfg, 'idleFormCycleS');
    const ph = t % cycle;
    return Math.min(1, Math.min(ph, cycle - ph) / 0.35);
  }

  function dancePose(): P[] {
    // idleHeight is for a 1080-tall canvas; scale with the canvas, but keep the dancer narrower than it.
    const H = Math.min((num(cfg, 'idleHeight') * ch) / 1080, cw * 1.6);
    // One keyframe per beat: on the music's beat when it's playing.
    const beat = disco.playing ? disco.pos : (t * num(cfg, 'danceBpm')) / 60;
    const n = DANCE.length;
    const i = ((Math.floor(beat) % n) + n) % n; // the music's beat clock can be just below zero
    const a = DANCE[i]!;
    const b = DANCE[(i + 1) % n]!;
    const k = easeInOutSine(beat - Math.floor(beat));
    const m = (x: number, y: number) => lerp(x, y, k);
    const floor = floorY();
    const thigh = 0.245 * H;
    const shin = 0.245 * H;
    const hip = { x: cw / 2 + m(a.hipX, b.hipX) * H, y: floor - thigh - shin - 0.02 * H + m(a.hipY, b.hipY) * H };
    const lean = m(a.lean, b.lean);
    const torso = 0.3 * H;
    const sc = { x: hip.x + Math.sin(lean) * torso, y: hip.y - Math.cos(lean) * torso };
    const out: P[] = Array.from({ length: 33 }, () => ({ x: hip.x, y: hip.y, v: 0 }));
    const set = (idx: number, x: number, y: number) => (out[idx] = { x, y, v: 1 });
    const limb = (root: { x: number; y: number }, side: number, a1: number, a2: number, l1: number, l2: number, i1: number, i2: number) => {
      const j1 = { x: root.x + side * Math.sin(a1) * l1, y: root.y + Math.cos(a1) * l1 };
      const j2 = { x: j1.x + side * Math.sin(a1 + a2) * l2, y: j1.y + Math.cos(a1 + a2) * l2 };
      set(i1, j1.x, j1.y);
      set(i2, j2.x, j2.y);
      return j2;
    };
    const sw = 0.11 * H;
    const hw = 0.06 * H;
    set(LM.leftShoulder, sc.x - sw, sc.y);
    set(LM.rightShoulder, sc.x + sw, sc.y);
    set(LM.leftHip, hip.x - hw, hip.y);
    set(LM.rightHip, hip.x + hw, hip.y);
    limb(out[LM.leftShoulder]!, -1, m(a.la[0], b.la[0]), m(a.la[1], b.la[1]), 0.17 * H, 0.16 * H, LM.leftElbow, LM.leftWrist);
    limb(out[LM.rightShoulder]!, 1, m(a.ra[0], b.ra[0]), m(a.ra[1], b.ra[1]), 0.17 * H, 0.16 * H, LM.rightElbow, LM.rightWrist);
    const lf = limb(out[LM.leftHip]!, -1, m(a.ll[0], b.ll[0]), -m(a.ll[1], b.ll[1]), thigh, shin, LM.leftKnee, LM.leftAnkle);
    const rf = limb(out[LM.rightHip]!, 1, m(a.rl[0], b.rl[0]), -m(a.rl[1], b.rl[1]), thigh, shin, LM.rightKnee, LM.rightAnkle);
    set(LM.leftFoot, lf.x - 0.05 * H, lf.y + 0.01 * H);
    set(LM.rightFoot, rf.x + 0.05 * H, rf.y + 0.01 * H);
    const bob = Math.sin(beat * Math.PI * 2) * 0.01 * H;
    set(LM.nose, sc.x + Math.sin(lean) * 0.12 * H, sc.y - 0.11 * H + bob);
    set(LM.leftEar, out[LM.nose]!.x - 0.04 * H, out[LM.nose]!.y);
    set(LM.rightEar, out[LM.nose]!.x + 0.04 * H, out[LM.nose]!.y);
    return out;
  }

  /** Breaks a body into falling pieces: bones and a skull, or bandage strips and a pair of floating eyes. */
  function fallApart(pts: P[], form: Form, seed: number): Piece[] {
    const pieces: Piece[] = [];
    const bw = boneWidth();
    const g = girdles(pts);
    const kind = form === 'mummy' ? 'strip' : 'bone';
    const w = form === 'mummy' && g ? Math.max(bw * 1.6, g.shoulderW * 0.3) * 0.45 : bw;
    const add = (a: P, b: P) => {
      if (a.v < 0.3 || b.v < 0.3) return;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 4) return;
      pieces.push({
        kind, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
        vx: (rng() - 0.5) * 320, vy: -rng() * 380, a: Math.atan2(b.y - a.y, b.x - a.x), av: (rng() - 0.5) * 9, len, w, seed,
      });
    };
    for (const [i, j] of BONES) add(pts[i]!, pts[j]!);
    if (!g) return pieces;
    add(g.neck, g.pelvis);
    for (let r = 0; r < 4; r++) {
      const y = lerp(g.neck.y, g.pelvis.y, 0.18 + r * 0.14);
      const x = lerp(g.neck.x, g.pelvis.x, 0.18 + r * 0.14);
      const half = g.shoulderW * 0.42 * (1 - r * 0.1);
      add({ x: x - half, y: y + half * 0.25, v: 1 }, { x, y, v: 1 });
      add({ x, y, v: 1 }, { x: x + half, y: y + half * 0.25, v: 1 });
    }
    const head = headOf(pts, g);
    if (form === 'mummy') {
      // The eyes stay put, blinking, while the bandages drop away.
      pieces.push({ kind: 'eyes', x: head.x, y: head.y, vx: 0, vy: 0, a: 0, av: 0, len: head.r * 1.12, w, seed });
      for (let r = -2; r <= 2; r++) {
        const y = head.y + r * head.r * 0.35;
        add({ x: head.x - head.r, y, v: 1 }, { x: head.x + head.r, y: y + head.r * 0.1, v: 1 });
      }
    } else {
      pieces.push({ kind: 'skull', x: head.x, y: head.y, vx: (rng() - 0.5) * 200, vy: -200 - rng() * 200, a: 0, av: (rng() - 0.5) * 6, len: head.r, w: bw, seed });
    }
    return pieces;
  }

  function stepPieces(pieces: Piece[], dt: number): void {
    const g = num(cfg, 'gravity');
    const floor = floorY();
    const bounce = num(cfg, 'bounce');
    for (const p of pieces) {
      if (p.kind === 'eyes') continue;
      // Bandage strips flutter down slower than bones.
      const strip = p.kind === 'strip';
      p.vy += (strip ? g * 0.45 : g) * dt;
      if (strip) p.vx += Math.sin(t * 4 + p.seed + p.len) * 400 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.a += p.av * dt;
      const reach = p.kind === 'skull' ? p.len : Math.abs(Math.sin(p.a)) * p.len * 0.5 + p.w * 0.5;
      if (p.y + reach > floor) {
        p.y = floor - reach;
        if (Math.abs(p.vy) > 60 && !strip) p.vy = -p.vy * bounce;
        else p.vy = 0;
        p.vx *= 0.6;
        p.av *= 0.5;
        // Pieces settle lying down.
        if (p.kind !== 'skull' && Math.abs(p.vy) < 60) p.a = approach(p.a, Math.round(p.a / Math.PI) * Math.PI, dt, 0.15);
      }
    }
  }

  function palette(): Palette {
    return {
      bone: highContrast() ? '#ffffff' : str(cfg, 'boneColor'),
      bandage: str(cfg, 'bandageColor'),
      bandageShade: str(cfg, 'bandageShadeColor'),
      sheet: str(cfg, 'sheetColor'),
      blush: str(cfg, 'blushColor'),
      skin: str(cfg, 'skinColor'),
      hair: str(cfg, 'hairColor'),
      jacket: str(cfg, 'jacketColor'),
      trousers: str(cfg, 'trousersColor'),
      bolt: str(cfg, 'boltColor'),
      spark: str(cfg, 'sparkColor'),
    };
  }

  function discoOptions(): DiscoOptions {
    return {
      ballX: cw / 2,
      ballY: num(cfg, 'discoBallY'),
      ballRadius: num(cfg, 'discoBallRadius'),
      ballIdle: num(cfg, 'discoBallIdle'),
      colors: str(cfg, 'laserColors').split(',').map((c) => c.trim()).filter(Boolean),
      patternBars: num(cfg, 'laserPatternBars'),
      beamWidth: num(cfg, 'laserWidth'),
      beamAlpha: num(cfg, 'laserAlpha'),
      reflections: num(cfg, 'discoReflections'),
      reflectionAlpha: num(cfg, 'discoReflectionAlpha'),
    };
  }

  const scareProgress = () => (state === 'scare' && scareT >= 0 ? Math.min(1, (t - scareT) / Math.max(0.1, scene.scareDurationS)) : 0);

  function drawPile(ctx: CanvasRenderingContext2D, pieces: Piece[], alpha: number, pal: Palette, bw: number): void {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    const bones: [number, number, number, number][] = [];
    for (const p of pieces) {
      if (p.kind !== 'bone') continue;
      const dx = Math.cos(p.a) * p.len * 0.5;
      const dy = Math.sin(p.a) * p.len * 0.5;
      bones.push([p.x - dx, p.y - dy, p.x + dx, p.y + dy]);
    }
    ctx.strokeStyle = pal.bone;
    ctx.fillStyle = pal.bone;
    drawBones(ctx, bones, bw);
    ctx.strokeStyle = pal.bandage;
    ctx.lineCap = 'butt';
    for (const p of pieces) {
      if (p.kind !== 'strip') continue;
      const dx = Math.cos(p.a) * p.len * 0.5;
      const dy = Math.sin(p.a) * p.len * 0.5;
      ctx.lineWidth = p.w;
      ctx.beginPath();
      ctx.moveTo(p.x - dx, p.y - dy);
      ctx.lineTo(p.x + dx, p.y + dy);
      ctx.stroke();
    }
    for (const p of pieces) {
      if (p.kind === 'skull') drawSkull(ctx, p.x, p.y, p.len, p.a, pal.bone);
      else if (p.kind === 'eyes') {
        // Floating mummy eyes: white rims, black pupils that glance about.
        const open = Math.max(0.1, blink(t, p.seed));
        const look = Math.sin(t * 1.7 + p.seed) * p.len * 0.08;
        for (const s of [-1, 1]) {
          const ex = p.x + s * p.len * 0.38;
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.ellipse(ex, p.y, p.len * 0.22, p.len * 0.22 * open, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#000000';
          ctx.beginPath();
          ctx.ellipse(ex + look, p.y, p.len * 0.11, p.len * 0.11 * open, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  const scene: Scene = {
    id: 'skeletonMirror',
    title: 'Skeleton Mirror',
    requires: { pose: true },
    scareDurationS: 3.5,

    async init(sc: SceneContext) {
      cfg = sc.config;
      scene.scareDurationS = num(cfg, 'scareDurationS');
      layer = document.createElement('canvas');
      cw = sc.width;
      ch = sc.height;
      layer.width = cw;
      layer.height = ch;
      bodies.clear();
      piles = [];
      lctx = layer.getContext('2d');
    },

    update(dt: number, audience: AudienceState, director: DirectorContext) {
      t += dt;
      if (discoOn()) disco.update(dt, audience.music);
      state = director.state;
      intensity = director.intensity;
      const fade = num(cfg, 'fadeS');
      const staleFadeS = num(cfg, 'staleFadeS');

      // Follow the audience. A person whose pose stopped updating (the model
      // lost them; the tracker keeps them for a moment in case they come back)
      // dims while frozen, and comes back to full if they're found again.
      const seen = new Set<number>();
      for (const p of audience.people.slice(0, 4)) {
        seen.add(p.id);
        let b = bodies.get(p.id);
        if (b && !formOrder().includes(b.form)) b.form = pickForm(); // e.g. high-contrast mode switched on
        if (!b) {
          b = { id: p.id, pts: [], form: pickForm(), seed: p.id * 7.31, alpha: 0, staleS: 0, lastLm: null };
          bodies.set(p.id, b);
        }
        b.staleS = p.landmarks === b.lastLm ? b.staleS + dt : 0;
        b.lastLm = p.landmarks;
        b.pts = toCanvas(p.landmarks);
      }
      for (const b of bodies.values()) {
        if (!seen.has(b.id)) {
          // They left. Skeletons and mummies fall apart where they last stood;
          // ghosts and monsters fade away.
          if (fallsApart(b.form) && b.alpha > 0.3) {
            piles.push({ born: t, pieces: fallApart(b.pts, b.form, b.seed) });
            bodies.delete(b.id);
            continue;
          }
          b.alpha = approach(b.alpha, 0, dt, fade / 3);
          if (b.alpha < 0.01) bodies.delete(b.id);
          continue;
        }
        b.alpha = approach(b.alpha, b.staleS < staleFadeS ? 1 : num(cfg, 'staleAlpha'), dt, fade / 3);
      }

      const holdS = num(cfg, 'pileHoldS');
      const pileFadeS = num(cfg, 'pileFadeS');
      piles = piles.filter((p) => t - p.born < holdS + pileFadeS);
      for (const p of piles) stepPieces(p.pieces, dt);
      danceAlpha = approach(danceAlpha, seen.size === 0 && piles.length === 0 ? 1 : 0, dt, fade / 3);
      shiver = state === 'scare' && intensity === 'gentle' ? 1 : approach(shiver, 0, dt, 0.4);
    },

    onStateChange(_from: DirectorState, to: DirectorState) {
      if (to === 'scare') scareT = t;
    },

    render(sc: SceneContext) {
      if (!layer || !lctx) return;
      const ctx = lctx;
      const pal = palette();
      const glowC = str(cfg, 'glowColor');
      const bw = boneWidth();
      const minV = num(cfg, 'minVisibility');
      const glowBoost = 1 + shiver * (0.5 + 0.5 * Math.sin(t * 40));
      // Everyone reacts in place; gentle mode keeps them calm.
      const scare = intensity === 'gentle' ? 0 : scareProgress();
      ctx.clearRect(0, 0, layer.width, layer.height);
      if (discoOn()) disco.render(sc.ctx, sc.width, sc.height, discoOptions());

      const da = danceAlpha * dancerSwapFade();
      if (da > 0.01) drawCreature(ctx, dancerForm(), dancePose(), { t, alpha: da, width: bw * 1.1, minV: 0, scare }, pal, 3);
      for (const b of bodies.values()) {
        if (b.alpha <= 0.01) continue;
        // Skeletons and mummies rattle in place on a scare, easing off as it ends.
        const rattle = scare > 0 && fallsApart(b.form) ? num(cfg, 'rattlePx') * (1 - scare) : 0;
        const pts = rattle ? b.pts.map((q, i) => ({ x: q.x + Math.sin(t * 57 + i * 1.7) * rattle, y: q.y + Math.cos(t * 49 + i * 2.3) * rattle, v: q.v })) : b.pts;
        drawCreature(ctx, b.form, pts, { t, alpha: b.alpha, width: bw, minV, scare }, pal, b.seed);
      }
      const holdS = num(cfg, 'pileHoldS');
      const pileFadeS = num(cfg, 'pileFadeS');
      for (const p of piles) {
        const alpha = Math.max(0, Math.min(1, 1 - (t - p.born - holdS) / pileFadeS));
        if (alpha > 0.01) drawPile(ctx, p.pieces, alpha, pal, bw);
      }

      // One glow pass for everything on the layer (none in high-contrast mode: sharp white on black).
      sc.ctx.save();
      if (!highContrast()) {
        sc.ctx.shadowColor = withAlpha(glowC, Math.min(1, 0.8 * glowBoost));
        sc.ctx.shadowBlur = 22 * glowBoost;
      }
      sc.ctx.drawImage(layer, 0, 0);
      sc.ctx.restore();
    },

    dispose() {},
  };

  return scene;
}
