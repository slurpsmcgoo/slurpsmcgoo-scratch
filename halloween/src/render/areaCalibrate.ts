// Camera active area helper (key A). Shows the live camera (visitor view) with
// tracked skeletons and the active area: the part of the camera that fills the
// whole window. Use it to zoom in on a clear patch of the walk and leave
// obstructions (a bush, a post, a parked car) outside.
//
//   Drag inside the box      move it
//   Drag a corner, or wheel  resize it (it keeps the window's proportions)
//   Arrows                   nudge (Shift = 10x);  + / -  resize
//   I                        ignore people standing outside the box
//   P                        run the pose model on just the box (plus a margin)
//   R                        reset to the largest centered box
//   A or Enter               save to show.json;  Esc  leave without saving
//
// Changes apply live while you drag, so the window shows the result at once.

import { logicalSize, type ShowConfig } from '../config.ts';
import type { AudienceState } from '../types.ts';
import { BONES } from './helpers.ts';
import { areaRect, defaultArea, type ActiveArea, type AreaRect } from '../perception/geometry.ts';

export interface AreaSettings {
  activeArea: ActiveArea | null;
  ignoreOutsideArea: boolean;
  cropToArea: boolean;
}

interface Inputs {
  cfg: ShowConfig;
  video: HTMLVideoElement | null;
  audience: AudienceState;
}

const MIN_HEIGHT = 0.1;
const MAX_HEIGHT = 2;

