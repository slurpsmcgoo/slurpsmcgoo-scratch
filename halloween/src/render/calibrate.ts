// Calibration mode (key C). Shows a test grid through the output transform;
// drag the four corner handles to pin the image to the window opening, and the
// mask points to black out the frame and wall around it. Pressing C again
// saves mirror, corners, mask, orientation and rotation into
// config/show.json via the server.
//
//   Tab     switch between corners and mask points
//   M       toggle the rear-projection mirror
//   O       landscape / portrait; Shift+O turns the picture a quarter turn (projector on its side)
//   R       reset corners and mask to the full screen
//   Arrows  nudge the selected point (Shift = 10x)
//   Double-click a mask edge to add a point, right-click a mask point to remove it
//   Esc     leave without saving

import type { Pt, ShowConfig } from '../config.ts';
import type { Output, OutputCalibration } from './output.ts';

const FULL: Pt[] = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** Saves the output section of show.json through the server. */
export async function saveOutputCalibration(cal: OutputCalibration): Promise<void> {
  const res = await fetch('/api/config/output', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cal) });
  if (!res.ok) throw new Error(await res.text());
}

/** The next orientation or rotation, for the O key. */
export function turned(cal: OutputCalibration, rotate: boolean): OutputCalibration {
  if (rotate) return { ...cal, rotation: (((cal.rotation + 90) % 360) as OutputCalibration['rotation']) };
  return { ...cal, orientation: cal.orientation === 'landscape' ? 'portrait' : 'landscape' };
}
const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'];

export class Calibrator {
  active = false;
  private editing: 'corners' | 'mask' = 'corners';
  private work: OutputCalibration | null = null;
  private selected = 0;
  private dragging = false;
  private ctx: CanvasRenderingContext2D;
  private status = '';

