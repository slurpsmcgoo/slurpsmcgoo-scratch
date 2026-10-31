// Output transform: takes the scene canvas (1920x1080, or 1080x1920 in
// portrait) and draws it to the projector with the rear-projection mirror, a
// quarter-turn rotation for a projector on its side, the four-corner pin warp
// and the window mask. Uses a small raw WebGL2 shader because Canvas 2D can only do
// affine transforms; falls back to a 2D mirror-only path if WebGL2 is missing.

import type { Orientation, Pt, Rotation } from '../config.ts';
import { applyHomography, computeHomography, invert3, UNIT_SQUARE, type Mat3 } from './homography.ts';

export interface OutputCalibration {
  mirror: boolean;
  corners: Pt[]; // TL, TR, BR, BL in normalized screen coordinates (0..1, y down)
  mask: Pt[];    // polygon in normalized screen coordinates; outside is forced black
  orientation: Orientation;
  rotation: Rotation; // clockwise turn of the picture inside the corner quad
}

/**
 * From a point in the corner quad (0..1, the projector's frame) to the point
 * of the picture shown there, when the picture is turned `rot` degrees
 * clockwise. Must match the fragment shader.
 */
export function quadToPicture([x, y]: Pt, rot: Rotation): Pt {
  if (rot === 90) return [y, 1 - x];
  if (rot === 180) return [1 - x, 1 - y];
  if (rot === 270) return [1 - y, x];
  return [x, y];
}

