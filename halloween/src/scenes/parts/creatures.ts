// Cute Halloween bodies drawn over a 33-point pose: a skeleton, a mummy, a
// sheet ghost and a stitched-together monster. Shared by Skeleton Mirror; any
// scene may use them. Every function draws in canvas pixels and takes the
// pose already converted to canvas coordinates.

import { BONES, LM, clamp, lerp } from '../../render/helpers.ts';

export type P = { x: number; y: number; v: number };
export type Form = 'skeleton' | 'mummy' | 'ghost' | 'monster';
export const FORMS: readonly Form[] = ['skeleton', 'mummy', 'ghost', 'monster'];

export interface Palette {
  bone: string;
  bandage: string;
  bandageShade: string;
  sheet: string;
  blush: string;
  skin: string;
  hair: string;
  jacket: string;
  trousers: string;
  bolt: string;
  spark: string;
}

/** What a creature is doing besides following its person. */
export interface Pose2 {
  t: number;      // scene time, seconds, for idle wiggles
  alpha: number;
  width: number;  // base stroke width (bone width)
  minV: number;   // landmarks below this visibility are not drawn
  scare: number;  // 0 = calm, 0..1 = progress through a scare reaction, for forms that react in place
}

type Seg = [number, number, number, number];

const ARMS: [number, number][] = [[LM.leftShoulder, LM.leftElbow], [LM.leftElbow, LM.leftWrist], [LM.rightShoulder, LM.rightElbow], [LM.rightElbow, LM.rightWrist]];
const LEGS: [number, number][] = [[LM.leftHip, LM.leftKnee], [LM.leftKnee, LM.leftAnkle], [LM.rightHip, LM.rightKnee], [LM.rightKnee, LM.rightAnkle]];

export function girdles(pts: P[]) {
  const ls = pts[LM.leftShoulder]!;
  const rs = pts[LM.rightShoulder]!;
  const lh = pts[LM.leftHip]!;
  const rh = pts[LM.rightHip]!;
  if (Math.min(ls.v, rs.v) < 0.3) return null;
  const neck = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2, v: 1 };
  const hipsOk = Math.min(lh.v, rh.v) >= 0.3;
  const shoulderW = Math.max(20, Math.hypot(rs.x - ls.x, rs.y - ls.y));
  const pelvis = hipsOk ? { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2, v: 1 } : { x: neck.x, y: neck.y + shoulderW * 1.4, v: 0.5 };
  return { neck, pelvis, shoulderW, hipsOk };
}
export type Girdles = NonNullable<ReturnType<typeof girdles>>;

export function headOf(pts: P[], g: Girdles) {
  const nose = pts[LM.nose]!;
  const le = pts[LM.leftEar]!;
  const re = pts[LM.rightEar]!;
  const earW = le.v > 0.3 && re.v > 0.3 ? Math.hypot(re.x - le.x, re.y - le.y) : 0;
  const r = Math.max(18, Math.max(earW * 0.8, g.shoulderW * 0.33));
  if (nose.v >= 0.3) return { x: nose.x, y: nose.y - r * 0.25, r };
  return { x: g.neck.x, y: g.neck.y - r * 1.4, r };
}

const visible = (minV: number) => (p: P | undefined): p is P => !!p && p.v >= minV;

function segments(pts: P[], pairs: [number, number][], minV: number): Seg[] {
  const ok = visible(minV);
  const out: Seg[] = [];
  for (const [i, j] of pairs) {
    const a = pts[i];
    const b = pts[j];
    if (ok(a) && ok(b)) out.push([a.x, a.y, b.x, b.y]);
  }
  return out;
}

function strokeSegs(ctx: CanvasRenderingContext2D, segs: Seg[], width: number, color: string): void {
  if (!segs.length) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of segs) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
}