  constructor(
    private canvas: HTMLCanvasElement,
    private output: Output,
    private saved: () => ShowConfig['output'],
  ) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => (this.dragging = false));
    canvas.addEventListener('dblclick', (e) => this.addMaskPoint(e));
    canvas.addEventListener('contextmenu', (e) => this.removeMaskPoint(e));
  }

  toggle(): void {
    if (this.active) void this.save();
    else this.enter();
  }

  private enter(): void {
    const c = this.output.calibration;
    this.work = {
      mirror: c.mirror,
      corners: c.corners.map((p) => [...p] as Pt),
      mask: c.mask.map((p) => [...p] as Pt),
      orientation: c.orientation,
      rotation: c.rotation,
    };
    this.active = true;
    this.selected = 0;
    this.status = '';
  }

  private apply(): void {
    if (this.work) this.output.setCalibration(this.work);
  }

  private async save(): Promise<void> {
    if (!this.work) return;
    this.active = false;
    try {
      await saveOutputCalibration(this.work);
      console.info('[calibrate] saved to show.json');
    } catch (err) {
      console.error('[calibrate] could not save calibration; it stays applied until reload', err);
    }
  }

  private cancel(): void {
    this.active = false;
    this.output.setCalibration(this.saved());
  }

  private points(): Pt[] {
    return this.work ? (this.editing === 'corners' ? this.work.corners : this.work.mask) : [];
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.work) return false;
    const k = e.key;
    if (k === 'Tab') {
      this.editing = this.editing === 'corners' ? 'mask' : 'corners';
      this.selected = 0;
    } else if (k === 'Escape') this.cancel();
    else if (k === 'c' || k === 'C') void this.save();
    else if (k === 'm' || k === 'M') {
      this.work.mirror = !this.work.mirror;
      this.apply();
    } else if (k === 'o' || k === 'O') {
      this.work = turned(this.work, e.shiftKey);
      this.apply();
    } else if (k === 'r' || k === 'R') {
      this.work.corners = FULL.map((p) => [...p] as Pt);
      this.work.mask = FULL.map((p) => [...p] as Pt);
      this.apply();
    } else if (k.startsWith('Arrow')) {
      const pts = this.points();
      const p = pts[this.selected];
      if (!p) return true;
      const step = (e.shiftKey ? 10 : 1) / this.canvas.width;
      const stepY = (e.shiftKey ? 10 : 1) / this.canvas.height;
      if (k === 'ArrowLeft') p[0] -= step;
      if (k === 'ArrowRight') p[0] += step;
      if (k === 'ArrowUp') p[1] -= stepY;
      if (k === 'ArrowDown') p[1] += stepY;
      this.apply();
    } else return false;
    e.preventDefault();
    return true;
  }

  private toNorm(e: MouseEvent): Pt {
    const b = this.canvas.getBoundingClientRect();
    return [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height];
  }

  private nearest(p: Pt, pts: Pt[]): number {
    const W = this.canvas.width;
    const H = this.canvas.height;
    let best = -1;
    let bestD = 30;
    pts.forEach((q, i) => {
      const d = Math.hypot((q[0] - p[0]) * W, (q[1] - p[1]) * H);
      if (d < bestD) [best, bestD] = [i, d];
    });
    return best;
  }

  private down(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return;
    const i = this.nearest(this.toNorm(e), this.points());
    if (i >= 0) {
      this.selected = i;
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
    }
  }

  private move(e: PointerEvent): void {
    if (!this.active || !this.dragging) return;
    const p = this.points()[this.selected];
    if (!p) return;
    const [x, y] = this.toNorm(e);
    p[0] = x;
    p[1] = y;
    this.apply();
  }

  private addMaskPoint(e: MouseEvent): void {
    if (!this.active || this.editing !== 'mask' || !this.work) return;
    const p = this.toNorm(e);
    const m = this.work.mask;
    // Insert after the edge closest to the click.
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < m.length; i++) {
      const a = m[i]!;
      const b = m[(i + 1) % m.length]!;
      const d = distToSegment(p, a, b);
      if (d < bestD) [bestI, bestD] = [i, d];
    }
    m.splice(bestI + 1, 0, p);
    this.selected = bestI + 1;
    this.apply();
  }

  private removeMaskPoint(e: MouseEvent): void {
    if (!this.active) return;
    e.preventDefault();
    if (this.editing !== 'mask' || !this.work || this.work.mask.length <= 3) return;
    const i = this.nearest(this.toNorm(e), this.work.mask);
    if (i >= 0) {
      this.work.mask.splice(i, 1);
      this.selected = 0;
      this.apply();
    }
  }

  /** Test pattern drawn on the logical scene canvas, so it goes through the real warp. */
  renderGrid(scene: HTMLCanvasElement): void {
    const ctx = scene.getContext('2d')!;
    const w = scene.width;
    const h = scene.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth = 2;
    for (let x = 0; x <= w; x += 120) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y += 120) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, w - 6, h - 6);
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, h * 0.35, 0, Math.PI * 2);
    ctx.moveTo(w / 2 - 60, h / 2);
    ctx.lineTo(w / 2 + 60, h / 2);
    ctx.moveTo(w / 2, h / 2 - 60);
    ctx.lineTo(w / 2, h / 2 + 60);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 64px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('◀ VISITOR LEFT', 40, h / 2 - 20);
    ctx.textAlign = 'right';
    ctx.fillText('VISITOR RIGHT ▶', w - 40, h / 2 - 20);
    ctx.textAlign = 'center';
    ctx.font = '36px sans-serif';
    ctx.fillText('Read this from the street: the text must not be mirrored.', w / 2, h - 80);
  }

  /** Handles and help, drawn in screen space on the overlay canvas. */
  draw(): void {
    if (!this.work) return;
    const ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = (this.canvas.width = Math.round(this.canvas.clientWidth * dpr));
    const H = (this.canvas.height = Math.round(this.canvas.clientHeight * dpr));
    ctx.clearRect(0, 0, W, H);

    const poly = (pts: Pt[], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * W, y * H) : ctx.lineTo(x * W, y * H)));
      ctx.closePath();
      ctx.stroke();
    };
    poly(this.work.mask, '#ffd23a');
    poly(this.work.corners, '#4fd1ff');

    const handles = (pts: Pt[], color: string, labels: string[] | null, editing: boolean) => {
      pts.forEach(([x, y], i) => {
        ctx.fillStyle = editing && i === this.selected ? '#ffffff' : color;
        ctx.globalAlpha = editing ? 1 : 0.4;
        ctx.beginPath();
        if (labels) ctx.arc(x * W, y * H, 12, 0, Math.PI * 2);
        else ctx.rect(x * W - 9, y * H - 9, 18, 18);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (labels) {
          ctx.fillStyle = '#000';
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(labels[i] ?? '', x * W, y * H + 4);
        }
      });
    };
    handles(this.work.mask, '#ffd23a', null, this.editing === 'mask');
    handles(this.work.corners, '#4fd1ff', CORNER_LABELS, this.editing === 'corners');

    const lines = [
      `CALIBRATION — editing ${this.editing === 'corners' ? 'CORNERS (blue)' : 'MASK (yellow)'}   mirror ${this.work.mirror ? 'ON' : 'off'}`,
      'drag points · Tab corners/mask · arrows nudge · M mirror · R reset',
      'mask: double-click an edge to add a point, right-click a point to remove',
      'C save to show.json · Esc cancel',
    ];
    ctx.font = '16px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(W / 2 - 330, 20, 660, lines.length * 22 + 16);
    ctx.fillStyle = '#ffffff';
    lines.forEach((s, i) => ctx.fillText(s, W / 2 - 316, 44 + i * 22));
    if (this.status) ctx.fillText(this.status, W / 2 - 316, 44 + lines.length * 22);
  }
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
