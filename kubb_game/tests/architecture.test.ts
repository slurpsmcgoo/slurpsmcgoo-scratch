// Rules for code that keep the sim deterministic and the layers apart.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.join(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
  if (!fs.existsSync(path.join(SRC, dir))) return [];
  return fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}

function source(file: string): string {
  // Drop comments so they can mention what code may not use.
  return fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function imports(file: string): string[] {
  return [...source(file).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
}

describe('architecture', () => {
  it('sim imports only types, config, other sim files and Rapier', () => {
    for (const f of files('sim')) {
      for (const imp of imports(f)) {
        const ok = imp.startsWith('./') || imp === '../types.ts' || imp === '../config.ts' || imp === '@dimforge/rapier3d-deterministic-compat';
        expect(ok, `${f} imports ${imp}`).toBe(true);
      }
    }
  });

  it('sim uses no clocks, randomness, DOM or platform-dependent maths', () => {
    const banned = /Math\.(random|sin|cos|tan|asin|acos|atan|atan2|exp|expm1|log|log2|log10|log1p|pow|hypot|cbrt|sinh|cosh|tanh)\b|Date\.now|performance\.now|\bwindow\b|\bdocument\b|\*\*/;
    for (const f of files('sim')) {
      const m = source(f).match(banned);
      expect(m?.[0], `${f} uses ${m?.[0]}`).toBeUndefined();
    }
  });

  it('only render, input, ui and app use three.js', () => {
    for (const dir of ['sim', 'throw', 'bot', 'game', 'net']) {
      for (const f of files(dir)) {
        expect(imports(f).some((i) => i.startsWith('three')), `${f} imports three`).toBe(false);
      }
    }
  });

  it('render never imports the rules reducers', () => {
    for (const f of files('render')) {
      const src = source(f);
      expect(/applyThrowResult|applyPlace|applyAction/.test(src), `${f} changes game state`).toBe(false);
    }
  });
});
