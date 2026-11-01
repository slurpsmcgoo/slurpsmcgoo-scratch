// Debug overlay (key D): status text, a top-down walk map with zones and
// tracked people, a camera thumbnail with skeletons, and a loudness meter.
// Drawn on its own canvas in screen pixels, after the output transform, so it
// is never mirrored or warped. Off in show mode.

import type { ShowConfig } from '../config.ts';
import type { PoseStats } from '../perception/pose.ts';
import type { BeatTracker } from '../sensors/beatTracker.ts';
import type { AudienceState, DirectorContext } from '../types.ts';
import { BONES } from '../render/helpers.ts';
import { SIM_MAX_DISTANCE_M, worldToWalkMap, type Rect, type SimPerson } from '../sensors/sim.ts';

export interface OverlayInfo {
  fps: number;
  sceneTitle: string;
  director: DirectorContext;
  scheduledScareInS: number | null;
  sensitivity: number;
  paused: boolean;
  blackout: boolean;
  recording: boolean;
  serverConnected: boolean;
  outputMode: string;
  pose: PoseStats | null;
  beat: BeatTracker | null;
  musicInput: string | null; // what the beat tracker listens to (live only)
  ambient: { on: boolean; liveliness: number };
  disabledScenes: string[];
  audience: AudienceState;
  cfg: ShowConfig;
  video: HTMLVideoElement | null;
  simPeople: SimPerson[] | null;
  showDetail: boolean;
  nowMs: number;
}