/** Saves the active-area settings into show.json through the server. */
export async function saveAreaSettings(s: AreaSettings): Promise<void> {
  const res = await fetch('/api/config/active-area', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
  if (!res.ok) throw new Error(await res.text());
}

export class AreaCalibrator {
  active = false;
  private work: AreaSettings | null = null;
  private saved: AreaSettings | null = null;
  private drag: { kind: 'move'; dx: number; dy: number } | { kind: 'resize'; ax: number; ay: number } | null = null;
  private ctx: CanvasRenderingContext2D;
  private status = '';

  constructor(
    private canvas: HTMLCanvasElement,
    private inputs: () => Inputs,
    private apply: (s: AreaSettings) => void,
  ) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => (this.drag = null));
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }

  toggle(): void {
    if (this.active) void this.save();
    else this.enter();
  }

  private enter(): void {
    const p = this.inputs().cfg.perception;
    this.saved = { activeArea: p.activeArea ? { ...p.activeArea } : null, ignoreOutsideArea: p.ignoreOutsideArea, cropToArea: p.cropToArea };
    this.work = { ...this.saved, activeArea: this.current() };
    this.active = true;
    this.status = '';
  }

  private async save(): Promise<void> {
    if (!this.work) return;
    this.active = false;
    try {
      await saveAreaSettings(this.work);
      console.info('[area] saved to show.json');
    } catch (err) {
      console.error('[area] could not save; it stays applied until reload', err);
    }
  }

  private cancel(): void {
    this.active = false;
    if (this.saved) this.apply(this.saved);
  }

  // ---------------------------------------------------------------- geometry

  private aspects(): { out: number; cam: number } {
    const { cfg, video } = this.inputs();
    const size = logicalSize(cfg.output.orientation);
    const cam = video && video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : cfg.perception.cameraWidth / cfg.perception.cameraHeight;
    return { out: size.width / size.height, cam };
  }

  /** The area being edited, with the default filled in. */
  private current(): ActiveArea {
    const { out, cam } = this.aspects();
    return this.work?.activeArea ?? this.inputs().cfg.perception.activeArea ?? defaultArea(out, cam);
  }

  private rect(): AreaRect {
    const { out, cam } = this.aspects();
    return areaRect(this.current(), out, cam);
  }

  private set(area: ActiveArea): void {
    if (!this.work) return;
    area.height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, area.height));
    this.work = { ...this.work, activeArea: area };
    this.apply(this.work);
  }

  /** Where the camera picture is drawn on screen (fit inside, under the instructions). */
  private view(): { x: number; y: number; w: number; h: number } {
    const { cam } = this.aspects();
    const W = this.canvas.width;
    const H = this.canvas.height;
    const top = 70;
    const bottom = 60;
    // Leave room around the picture so a box bigger than the camera stays visible.
    const availW = W * 0.8;
    const availH = (H - top - bottom) * 0.8;
    const w = Math.min(availW, availH * cam);
    const h = w / cam;
    return { x: (W - w) / 2, y: top + (H - top - bottom - h) / 2, w, h };
  }

  private toCam(e: PointerEvent | WheelEvent): [number, number] {
    const v = this.view();
    const sx = (e.offsetX * this.canvas.width) / this.canvas.clientWidth;
    const sy = (e.offsetY * this.canvas.height) / this.canvas.clientHeight;
    return [(sx - v.x) / v.w, (sy - v.y) / v.h];
  }

  // ---------------------------------------------------------------- input

  private down(e: PointerEvent): void {
    if (!this.active) return;
    const [x, y] = this.toCam(e);
    const r = this.rect();
    const v = this.view();
    const near = 18 / v.w;
    const corners: [number, number][] = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
    const i = corners.findIndex(([cx, cy]) => Math.abs(cx - x) < near && Math.abs(cy - y) < near * (v.w / v.h));
    if (i >= 0) {
      const [ax, ay] = corners[(i + 2) % 4]!; // the opposite corner stays put
      this.drag = { kind: 'resize', ax, ay };
    } else if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      const a = this.current();
      this.drag = { kind: 'move', dx: a.cx - x, dy: a.cy - y };
    }
  }

  private move(e: PointerEvent): void {
    if (!this.active || !this.drag) return;
    const [x, y] = this.toCam(e);
    if (this.drag.kind === 'move') {
      this.set({ ...this.current(), cx: x + this.drag.dx, cy: y + this.drag.dy });
      return;
    }
    // Resize from the opposite corner, keeping the window's proportions.
    const { out, cam } = this.aspects();
    const { ax, ay } = this.drag;
    const h = Math.max(Math.abs(y - ay), (Math.abs(x - ax) * cam) / out);
    const hh = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h));
    const ww = (hh * out) / cam;
    const sx = x >= ax ? 1 : -1;
    const sy = y >= ay ? 1 : -1;
    this.set({ cx: ax + (sx * ww) / 2, cy: ay + (sy * hh) / 2, height: hh });
  }

  private wheel(e: WheelEvent): void {
    if (!this.active) return;
    e.preventDefault();
    const a = this.current();
    this.set({ ...a, height: a.height * (e.deltaY > 0 ? 1.05 : 1 / 1.05) });
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.active || !this.work) return false;
    const k = e.key;
    const a = this.current();
    const step = e.shiftKey ? 0.05 : 0.005;
    if (k === 'a' || k === 'A' || k === 'Enter') void this.save();
    else if (k === 'Escape') this.cancel();
    else if (k === 'r' || k === 'R') {
      this.work = { ...this.work, activeArea: null };
      this.apply(this.work);
      this.work = { ...this.work, activeArea: this.current() };
    } else if (k === 'i' || k === 'I') {
      this.work = { ...this.work, ignoreOutsideArea: !this.work.ignoreOutsideArea };
      this.apply(this.work);
    } else if (k === 'p' || k === 'P') {
      this.work = { ...this.work, cropToArea: !this.work.cropToArea };
      this.apply(this.work);
    } else if (k === 'ArrowLeft') this.set({ ...a, cx: a.cx - step });
    else if (k === 'ArrowRight') this.set({ ...a, cx: a.cx + step });
    else if (k === 'ArrowUp') this.set({ ...a, cy: a.cy - step });
    else if (k === 'ArrowDown') this.set({ ...a, cy: a.cy + step });
    else if (k === '=' || k === '+') this.set({ ...a, height: a.height / 1.05 });
    else if (k === '-' || k === '_') this.set({ ...a, height: a.height * 1.05 });
    else return true; // swallow other keys while open
    e.preventDefault();
    return true;
  }

  // ---------------------------------------------------------------- drawing

  draw(): void {
    if (!this.work) return;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const { cfg, video, audience } = this.inputs();
    const v = this.view();
    const r = this.rect();
    const sx = (x: number) => v.x + x * v.w;
    const sy = (y: number) => v.y + y * v.h;

    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fillRect(0, 0, W, H);

    // The camera, in visitor view.
    if (video && video.readyState >= 2) {
      ctx.save();
      if (!cfg.perception.cameraFeedMirrored) {
        ctx.translate(v.x + v.w, v.y);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, v.w, v.h);
      } else ctx.drawImage(video, v.x, v.y, v.w, v.h);
      ctx.restore();
    } else {
      ctx.fillStyle = '#16181d';
      ctx.fillRect(v.x, v.y, v.w, v.h);
      this.text(audience.health.source === 'sim' ? 'simulated camera' : 'no camera image', v.x + v.w / 2, v.y + v.h / 2, '#777', 18, 'center');
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(v.x + 0.5, v.y + 0.5, v.w, v.h);

    // Tracked skeletons (landmarks are relative to the live area).
    const live = audience.cameraArea;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#4fd1ff';
    for (const p of audience.people) {
      ctx.beginPath();
      for (const [a, b] of BONES) {
        const pa = p.landmarks[a];
        const pb = p.landmarks[b];
        if (!pa || !pb || pa.visibility < 0.4 || pb.visibility < 0.4) continue;
        ctx.moveTo(sx(live.x + pa.x * live.w), sy(live.y + pa.y * live.h));
        ctx.lineTo(sx(live.x + pb.x * live.w), sy(live.y + pb.y * live.h));
      }
      ctx.stroke();
    }

    // Dim everything outside the box.
    const bx = sx(r.x);
    const by = sy(r.y);
    const bw = r.w * v.w;
    const bh = r.h * v.h;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(bx, by, bw, bh);
    ctx.fill('evenodd');

    // The box, with its margin for the pose model.
    if (this.work.cropToArea) {
      const m = cfg.perception.cropMargin;
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(255,216,79,0.45)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx - bw * m, by - bh * m, bw * (1 + 2 * m), bh * (1 + 2 * m));
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = '#ffd84f';
    ctx.lineWidth = 3;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = '#ffd84f';
    for (const [x, y] of [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]] as const) ctx.fillRect(x - 8, y - 8, 16, 16);
    this.text('fills the whole window', bx + 10, by + 24, '#ffd84f', 16);

    const pct = Math.round(Math.min(1, r.w) * Math.min(1, r.h) * 100);
    this.text('CAMERA ACTIVE AREA   drag to move · drag a corner or scroll to resize · arrows nudge · +/- size', 24, 32, '#fff', 18);
    this.text('A or Enter save · Esc cancel · R reset', 24, 56, '#bbb', 15);
    const onOff = (b: boolean) => (b ? 'ON' : 'off');
    this.text(
      `box uses ${pct}% of the camera picture   ·   I  ignore people outside: ${onOff(this.work.ignoreOutsideArea)}   ·   P  model looks only here: ${onOff(this.work.cropToArea)}`,
      24,
      H - 24,
      '#ddd',
      16,
    );
    if (this.status) this.text(this.status, W - 24, H - 24, '#ffb84f', 16, 'right');
    ctx.restore();
  }

  private text(s: string, x: number, y: number, color: string, size: number, align: CanvasTextAlign = 'left'): void {
    const ctx = this.ctx;
    ctx.font = `${size}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = align;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillText(s, x + 1, y + 1);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }
}
