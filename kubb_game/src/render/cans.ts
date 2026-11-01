// Beer cans and coolers for beer mode. The can styles borrow the colour
// schemes of common light lagers, with generic words instead of brand names
// or logos.

import * as THREE from 'three';
import { CFG } from '../config.ts';

interface CanStyle {
  name: string;
  body: string;
  band: string;
  accent: string;
  text: string;
}

const STYLES = CFG.beer.cans as CanStyle[];

function canTexture(st: CanStyle): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = st.body;
  g.fillRect(0, 0, 256, 256);
  // A wide band with the word, a thin accent stripe above and below, and a simple emblem.
  g.fillStyle = st.band;
  g.fillRect(0, 92, 256, 72);
  g.fillStyle = st.accent;
  g.fillRect(0, 84, 256, 6);
  g.fillRect(0, 166, 256, 6);
  g.save();
  g.translate(64, 128);
  g.fillStyle = st.accent;
  g.beginPath();
  g.moveTo(-26, 18);
  g.lineTo(-8, -16);
  g.lineTo(4, 2);
  g.lineTo(12, -8);
  g.lineTo(28, 18);
  g.closePath();
  g.fill();
  g.restore();
  g.fillStyle = st.body;
  g.font = 'bold 44px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(st.text, 170, 130);
  g.fillText(st.text, 170 - 256, 130);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class CanKit {
  private geo: THREE.BufferGeometry;
  private mats: THREE.Material[] = [];
  private coolerBody = new THREE.MeshStandardMaterial({ color: '#c8352f', roughness: 0.5 });
  private coolerLid = new THREE.MeshStandardMaterial({ color: '#f1efe9', roughness: 0.45 });

  constructor() {
    // A 355 ml can: 6.6 cm across, 12.2 cm tall, necked at the top.
    const pts = [
      new THREE.Vector2(0, -0.061),
      new THREE.Vector2(0.03, -0.061),
      new THREE.Vector2(0.033, -0.056),
      new THREE.Vector2(0.033, 0.048),
      new THREE.Vector2(0.027, 0.058),
      new THREE.Vector2(0.026, 0.061),
      new THREE.Vector2(0, 0.061),
    ];
    this.geo = new THREE.LatheGeometry(pts, 24);
  }

  private material(style: number): THREE.Material {
    const i = style % STYLES.length;
    this.mats[i] ??= new THREE.MeshStandardMaterial({ map: canTexture(STYLES[i]!), metalness: 0.55, roughness: 0.32 });
    return this.mats[i]!;
  }

  can(style: number): THREE.Mesh {
    const m = new THREE.Mesh(this.geo, this.material(style));
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  cooler(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.32, 0.36), this.coolerBody);
    body.position.y = 0.16;
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.57, 0.06, 0.38), this.coolerLid);
    lid.position.y = 0.35;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.2), this.coolerLid);
    handle.position.set(0.3, 0.24, 0);
    g.add(body, lid, handle);
    g.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    return g;
  }
}
