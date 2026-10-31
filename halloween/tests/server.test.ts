import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createShowServer, formatJson } from '../server/app.ts';
import { ROOT } from './helpers.ts';

let tmp: string;
let server: http.Server;
let show: ReturnType<typeof createShowServer>;
let base: string;

function connect(role: 'show' | 'remote'): Promise<{ ws: WebSocket; messages: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?role=${role}`);
    const messages: unknown[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halloween-'));
  fs.mkdirSync(path.join(tmp, 'config'));
  fs.mkdirSync(path.join(tmp, 'remote'));
  fs.copyFileSync(path.join(ROOT, 'config', 'show.json'), path.join(tmp, 'config', 'show.json'));
  fs.writeFileSync(path.join(tmp, 'remote', 'index.html'), '<title>remote</title>');
  show = createShowServer({ root: tmp });
  server = http.createServer((req, res) => show.middleware(req, res, () => res.writeHead(404).end()));
  show.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  show.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('show server', () => {
  it('formats show.json exactly as it is written by hand, so calibration saves make clean diffs', () => {
    const text = fs.readFileSync(path.join(ROOT, 'config', 'show.json'), 'utf8');
    expect(formatJson(JSON.parse(text)) + '\n').toBe(text);
  });

  it('serves config and the remote page', async () => {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    expect(cfg.show.playlist.length).toBeGreaterThan(0);
    expect(await (await fetch(`${base}/remote`)).text()).toContain('remote');
  });

  it('relays remote commands to the show page and drops unknown ones', async () => {
    const page = await connect('show');
    const remote = await connect('remote');
    remote.ws.send(JSON.stringify({ type: 'command', command: { type: 'rm -rf' } }));
    remote.ws.send(JSON.stringify({ type: 'command', command: { type: 'scareNow' } }));
    await until(() => page.messages.length > 0);
    expect(page.messages).toEqual([{ type: 'command', command: { type: 'scareNow' } }]);
    page.ws.close();
    remote.ws.close();
  });

  it('reports heartbeats to the remote with their age', async () => {
    const page = await connect('show');
    const remote = await connect('remote');
    page.ws.send(JSON.stringify({ type: 'heartbeat', payload: { state: 'idle', people: 2 } }));
    await until(() => remote.messages.some((m) => (m as { heartbeat?: unknown }).heartbeat));
    const status = remote.messages.find((m) => (m as { heartbeat?: unknown }).heartbeat) as { heartbeat: { people: number }; heartbeatAgeMs: number };
    expect(status.heartbeat.people).toBe(2);
    expect(status.heartbeatAgeMs).toBeLessThan(2000);
    page.ws.close();
    remote.ws.close();
  });

  it('records perception logs and serves them back for replay', async () => {
    const page = await connect('show');
    page.ws.send(JSON.stringify({ type: 'logStart' }));
    await until(() => page.messages.length > 0);
    const name = (page.messages[0] as { name: string }).name;
    page.ws.send(JSON.stringify({ type: 'log', line: '{"timeMs":1,"detections":[]}' }));
    page.ws.send(JSON.stringify({ type: 'log', line: '{"timeMs":2,"detections":[]}' }));
    page.ws.send(JSON.stringify({ type: 'logStop' }));
    await until(() => fs.existsSync(path.join(tmp, 'logs', name)) && fs.readFileSync(path.join(tmp, 'logs', name), 'utf8').split('\n').length >= 3);
    const list = await (await fetch(`${base}/api/logs`)).json();
    expect(list).toContain(name);
    expect((await (await fetch(`${base}/api/logs/${name}`)).text()).trim().split('\n')).toHaveLength(2);
    expect((await fetch(`${base}/api/logs/..%2Fconfig%2Fshow.json`)).status).toBe(400);
    page.ws.close();
  });

  it('refuses video uploads unless the development flag is on', async () => {
    expect((await fetch(`${base}/api/video`, { method: 'POST', body: 'x' })).status).toBe(403);
  });

  it('saves the camera active area into show.json', async () => {
    const bad = await fetch(`${base}/api/config/active-area`, { method: 'PUT', body: JSON.stringify({ activeArea: { cx: 0.5, cy: 0.5, height: 99 }, ignoreOutsideArea: true, cropToArea: true }) });
    expect(bad.status).toBe(400);
    const body = { activeArea: { cx: 0.4, cy: 0.55, height: 0.5 }, ignoreOutsideArea: false, cropToArea: true };
    expect((await fetch(`${base}/api/config/active-area`, { method: 'PUT', body: JSON.stringify(body) })).status).toBe(200);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'show.json'), 'utf8'));
    expect(saved.perception.activeArea).toEqual(body.activeArea);
    expect(saved.perception.ignoreOutsideArea).toBe(false);
    expect(saved.perception.cameraWidth).toBeDefined(); // the rest is intact
  });

  it('saves calibration into show.json and pushes the change to the page', async () => {
    const page = await connect('show');
    const body = { mirror: true, corners: [[0.1, 0.05], [0.9, 0.05], [0.92, 0.95], [0.08, 0.95]], mask: [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]], orientation: 'portrait', rotation: 90 };
    const bad = await fetch(`${base}/api/config/output`, { method: 'PUT', body: JSON.stringify({ ...body, corners: [[0, 0]] }) });
    expect(bad.status).toBe(400);
    const res = await fetch(`${base}/api/config/output`, { method: 'PUT', body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'show.json'), 'utf8'));
    expect(saved.output).toEqual(body);
    expect(saved.scenes.shadowWalker).toBeDefined(); // the rest of the file is intact
    await until(() => page.messages.some((m) => (m as { type: string }).type === 'config'));
    page.ws.close();
  });
});