/** Big round cartoon eyes with a highlight. `open` 0..1 squashes them shut. */
function eyes(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, spread: number, open: number, white: boolean): void {
  for (const s of [-1, 1]) {
    const ex = x + s * spread;
    if (white) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(ex, y, r * 1.35, r * 1.35 * Math.max(0.12, open), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.ellipse(ex, y, r, r * Math.max(0.1, open), 0, 0, Math.PI * 2);
    ctx.fill();
    if (open > 0.4) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex - r * 0.3, y - r * 0.35 * open, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Slow blinks: mostly open, shut for ~0.12 s every few seconds, offset per creature. */
export function blink(t: number, seed: number): number {
  const period = 3.2 + (seed % 5) * 0.37;
  const ph = (t + seed * 1.7) % period;
  return ph < 0.12 ? Math.abs(ph - 0.06) / 0.06 : 1;
}

// ---------------------------------------------------------------- skeleton

/** Bone shafts with knobbly ends, batched into one stroked and one filled path. */
export function drawBones(ctx: CanvasRenderingContext2D, segs: Seg[], w: number): void {
  if (segs.length === 0) return;
  ctx.lineWidth = w;
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of segs) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
  ctx.beginPath();
  const r = w * 0.55;
  for (const [x1, y1, x2, y2] of segs) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    const nx = -Math.sin(a) * w * 0.38;
    const ny = Math.cos(a) * w * 0.38;
    for (const [x, y] of [[x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny]]) {
      ctx.moveTo(x! + r, y!);
      ctx.arc(x!, y!, r, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}

export function drawSkull(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, a: number, bone: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.fillStyle = bone;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.9, r, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(-r * 0.45, r * 0.6, r * 0.9, r * 0.55);
  ctx.fillStyle = '#000';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(s * r * 0.36, r * 0.1, r * 0.25, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(0, r * 0.38);
  ctx.lineTo(-r * 0.1, r * 0.58);
  ctx.lineTo(r * 0.1, r * 0.58);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.06);
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  for (let i = -2; i <= 2; i++) {
    ctx.moveTo(i * r * 0.15, r * 0.75);
    ctx.lineTo(i * r * 0.15, r * 1.12);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawSkeleton(ctx: CanvasRenderingContext2D, pts: P[], o: Pose2, pal: Palette): void {
  const bw = o.width;
  ctx.save();
  ctx.globalAlpha = o.alpha;
  ctx.strokeStyle = pal.bone;
  ctx.fillStyle = pal.bone;
  ctx.lineCap = 'round';
  const ok = visible(o.minV);
  const pairs = BONES.filter(([i, j]) => !(i === LM.leftShoulder && j === LM.rightShoulder) && !(i === LM.leftHip && j === LM.rightHip));
  drawBones(ctx, segments(pts, pairs, o.minV), bw);

  const g = girdles(pts);
  if (g) {
    const ls = pts[LM.leftShoulder]!;
    const rs = pts[LM.rightShoulder]!;
    ctx.lineWidth = bw * 0.7;
    ctx.beginPath();
    ctx.moveTo(ls.x, ls.y);
    ctx.quadraticCurveTo(g.neck.x, g.neck.y + bw, rs.x, rs.y);
    ctx.stroke();
    ctx.lineWidth = bw * 0.8;
    ctx.setLineDash([bw * 0.9, bw * 0.45]);
    ctx.beginPath();
    ctx.moveTo(g.neck.x, g.neck.y);
    ctx.lineTo(g.pelvis.x, g.pelvis.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = bw * 0.5;
    ctx.beginPath();
    for (let r = 0; r < 5; r++) {
      const k = 0.14 + r * 0.11;
      const sx = lerp(g.neck.x, g.pelvis.x, k);
      const sy = lerp(g.neck.y, g.pelvis.y, k);
      const half = g.shoulderW * 0.46 * (1 - r * 0.09);
      ctx.moveTo(sx - half, sy + half * 0.35);
      ctx.quadraticCurveTo(sx - half * 0.9, sy - half * 0.12, sx, sy);
      ctx.quadraticCurveTo(sx + half * 0.9, sy - half * 0.12, sx + half, sy + half * 0.35);
    }
    ctx.stroke();
    if (g.hipsOk) {
      const lh = pts[LM.leftHip]!;
      const rh = pts[LM.rightHip]!;
      const pw = Math.max(bw * 2, Math.hypot(rh.x - lh.x, rh.y - lh.y));
      ctx.lineWidth = bw * 0.7;
      ctx.beginPath();
      for (const s of [-1, 1]) {
        const cx = g.pelvis.x + s * pw * 0.35;
        const cy = g.pelvis.y - pw * 0.1;
        ctx.moveTo(cx + pw * 0.42 * Math.cos(s * 0.4), cy + pw * 0.42 * Math.sin(s * 0.4));
        ctx.ellipse(cx, cy, pw * 0.42, pw * 0.3, s * 0.4, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
    ctx.beginPath();
    for (const w of [LM.leftWrist, LM.rightWrist]) {
      const p = pts[w];
      if (!ok(p)) continue;
      ctx.moveTo(p.x + bw * 0.9, p.y);
      ctx.arc(p.x, p.y, bw * 0.9, 0, Math.PI * 2);
    }
    ctx.fill();
    const head = headOf(pts, g);
    drawSkull(ctx, head.x, head.y, head.r, 0, pal.bone);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- mummy

/** Diagonal wrap marks across a thick limb segment, added to the current path. */
function wraps(ctx: CanvasRenderingContext2D, [x1, y1, x2, y2]: Seg, w: number, gap: number): void {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1) return;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const nx = -uy;
  const ny = ux;
  const half = w * 0.5;
  for (let d = gap * 0.5; d < len; d += gap) {
    const cx = x1 + ux * d;
    const cy = y1 + uy * d;
    ctx.moveTo(cx - nx * half - ux * gap * 0.35, cy - ny * half - uy * gap * 0.35);
    ctx.lineTo(cx + nx * half + ux * gap * 0.35, cy + ny * half + uy * gap * 0.35);
  }
}

export function drawMummy(ctx: CanvasRenderingContext2D, pts: P[], o: Pose2, pal: Palette, seed: number): void {
  const g = girdles(pts);
  if (!g) return;
  const s = g.shoulderW;
  const limbW = Math.max(o.width * 1.6, s * 0.3);
  ctx.save();
  ctx.globalAlpha = o.alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Torso: a bandaged barrel from shoulders to hips.
  const tw = s * 0.62;
  const top = g.neck.y + s * 0.05;
  const bot = g.pelvis.y + s * 0.12;
  ctx.fillStyle = pal.bandage;
  ctx.beginPath();
  ctx.moveTo(g.neck.x - tw, top);
  ctx.quadraticCurveTo(g.neck.x - tw * 1.12, (top + bot) / 2, g.pelvis.x - tw * 0.9, bot);
  ctx.lineTo(g.pelvis.x + tw * 0.9, bot);
  ctx.quadraticCurveTo(g.neck.x + tw * 1.12, (top + bot) / 2, g.neck.x + tw, top);
  ctx.closePath();
  ctx.fill();

  const limbs = [...segments(pts, LEGS, o.minV), ...segments(pts, ARMS, o.minV)];
  strokeSegs(ctx, limbs, limbW, pal.bandage);

  // Wrap marks over everything.
  ctx.strokeStyle = pal.bandageShade;
  ctx.lineWidth = Math.max(1.5, limbW * 0.09);
  ctx.beginPath();
  for (const seg of limbs) wraps(ctx, seg, limbW, limbW * 0.62);
  for (let y = top + s * 0.14; y < bot - s * 0.05; y += s * 0.2) {
    const k = (y - top) / (bot - top);
    const cx = lerp(g.neck.x, g.pelvis.x, k);
    const half = tw * (1.02 - Math.abs(k - 0.5) * 0.25);
    ctx.moveTo(cx - half, y + s * 0.06);
    ctx.lineTo(cx + half, y - s * 0.06);
  }
  ctx.stroke();

  // Head: a round wrapped bundle with a gap for big eyes.
  const head = headOf(pts, g);
  const r = head.r * 1.12;
  ctx.fillStyle = pal.bandage;
  ctx.beginPath();
  ctx.arc(head.x, head.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(head.x, head.y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.strokeStyle = pal.bandageShade;
  ctx.lineWidth = Math.max(1.5, r * 0.06);
  ctx.beginPath();
  for (let i = -3; i <= 3; i++) {
    if (i === 0) continue; // the eye gap
    const y = head.y + i * r * 0.28;
    ctx.moveTo(head.x - r, y + r * 0.08 * (i % 2 ? 1 : -1));
    ctx.lineTo(head.x + r, y - r * 0.08 * (i % 2 ? 1 : -1));
  }
  ctx.stroke();
  ctx.fillStyle = '#000';
  ctx.fillRect(head.x - r, head.y - r * 0.16, r * 2, r * 0.36);
  ctx.restore();
  eyes(ctx, head.x, head.y + r * 0.02, r * 0.16, r * 0.38, blink(o.t, seed), true);
  ctx.restore();
}

// ---------------------------------------------------------------- ghost

export function drawGhost(ctx: CanvasRenderingContext2D, pts: P[], o: Pose2, pal: Palette, seed: number): void {
  const g = girdles(pts);
  if (!g) return;
  const s = g.shoulderW;
  const head = headOf(pts, g);
  const ok = visible(o.minV);
  // A "BOO!" puffs the sheet up and opens the mouth wide.
  const puff = o.scare > 0 ? Math.sin(Math.min(1, o.scare * 2.5) * Math.PI * 0.5) * (1 - Math.max(0, o.scare - 0.7) / 0.3) : 0;
  const grow = 1 + puff * 0.35;
  const bob = Math.sin(o.t * 2.2 + seed) * s * 0.05;
  const cx = head.x;
  const cy = head.y + bob;
  const r = head.r * 1.35 * grow;

  // Hem: below the hips, or the knees if they're visible.
  const knees = [pts[LM.leftKnee]!, pts[LM.rightKnee]!].filter(ok);
  const hemY = (knees.length ? knees.reduce((a, p) => a + p.y, 0) / knees.length : g.pelvis.y + s * 0.9) + bob;
  const hemHalf = s * 0.95 * grow;
  const hemX = g.pelvis.x;

  ctx.save();
  ctx.globalAlpha = o.alpha * 0.92;
  ctx.fillStyle = pal.sheet;
  ctx.lineCap = 'round';

  // Arm nubs reach toward the wrists, short and stubby.
  const nubs: Seg[] = [];
  for (const [sh, wr] of [[LM.leftShoulder, LM.leftWrist], [LM.rightShoulder, LM.rightWrist]] as const) {
    const a = pts[sh]!;
    const b = pts[wr]!;
    if (!ok(a) || !ok(b)) continue;
    nubs.push([a.x, a.y + bob, lerp(a.x, b.x, 0.75), lerp(a.y, b.y, 0.75) + bob]);
  }
  strokeSegs(ctx, nubs, s * 0.42 * grow, pal.sheet);

  // Sheet: dome over the head, flaring to a wavy hem.
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.arc(cx, cy, r, Math.PI, 0);
  ctx.bezierCurveTo(cx + r * 1.05, cy + (hemY - cy) * 0.45, hemX + hemHalf * 0.95, hemY - s * 0.3, hemX + hemHalf, hemY);
  const scallops = 5;
  for (let i = 0; i < scallops; i++) {
    const x0 = hemX + hemHalf - (i * 2 * hemHalf) / scallops;
    const x1 = x0 - (2 * hemHalf) / scallops;
    const dip = s * (0.16 + 0.06 * Math.sin(o.t * 3 + i * 1.3 + seed));
    ctx.quadraticCurveTo((x0 + x1) / 2, hemY + dip * (i % 2 ? 0.4 : 1.4), x1, hemY);
  }
  ctx.bezierCurveTo(hemX - hemHalf * 0.95, hemY - s * 0.3, cx - r * 1.05, cy + (hemY - cy) * 0.45, cx - r, cy);
  ctx.closePath();
  ctx.fill();

  // Face: tall eyes, rosy cheeks, a little "o" mouth (wide open on BOO).
  ctx.globalAlpha = o.alpha;
  const er = r * 0.17;
  const open = puff > 0.2 ? 1 : blink(o.t, seed);
  for (const sx of [-1, 1]) {
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(cx + sx * r * 0.36, cy - r * 0.02, er, er * 1.45 * Math.max(0.12, open), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = pal.blush;
    ctx.beginPath();
    ctx.ellipse(cx + sx * r * 0.62, cy + r * 0.32, r * 0.14, r * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.42, r * (0.09 + puff * 0.14), r * (0.11 + puff * 0.26), 0, 0, Math.PI * 2);
  ctx.fill();
  if (puff > 0.05) {
    ctx.globalAlpha = o.alpha * clamp(puff * 1.5, 0, 1);
    ctx.fillStyle = pal.sheet;
    ctx.font = `bold ${Math.round(r * 0.8)}px ui-rounded, "Comic Sans MS", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('BOO!', cx + r * 1.9, cy - r * 0.9 - puff * r * 0.3);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- monster

export function drawMonster(ctx: CanvasRenderingContext2D, pts: P[], o: Pose2, pal: Palette, seed: number): void {
  const g = girdles(pts);
  if (!g) return;
  const s = g.shoulderW;
  const ok = visible(o.minV);
  // A zap makes him buzz in place and stand his hair on end.
  const zap = o.scare > 0 && o.scare < 0.85 ? 1 : 0;
  const jx = zap ? Math.sin(o.t * 90) * s * 0.03 : 0;
  const shift = (p: P): P => ({ x: p.x + jx, y: p.y, v: p.v });
  const q = zap ? pts.map(shift) : pts;
  const limbW = Math.max(o.width * 1.7, s * 0.3);
  ctx.save();
  ctx.globalAlpha = o.alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Legs and big boots.
  strokeSegs(ctx, segments(q, LEGS, o.minV), limbW * 1.05, pal.trousers);
  ctx.fillStyle = pal.bolt;
  for (const a of [LM.leftAnkle, LM.rightAnkle]) {
    const p = q[a]!;
    if (!ok(p)) continue;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + limbW * 0.3, limbW * 0.85, limbW * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Jacket: shoulders a bit wider than the person's, square at the hem.
  const nx = g.neck.x + jx;
  const px = g.pelvis.x + jx;
  const sw = s * 0.66;
  ctx.fillStyle = pal.jacket;
  ctx.beginPath();
  ctx.moveTo(nx - sw, g.neck.y - s * 0.04);
  ctx.lineTo(nx + sw, g.neck.y - s * 0.04);
  ctx.lineTo(px + sw * 0.85, g.pelvis.y + s * 0.18);
  ctx.lineTo(px - sw * 0.85, g.pelvis.y + s * 0.18);
  ctx.closePath();
  ctx.fill();
  // Patch with stitches.
  ctx.strokeStyle = pal.skin;
  ctx.lineWidth = Math.max(1.5, s * 0.025);
  const pcx = lerp(nx, px, 0.55) + sw * 0.35;
  const pcy = lerp(g.neck.y, g.pelvis.y, 0.55);
  ctx.strokeRect(pcx - s * 0.12, pcy - s * 0.1, s * 0.24, s * 0.2);

  // Sleeves, then green hands.
  strokeSegs(ctx, segments(q, ARMS, o.minV), limbW, pal.jacket);
  ctx.fillStyle = pal.skin;
  for (const w of [LM.leftWrist, LM.rightWrist]) {
    const p = q[w]!;
    if (!ok(p)) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, limbW * 0.62, 0, Math.PI * 2);
    ctx.fill();
  }

  // Head: a tall rounded block with flat-top hair, bolts and a stitch.
  const head = headOf(q, g);
  const hw = head.r * 1.05;
  const hh = head.r * 1.25;
  const hx = head.x;
  const hy = head.y + head.r * 0.05;
  ctx.fillStyle = pal.bolt;
  ctx.fillRect(hx - hw - hw * 0.28, hy + hh * 0.15, hw * 0.3, hh * 0.24);
  ctx.fillRect(hx + hw - hw * 0.02, hy + hh * 0.15, hw * 0.3, hh * 0.24);
  ctx.fillStyle = pal.skin;
  ctx.beginPath();
  ctx.roundRect(hx - hw, hy - hh, hw * 2, hh * 2, hw * 0.45);
  ctx.fill();
  ctx.fillStyle = pal.hair;
  ctx.beginPath();
  if (zap) {
    // Spiky, standing straight up.
    ctx.moveTo(hx - hw, hy - hh * 0.55);
    for (let i = 0; i <= 6; i++) {
      const x = hx - hw + (i * 2 * hw) / 6;
      ctx.lineTo(x - hw / 6, hy - hh * 1.45 - (i % 2) * hh * 0.15);
      ctx.lineTo(x, hy - hh * 0.95);
    }
    ctx.lineTo(hx + hw, hy - hh * 0.55);
  } else {
    ctx.roundRect(hx - hw * 1.02, hy - hh * 1.08, hw * 2.04, hh * 0.55, [hw * 0.3, hw * 0.3, 0, 0]);
    // A little fringe.
    for (let i = 0; i < 5; i++) {
      const x = hx - hw + ((i + 0.5) * 2 * hw) / 5;
      ctx.moveTo(x - hw * 0.2, hy - hh * 0.54);
      ctx.lineTo(x + hw * 0.2, hy - hh * 0.54);
      ctx.lineTo(x, hy - hh * 0.36);
    }
  }
  ctx.fill();

  // Face: sleepy happy eyes (big and round when zapped), a stitch, a grin.
  const er = hw * 0.17;
  if (zap) eyes(ctx, hx, hy - hh * 0.05, er, hw * 0.42, 1, true);
  else {
    const open = blink(o.t, seed);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(2, er * 0.45);
    ctx.beginPath();
    for (const sx of [-1, 1]) {
      const ex = hx + sx * hw * 0.42;
      const ey = hy - hh * 0.05;
      if (open < 0.5) {
        ctx.moveTo(ex - er, ey);
        ctx.lineTo(ex + er, ey);
      } else {
        ctx.moveTo(ex - er, ey);
        ctx.quadraticCurveTo(ex, ey - er * 1.5, ex + er, ey);
      }
    }
    ctx.stroke();
  }
  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(1.5, hw * 0.045);
  ctx.beginPath();
  const sy = hy - hh * 0.38;
  ctx.moveTo(hx - hw * 0.55, sy);
  ctx.lineTo(hx - hw * 0.05, sy - hh * 0.05);
  for (let i = 0; i < 4; i++) {
    const x = hx - hw * 0.5 + i * hw * 0.14;
    const y = lerp(sy, sy - hh * 0.05, i / 3);
    ctx.moveTo(x, y - hh * 0.06);
    ctx.lineTo(x, y + hh * 0.06);
  }
  ctx.moveTo(hx - hw * 0.35, hy + hh * 0.45);
  ctx.quadraticCurveTo(hx, hy + hh * (zap ? 0.5 : 0.7), hx + hw * 0.35, hy + hh * 0.45);
  ctx.stroke();

  // Sparks arcing from the bolts while zapped.
  if (zap) {
    ctx.strokeStyle = pal.spark;
    ctx.lineWidth = Math.max(2, hw * 0.06);
    ctx.beginPath();
    for (const sx of [-1, 1]) {
      let x = hx + sx * (hw + hw * 0.28);
      let y = hy + hh * 0.27;
      ctx.moveTo(x, y);
      const n = 5;
      for (let i = 0; i < n; i++) {
        x += sx * hw * 0.22;
        y += ((Math.floor(o.t * 30 + i * 7 + seed) % 3) - 1) * hh * 0.18 - hh * 0.05;
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function drawCreature(ctx: CanvasRenderingContext2D, form: Form, pts: P[], o: Pose2, pal: Palette, seed: number): void {
  if (form === 'mummy') drawMummy(ctx, pts, o, pal, seed);
  else if (form === 'ghost') drawGhost(ctx, pts, o, pal, seed);
  else if (form === 'monster') drawMonster(ctx, pts, o, pal, seed);
  else drawSkeleton(ctx, pts, o, pal);
}
