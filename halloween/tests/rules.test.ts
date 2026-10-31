// Mechanical checks for the project's architecture rules (see CLAUDE.md).

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config.ts';
import { ROOT, loadConfig } from './helpers.ts';

const scenesDir = path.join(ROOT, 'src', 'scenes');
const sceneFiles = fs.readdirSync(scenesDir).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
// Shared drawing code for scenes (src/scenes/parts/ and the like) follows the same import and timer rules.
const allSceneCode = fs.readdirSync(scenesDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
const read = (f: string) => fs.readFileSync(path.join(scenesDir, f), 'utf8');

describe('architecture rules', () => {
  it('scenes import only from types.ts, render helpers and other scene code', () => {
    const allowed = new Set([path.join(ROOT, 'src', 'types.ts'), path.join(ROOT, 'src', 'render', 'helpers.ts')]);
    for (const f of allSceneCode) {
      const imports = [...read(f).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
      for (const imp of imports) {
        const target = path.resolve(scenesDir, path.dirname(f), imp);
        expect(allowed.has(target) || target.startsWith(scenesDir + path.sep), `${f} imports ${imp}`).toBe(true);
      }
    }
  });

  it('scenes keep no timers of their own (time only advances through update(dt))', () => {
    for (const f of allSceneCode) {
      expect(read(f), f).not.toMatch(/\b(setTimeout|setInterval|requestAnimationFrame|performance\.now|Date\.now)\b/);
    }
  });

  it('every tunable a scene reads exists in its section of show.json', () => {
    const cfg = loadConfig();
    for (const f of sceneFiles) {
      const src = read(f);
      const id = /id: '(\w+)'/.exec(src)?.[1];
      expect(id, `${f} declares an id`).toBeTruthy();
      const section = cfg.scenes[id!];
      expect(section, `show.json has scenes.${id}`).toBeDefined();
      const keys = [...src.matchAll(/\b(?:num|bool|str)\(cfg, '(\w+)'\)/g)].map((m) => m[1]!);
      for (const k of new Set(keys)) expect(section, `scenes.${id}.${k}`).toHaveProperty(k);
      expect(section).toHaveProperty('scareDurationS');
    }
  });

  it('every scene in the playlist is registered, and show.json is valid', () => {
    const cfg = loadConfig();
    expect(validateConfig(cfg)).toEqual([]);
    const registry = fs.readFileSync(path.join(scenesDir, 'index.ts'), 'utf8');
    for (const id of cfg.show.playlist) {
      const file = sceneFiles.find((f) => read(f).includes(`id: '${id}'`));
      expect(file, `scene ${id} has a file`).toBeTruthy();
      expect(registry).toContain(`./${file}`);
    }
  });

  it('nothing loads from a CDN at runtime', () => {
    const srcFiles = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const f of [...srcFiles(path.join(ROOT, 'src')), path.join(ROOT, 'index.html'), path.join(ROOT, 'remote', 'index.html')]) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/https?:\/\/(?!localhost)/);
    }
  });

  it("the show page only talks to its own server (blocks MediaPipe's telemetry)", () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(html).toMatch(/Content-Security-Policy/);
    expect(html).toMatch(/connect-src 'self'[;"]/);
  });
});