const COLORS = ['#4fd1ff', '#ffb84f', '#b98cff', '#5dff8f', '#ff6fa8', '#fff36b'];
const STATE_COLOR: Record<string, string> = {
  idle: '#8a8a8a', noticed: '#ffd84f', engaged: '#ff9a3c', scare: '#ff3b3b', cooldown: '#6fb7ff',
};

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private lastShoutMs = -1e9;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Where the walk map sits, in canvas pixels; the simulator's mouse controls use the same rect. */
  walkMapRect(): Rect {
    const w = Math.min(560, this.canvas.width * 0.34);
    const h = w * 0.62;
    return { x: 20, y: this.canvas.height - h - 56, w, h };
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  clear(): void {
    this.resize();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(info: OverlayInfo, showMap: boolean): void {
    this.clear();
    if (info.audience.events.some((e) => e.type === 'shout')) this.lastShoutMs = info.nowMs;
    if (showMap) this.drawWalkMap(info);
    if (!info.showDetail) return;
    this.drawStatus(info);
    this.drawThumbnail(info);
    this.drawBeatGraph(info);
    this.drawHelp();
  }

  private text(s: string, x: number, y: number, color = '#e8e8e8', size = 15, align: CanvasTextAlign = 'left'): void {
    const ctx = this.ctx;
    ctx.font = `${size}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = align;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillText(s, x + 1, y + 1);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }

  private drawStatus(i: OverlayInfo): void {
    const a = i.audience;
    const h = a.health;
    const age = ((i.nowMs - i.director.stateEnteredMs) / 1000).toFixed(1);
    const lines: [string, string?][] = [
      [`${i.fps.toFixed(0)} fps   output ${i.outputMode}   source ${h.source}`],
      [`scene  ${i.sceneTitle}${i.disabledScenes.length ? `   disabled: ${i.disabledScenes.join(', ')}` : ''}`],
      [`state  ${i.director.state.toUpperCase()}  ${age}s${i.scheduledScareInS !== null ? `   scare in ${i.scheduledScareInS.toFixed(1)}s` : ''}`, STATE_COLOR[i.director.state]],
      [`people ${a.people.length}   focus ${i.director.focusPersonId ?? '-'}   nearest ${a.nearest ? `${a.nearest.distanceM.toFixed(2)} m ${a.nearest.zone}` : '-'}`],
      [`camera ${h.camera}   audio ${h.audio}   perception latency ${h.perceptionLatencyMs.toFixed(0)} ms`, h.camera === 'ok' && h.audio === 'ok' ? undefined : '#ffb84f'],
      [i.pose ? `pose ${i.pose.delegate ?? 'loading'} x${i.pose.workers}   ${i.pose.fps.toFixed(0)} fps   model ${i.pose.inferMs.toFixed(1)} ms/frame   camera-to-result ${h.perceptionLatencyMs.toFixed(0)} ms` : 'pose -'],
      [a.music.playing
        ? `music  playing ${a.music.bpm.toFixed(1)} bpm   beat ${a.music.beat}${a.music.phase < 0.15 ? ' *' : ''}   energy ${'#'.repeat(Math.round(a.music.energy * 10)).padEnd(10, '.')}`
        : 'music  -', a.music.playing ? '#ff7be5' : undefined],
      ...(i.musicInput ? [[`music input  ${i.musicInput}`, i.musicInput.includes('not found') ? '#ffb84f' : undefined] as [string, string?]] : []),
      [`ambient ${i.ambient.on ? 'on' : 'off'}   liveliness ${'#'.repeat(Math.round(i.ambient.liveliness * 10)).padEnd(10, '.')}`],
      [`intensity ${i.director.intensity}   sensitivity ${i.sensitivity >= 0 ? '+' : ''}${i.sensitivity}${i.paused ? '   PAUSED' : ''}${i.blackout ? '   BLACKOUT' : ''}${i.recording ? '   REC' : ''}`],
      [`server ${i.serverConnected ? 'connected' : 'not connected'}`, i.serverConnected ? undefined : '#ff6b6b'],
    ];
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(12, 12, 640, lines.length * 22 + 14);
    lines.forEach(([s, c], k) => this.text(s, 22, 36 + k * 22, c ?? '#e8e8e8'));
  }

  /**
   * What the beat tracker hears: the last 4 s of onset strength (bars), the
   * beats on its clock (lines; pink once playing), and its clarity against
   * the thresholds that switch the lasers on and keep them on.
   */
  private drawBeatGraph(i: OverlayInfo): void {
    const b = i.beat;
    if (!b) return;
    const ctx = this.ctx;
    const w = Math.min(520, this.canvas.width * 0.32);
    const h = 110;
    const x0 = this.canvas.width - w - 20;
    const y0 = this.canvas.height - h - 56;
    ctx.save();
    ctx.fillStyle = 'rgba(10,14,20,0.82)';
    ctx.fillRect(x0, y0, w, h);
    const spanMs = 4000;
    const bins = spanMs / 10;
    const env = b.envelope(bins);
    let peak = 1e-6;
    for (const v of env) peak = Math.max(peak, v);
    ctx.fillStyle = 'rgba(160,200,255,0.8)';
    const bw = w / bins;
    env.forEach((v, k) => {
      const bh = (v / peak) * (h - 30);
      ctx.fillRect(x0 + k * bw, y0 + h - 8 - bh, Math.max(1, bw), bh);
    });
    const end = b.envelopeEndMs;
    ctx.strokeStyle = i.audience.music.playing ? '#ff4fd8' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const t of b.beatTimes(end - spanMs, end)) {
      const x = x0 + w - ((end - t) / spanMs) * w;
      ctx.moveTo(x, y0 + 18);
      ctx.lineTo(x, y0 + h - 4);
    }
    ctx.stroke();
    const m = i.cfg.music;
    const c = b.clarity;
    const color = c >= m.clarityOn ? '#5dff8f' : c >= m.clarityKeep ? '#ffd84f' : '#ff6b6b';
    this.text(`beat graph   clarity ${c.toFixed(2)} (on ${m.clarityOn}, keep ${m.clarityKeep})`, x0 + 8, y0 + 14, color, 12);
    ctx.restore();
  }

  private drawWalkMap(i: OverlayInfo): void {
    const ctx = this.ctx;
    const r = this.walkMapRect();
    ctx.save();
    ctx.fillStyle = 'rgba(10,14,20,0.82)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);

    // Zone bands, with the window at the bottom edge.
    const zones = i.cfg.zones;
    const yNear = worldToWalkMap(r, 0, zones.nearM).py;
    const yMid = worldToWalkMap(r, 0, zones.midM).py;
    ctx.fillStyle = 'rgba(255,60,60,0.12)';
    ctx.fillRect(r.x, yNear, r.w, r.y + r.h - yNear);
    ctx.fillStyle = 'rgba(255,170,60,0.08)';
    ctx.fillRect(r.x, yMid, r.w, yNear - yMid);
    ctx.setLineDash([6, 6]);
    for (const [y, label] of [[yNear, `near < ${zones.nearM.toFixed(1)} m`], [yMid, `mid < ${zones.midM.toFixed(1)} m`]] as const) {
      ctx.beginPath();
      ctx.moveTo(r.x, y);
      ctx.lineTo(r.x + r.w, y);
      ctx.stroke();
      this.text(label, r.x + r.w - 8, y - 6, '#cfcfcf', 12, 'right');
    }
    ctx.setLineDash([]);
    this.text('WINDOW', r.x + r.w / 2, r.y + r.h - 6, '#9a9a9a', 11, 'center');
    this.text(`walk map (top = ${SIM_MAX_DISTANCE_M} m)`, r.x + 8, r.y + 16, '#9a9a9a', 12);

    // Simulated people, as placed (before tracking).
    if (i.simPeople) {
      for (const p of i.simPeople) {
        const m = worldToWalkMap(r, p.x, p.distanceM);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(m.px, m.py, 9, 0, Math.PI * 2);
        ctx.stroke();
      }
      this.text('click add · drag move · wheel distance · right-click remove', r.x, r.y - 8, '#bdbdbd', 12);
    }

    // Tracked people, as the system sees them (x back in full-camera terms).
    const area = i.audience.cameraArea;
    for (const p of i.audience.people) {
      const m = worldToWalkMap(r, area.x + p.x * area.w, Math.min(p.distanceM, SIM_MAX_DISTANCE_M));
      const c = COLORS[p.id % COLORS.length]!;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(m.px, m.py, 6, 0, Math.PI * 2);
      ctx.fill();
      if (p.id === i.director.focusPersonId) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(m.px, m.py, 13, 0, Math.PI * 2);
        ctx.stroke();
      }
      this.text(`${p.id} ${p.zone}`, m.px + 14, m.py + 4, c, 12);
    }
    ctx.restore();
  }

  private drawThumbnail(i: OverlayInfo): void {
    const ctx = this.ctx;
    const tw = 320;
    const th = 180;
    const x0 = this.canvas.width - tw - 70;
    const y0 = 12;
    ctx.save();
    ctx.fillStyle = '#111';
    ctx.fillRect(x0, y0, tw, th);
    if (i.video && i.video.readyState >= 2) {
      // Show the camera in visitor view, matching the skeletons.
      ctx.save();
      if (!i.cfg.perception.cameraFeedMirrored) {
        ctx.translate(x0 + tw, y0);
        ctx.scale(-1, 1);
        ctx.drawImage(i.video, 0, 0, tw, th);
      } else {
        ctx.drawImage(i.video, x0, y0, tw, th);
      }
      ctx.restore();
    } else {
      this.text(i.audience.health.source === 'sim' ? 'simulated camera' : 'no camera image', x0 + tw / 2, y0 + th / 2, '#777', 13, 'center');
    }
    // Landmarks are relative to the active area; draw them on the full camera picture.
    const area = i.audience.cameraArea;
    const px = (x: number) => x0 + (area.x + x * area.w) * tw;
    const py = (y: number) => y0 + (area.y + y * area.h) * th;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (const p of i.audience.people) {
      ctx.strokeStyle = COLORS[p.id % COLORS.length]!;
      for (const [a, b] of BONES) {
        const pa = p.landmarks[a];
        const pb = p.landmarks[b];
        if (!pa || !pb || pa.visibility < 0.4 || pb.visibility < 0.4) continue;
        ctx.beginPath();
        ctx.moveTo(px(pa.x), py(pa.y));
        ctx.lineTo(px(pb.x), py(pb.y));
        ctx.stroke();
      }
      const nose = p.landmarks[0];
      if (nose) this.text(String(p.id), px(nose.x), py(nose.y) - 8, '#fff', 12, 'center');
    }
    // The active area (key A to change).
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, tw, th);
    ctx.clip();
    ctx.strokeStyle = '#ffd84f';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + area.x * tw, y0 + area.y * th, area.w * tw, area.h * th);
    // Ignore zones (drawn in the A helper with Z).
    ctx.setLineDash([]);
    for (const z of i.cfg.perception.ignoreZones ?? []) {
      ctx.fillStyle = 'rgba(255,60,60,0.25)';
      ctx.fillRect(x0 + z.x * tw, y0 + z.y * th, z.w * tw, z.h * th);
      ctx.strokeStyle = '#ff5050';
      ctx.strokeRect(x0 + z.x * tw, y0 + z.y * th, z.w * tw, z.h * th);
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, tw, th);

    // Loudness meter beside the thumbnail.
    const mx = x0 + tw + 14;
    const mw = 22;
    const toY = (db: number) => y0 + th - ((Math.max(-90, Math.min(0, db)) + 90) / 90) * th;
    const { levelDb, baselineDb } = i.audience.audio;
    const shouting = i.nowMs - this.lastShoutMs < 400;
    ctx.fillStyle = '#111';
    ctx.fillRect(mx, y0, mw, th);
    ctx.fillStyle = shouting ? '#ff3b3b' : '#5dff8f';
    ctx.fillRect(mx, toY(levelDb), mw, y0 + th - toY(levelDb));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(mx - 3, toY(baselineDb) - 1, mw + 6, 2);
    ctx.fillStyle = '#ff9a3c';
    ctx.fillRect(mx - 3, toY(baselineDb + i.cfg.audio.shoutRiseDb) - 1, mw + 6, 2);
    this.text('dB', mx + mw / 2, y0 + th + 16, '#9a9a9a', 11, 'center');
    ctx.restore();
  }

  private drawHelp(): void {
    const keys = '←/→ scene · 1-9 pick · Enter scare · B blackout · P pause · +/- sensitivity · G intensity · M mirror · C calibrate · D overlay · L lights · S source · R record · F fullscreen';
    const sim = 'sim: X shout · hold V talk · J family · H passer-by · U lurker · Backspace clear · [ camera · ] audio';
    this.text(keys, 20, this.canvas.height - 30, '#bdbdbd', 13);
    this.text(sim, 20, this.canvas.height - 12, '#8d8d8d', 13);
  }
}