/** Inverse of quadToPicture. */
export function pictureToQuad([u, v]: Pt, rot: Rotation): Pt {
  if (rot === 90) return [1 - v, u];
  if (rot === 180) return [1 - u, 1 - v];
  if (rot === 270) return [v, 1 - u];
  return [u, v];
}

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_screen;
void main() {
  v_screen = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_screen;
uniform sampler2D u_scene;
uniform sampler2D u_mask;
uniform mat3 u_inv;
uniform bool u_mirror;
uniform int u_rot; // quarter turns clockwise
out vec4 o;
void main() {
  vec3 p = u_inv * vec3(v_screen, 1.0);
  vec2 q = p.xy / p.z;
  if (p.z <= 0.0 || q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) {
    o = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec2 uv = q;
  if (u_rot == 1) uv = vec2(q.y, 1.0 - q.x);
  else if (u_rot == 2) uv = vec2(1.0 - q.x, 1.0 - q.y);
  else if (u_rot == 3) uv = vec2(1.0 - q.y, q.x);
  // Mirror flips the picture as the audience sees it, after any rotation.
  if (u_mirror) uv.x = 1.0 - uv.x;
  float m = texture(u_mask, v_screen).r;
  o = vec4(texture(u_scene, uv).rgb * m, 1.0);
}`;

export class Output {
  private gl: WebGL2RenderingContext | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private program: WebGLProgram | null = null;
  private sceneTex: WebGLTexture | null = null;
  private maskTex: WebGLTexture | null = null;
  private sceneTexSize: [number, number] = [0, 0];
  private maskCanvas = document.createElement('canvas');
  private maskDirty = true;
  private cal: OutputCalibration;
  private h: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  private hInv: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  constructor(private canvas: HTMLCanvasElement, cal: OutputCalibration) {
    this.cal = cal;
    this.setCalibration(cal);
    this.initGl();
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => this.initGl());
  }

  get usingWebGl(): boolean {
    return this.gl !== null;
  }

  get calibration(): OutputCalibration {
    return this.cal;
  }

  setCalibration(cal: OutputCalibration): void {
    try {
      const h = computeHomography(UNIT_SQUARE, cal.corners);
      this.hInv = invert3(h);
      this.h = h;
      this.cal = {
        mirror: cal.mirror,
        corners: cal.corners.map((p) => [p[0], p[1]]),
        mask: cal.mask.map((p) => [p[0], p[1]]),
        orientation: cal.orientation,
        rotation: cal.rotation,
      };
      this.maskDirty = true;
    } catch (err) {
      console.error('[output] ignoring degenerate calibration', err);
    }
  }

  /** Maps a point on the logical scene canvas (0..1) to normalized screen coordinates. */
  logicalToScreen(p: Pt): Pt {
    const u = this.cal.mirror ? 1 - p[0] : p[0];
    return applyHomography(this.h, pictureToQuad([u, p[1]], this.cal.rotation));
  }

  /** Inverse of logicalToScreen. */
  screenToLogical(p: Pt): Pt {
    const [u, v] = quadToPicture(applyHomography(this.hInv, p), this.cal.rotation);
    return [this.cal.mirror ? 1 - u : u, v];
  }

  private initGl(): void {
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) {
      console.warn('[output] WebGL2 unavailable; using 2D fallback (mirror and mask only, no corner pin)');
      this.ctx2d = this.canvas.getContext('2d');
      return;
    }
    const compile = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const makeTex = (unit: number): WebGLTexture => {
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.sceneTex = makeTex(0);
    this.maskTex = makeTex(1);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_scene'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_mask'), 1);
    this.gl = gl;
    this.program = prog;
    this.sceneTexSize = [0, 0];
    this.maskDirty = true;
  }

  /** Keeps the drawing buffer matched to the element's size on screen. */
  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.maskDirty = true;
    }
  }

  private drawMask(): void {
    const mc = this.maskCanvas;
    mc.width = Math.max(2, Math.round(this.canvas.width / 2));
    mc.height = Math.max(2, Math.round(this.canvas.height / 2));
    const m = mc.getContext('2d')!;
    m.fillStyle = '#000';
    m.fillRect(0, 0, mc.width, mc.height);
    m.fillStyle = '#fff';
    m.beginPath();
    this.cal.mask.forEach(([x, y], i) => (i === 0 ? m.moveTo(x * mc.width, y * mc.height) : m.lineTo(x * mc.width, y * mc.height)));
    m.closePath();
    m.fill();
  }

  present(scene: HTMLCanvasElement): void {
    this.resize();
    if (this.gl && this.program) this.presentGl(this.gl, scene);
    else if (this.ctx2d) this.present2d(this.ctx2d, scene);
  }

  private presentGl(gl: WebGL2RenderingContext, scene: HTMLCanvasElement): void {
    if (gl.isContextLost()) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (this.maskDirty) {
      this.drawMask();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.maskCanvas);
      this.maskDirty = false;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    if (this.sceneTexSize[0] !== scene.width || this.sceneTexSize[1] !== scene.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scene);
      this.sceneTexSize = [scene.width, scene.height];
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, scene);
    }
    const m = this.hInv;
    // GLSL mat3 is column-major.
    gl.uniformMatrix3fv(gl.getUniformLocation(this.program!, 'u_inv'), false, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
    gl.uniform1i(gl.getUniformLocation(this.program!, 'u_mirror'), this.cal.mirror ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(this.program!, 'u_rot'), this.cal.rotation / 90);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private present2d(ctx: CanvasRenderingContext2D, scene: HTMLCanvasElement): void {
    const { width: w, height: h } = this.canvas;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.beginPath();
    this.cal.mask.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * w, y * h) : ctx.lineTo(x * w, y * h)));
    ctx.closePath();
    ctx.clip();
    // Turn about the center, then mirror in the picture's own frame.
    const quarter = this.cal.rotation === 90 || this.cal.rotation === 270;
    const bw = quarter ? h : w;
    const bh = quarter ? w : h;
    ctx.translate(w / 2, h / 2);
    ctx.rotate((this.cal.rotation * Math.PI) / 180);
    if (this.cal.mirror) ctx.scale(-1, 1);
    ctx.drawImage(scene, -bw / 2, -bh / 2, bw, bh);
    ctx.restore();
  }
}
