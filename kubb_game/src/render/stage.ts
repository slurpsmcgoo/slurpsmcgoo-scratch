// The Three.js stage: renderer, scene, camera rig, setting and quality.

import * as THREE from 'three';
import { CFG, physicsFor, sceneDef, type QualityName } from '../config.ts';
import { CameraRig } from './camera.ts';
import { Dust } from './dust.ts';
import { buildEnvironment, type Environment } from './environment.ts';
import { createPieceKit, type PieceKit } from './pieces.ts';

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly kit: PieceKit;
  readonly dust = new Dust();
  env: Environment | null = null;
  setting = '';
  quality: QualityName;
  private time = 0;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(readonly canvas: HTMLCanvasElement, quality: QualityName) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.xr.enabled = true;
    this.rig = new CameraRig(innerWidth / innerHeight);
    this.scene.add(this.rig.camera);
    this.kit = createPieceKit();
    this.scene.add(this.dust.points);
    this.applyQuality();
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  setSetting(name: string): void {
    if (name === this.setting && this.env) return;
    this.setting = name;
    this.rebuild();
  }

  setQuality(q: QualityName): void {
    if (q === this.quality) return;
    this.quality = q;
    this.applyQuality();
    this.rebuild();
  }

  private applyQuality(): void {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, CFG.quality[this.quality].pixelRatio));
  }

  private rebuild(): void {
    if (this.env) {
      this.scene.remove(this.env.group);
      // The sun's shadow map is a render target three.js doesn't free on its own.
      this.env.sun.shadow.dispose();
      this.env.dispose();
    }
    const def = sceneDef(this.setting);
    this.env = buildEnvironment(this.setting, this.scene, this.renderer, this.quality);
    this.scene.add(this.env.group);
    this.renderer.toneMappingExposure = def.exposure;
    this.dust.setSurface(this.env.surface, this.env.dustColor, physicsFor(this.setting).gravity);
  }

  resize(): void {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.rig.resize(innerWidth / innerHeight);
  }

  /** Where a screen point meets the ground (y = 0). */
  pickGround(clientX: number, clientY: number): THREE.Vector3 | null {
    const ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, hit) ? hit : null;
  }

  /** Where a ray meets the ground. */
  pickRay(origin: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 | null {
    const hit = new THREE.Vector3();
    return new THREE.Ray(origin, dir).intersectPlane(this.groundPlane, hit) ? hit : null;
  }

  update(dt: number): void {
    this.time += dt;
    if (!this.renderer.xr.isPresenting) this.rig.update(dt);
    this.env?.update(dt, this.time);
    this.dust.setCamera(this.rig.camera, this.renderer.domElement.clientHeight || innerHeight);
    this.dust.update(dt);
  }

  render(): void {
    this.renderer.render(this.scene, this.rig.camera);
  }
}
