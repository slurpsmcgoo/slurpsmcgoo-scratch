// The show's small local server, shared by `npm run dev` (attached to Vite's
// own HTTP server) and `npm run show` (server/index.ts). It:
//   - relays operator commands from the phone remote to the show page (WebSocket /ws)
//   - pushes config/show.json to the page whenever the file changes
//   - saves output calibration back into show.json
//   - writes perception logs (numbers only) and serves them back for replay
//   - serves the /remote page, and in show mode the built app from dist/

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { OperatorCommand } from '../src/types.ts';

export interface ShowServerOptions {
  root: string;     // the halloween/ project folder
  distDir?: string; // serve the built app from here (show mode only)
}

type Next = () => void;

const COMMAND_TYPES = new Set(['nextScene', 'prevScene', 'setScene', 'scareNow', 'blackout', 'pauseInteraction', 'sensitivity', 'intensity']);
const LOG_NAME = /^[\w.-]+\.jsonl$/;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Content-Security-Policy for the pose worker script. A worker does not inherit
 * the page's CSP (index.html), only the policy sent with its own script, so
 * without this header MediaPipe's usage telemetry would get out from the worker.
 */
export const WORKER_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:";

/** The pose worker's URL: /src/perception/poseWorker.ts?worker_file... in dev, /assets/poseWorker-<hash>.js when built. */
export const isWorkerScript = (pathname: string): boolean => /\/poseWorker[^/]*\.(ts|js)$/.test(pathname);

/** JSON with arrays of plain values kept on one line, matching show.json's hand-written style. */
export function formatJson(value: unknown, indent = ''): string {
  const next = indent + '  ';
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((w) => typeof w !== 'object')))) {
      return `[${value.map((v) => JSON.stringify(v).replace(/,/g, ', ')).join(', ')}]`;
    }
    return `[\n${value.map((v) => next + formatJson(v, next)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    if (entries.every(([, v]) => typeof v !== 'object' || v === null) && entries.length <= 3 && indent.length >= 6) {
      return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
    }
    return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${formatJson(v, next)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function isPoints(v: unknown, min: number, max: number): v is [number, number][] {
  return (
    Array.isArray(v) &&
    v.length >= min &&
    v.length <= max &&
    v.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n) && n > -1 && n < 2))
  );
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

export function createShowServer(opts: ShowServerOptions) {
  const configPath = path.join(opts.root, 'config', 'show.json');
  const logsDir = path.join(opts.root, 'logs');
  const remotePath = path.join(opts.root, 'remote', 'index.html');
  const serverLogPath = path.join(logsDir, 'server.log');

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const shows = new Set<WebSocket>();
  const remotes = new Set<WebSocket>();
  let lastHeartbeat: { receivedMs: number; payload: unknown } | null = null;
  let perceptionLog: fs.WriteStream | null = null;
  let videoLog: fs.WriteStream | null = null;
  let lastConfigText = '';

  fs.mkdirSync(logsDir, { recursive: true });

  function serverLog(message: string): void {
    const line = `${new Date().toISOString()} ${message}\n`;
    process.stdout.write(`[show-server] ${message}\n`);
    fs.appendFile(serverLogPath, line, () => {});
  }

  async function readConfigText(): Promise<string> {
    return fsp.readFile(configPath, 'utf8');
  }

  function broadcast(set: Set<WebSocket>, msg: unknown): void {
    const text = JSON.stringify(msg);
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(text);
  }

  // Push config changes to every open show page. Editors often replace the
  // file rather than writing it in place, so watch the folder, not the file.
  let configTimer: NodeJS.Timeout | null = null;
  const watcher = fs.watch(path.dirname(configPath), (_event, filename) => {
    if (filename && filename.toString() !== 'show.json') return;
    if (configTimer) clearTimeout(configTimer);
    configTimer = setTimeout(async () => {
      try {
        const text = await readConfigText();
        if (text === lastConfigText) return;
        const config = JSON.parse(text);
        lastConfigText = text;
        broadcast(shows, { type: 'config', config });
        serverLog('config/show.json changed; pushed to show page');
      } catch (err) {
        serverLog(`config/show.json is not valid JSON, keeping the previous one: ${(err as Error).message}`);
      }
    }, 150);
  });
  readConfigText().then((t) => (lastConfigText = t)).catch(() => {});

  const statusTimer = setInterval(() => {
    broadcast(remotes, {
      type: 'status',
      showConnected: shows.size > 0,
      heartbeat: lastHeartbeat?.payload ?? null,
      heartbeatAgeMs: lastHeartbeat ? Date.now() - lastHeartbeat.receivedMs : null,
    });
  }, 1000);

  function startPerceptionLog(): string {
    stopPerceptionLog();
    const name = `perception-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    perceptionLog = fs.createWriteStream(path.join(logsDir, name), { flags: 'a' });
    serverLog(`recording perception log ${name}`);
    return name;
  }

  function stopPerceptionLog(): void {
    perceptionLog?.end();
    perceptionLog = null;
  }

  async function videoRecordingAllowed(): Promise<boolean> {
    try {
      const cfg = JSON.parse(await readConfigText());
      return cfg?.recorder?.recordVideo === true;
    } catch {
      return false;
    }
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const role = new URL(req.url ?? '/', 'http://x').searchParams.get('role');
    const set = role === 'remote' ? remotes : shows;
    set.add(ws);
    serverLog(`${role === 'remote' ? 'remote' : 'show page'} connected (${set.size} open)`);

    ws.on('message', (data) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (role === 'remote') {
        const cmd = msg.command as OperatorCommand | undefined;
        if (msg.type === 'command' && cmd && COMMAND_TYPES.has(cmd.type)) {
          broadcast(shows, { type: 'command', command: cmd });
        }
        return;
      }
      switch (msg.type) {
        case 'heartbeat':
          lastHeartbeat = { receivedMs: Date.now(), payload: msg.payload };
          break;
        case 'logStart':
          ws.send(JSON.stringify({ type: 'logStarted', name: startPerceptionLog() }));
          break;
        case 'logStop':
          stopPerceptionLog();
          break;
        case 'log':
          if (perceptionLog && typeof msg.line === 'string') perceptionLog.write(msg.line + '\n');
          break;
        case 'error':
          serverLog(`show page error: ${String(msg.message).slice(0, 2000)}`);
          break;
      }
    });
    ws.on('close', () => {
      set.delete(ws);
      if (set === shows && shows.size === 0) stopPerceptionLog();
    });
  });

  async function middleware(req: IncomingMessage, res: ServerResponse, next: Next): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (isWorkerScript(p)) res.setHeader('Content-Security-Policy', WORKER_CSP);
    try {
      if (p === '/remote' || p === '/remote/') {
        return send(res, 200, await fsp.readFile(remotePath, 'utf8'), MIME['.html']);
      }
      if (p === '/api/config' && req.method === 'GET') {
        return send(res, 200, await readConfigText(), MIME['.json']);
      }
      if (p === '/api/config/output' && req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)).toString());
        const orientationOk = body.orientation === 'landscape' || body.orientation === 'portrait';
        const rotationOk = [0, 90, 180, 270].includes(body.rotation);
        if (typeof body.mirror !== 'boolean' || !isPoints(body.corners, 4, 4) || !isPoints(body.mask, 3, 64) || !orientationOk || !rotationOk) {
          return send(res, 400, 'expected { mirror: boolean, corners: 4 points, mask: 3-64 points, orientation: landscape|portrait, rotation: 0|90|180|270 }');
        }
        const cfg = JSON.parse(await readConfigText());
        cfg.output = { mirror: body.mirror, corners: body.corners, mask: body.mask, orientation: body.orientation, rotation: body.rotation };
        await fsp.writeFile(configPath, formatJson(cfg) + '\n');
        serverLog('saved output calibration to config/show.json');
        return send(res, 200, 'ok');
      }
      if (p === '/api/config/active-area' && req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)).toString());
        const a = body.activeArea;
        const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
        const areaOk = a === null || (typeof a === 'object' && num(a.cx, -1, 2) && num(a.cy, -1, 2) && num(a.height, 0.05, 3));
        if (!areaOk || typeof body.ignoreOutsideArea !== 'boolean' || typeof body.cropToArea !== 'boolean') {
          return send(res, 400, 'expected { activeArea: null | { cx, cy, height }, ignoreOutsideArea: boolean, cropToArea: boolean }');
        }
        const cfg = JSON.parse(await readConfigText());
        cfg.perception.activeArea = a === null ? null : { cx: a.cx, cy: a.cy, height: a.height };
        cfg.perception.ignoreOutsideArea = body.ignoreOutsideArea;
        cfg.perception.cropToArea = body.cropToArea;
        await fsp.writeFile(configPath, formatJson(cfg) + '\n');
        serverLog('saved camera active area to config/show.json');
        return send(res, 200, 'ok');
      }
      if (p === '/api/status' && req.method === 'GET') {
        const status = { showConnected: shows.size > 0, heartbeat: lastHeartbeat?.payload ?? null, heartbeatAgeMs: lastHeartbeat ? Date.now() - lastHeartbeat.receivedMs : null };
        return send(res, 200, JSON.stringify(status), MIME['.json']);
      }
      if (p === '/api/logs' && req.method === 'GET') {
        const names = (await fsp.readdir(logsDir)).filter((n) => LOG_NAME.test(n)).sort().reverse();
        return send(res, 200, JSON.stringify(names), MIME['.json']);
      }
      if (p.startsWith('/api/logs/') && req.method === 'GET') {
        const name = decodeURIComponent(p.slice('/api/logs/'.length));
        if (!LOG_NAME.test(name)) return send(res, 400, 'bad log name');
        return send(res, 200, await fsp.readFile(path.join(logsDir, name), 'utf8'), 'application/x-ndjson');
      }
      if (p === '/api/video' && req.method === 'POST') {
        // Development-only: video of your own household for testing. Refused
        // unless recorder.recordVideo is true in show.json.
        if (!(await videoRecordingAllowed())) return send(res, 403, 'video recording is off');
        const chunk = await readBody(req, 50_000_000);
        if (url.searchParams.get('start') === '1' || !videoLog) {
          videoLog?.end();
          const name = `video-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
          videoLog = fs.createWriteStream(path.join(logsDir, name));
          serverLog(`recording development video ${name}`);
        }
        videoLog.write(chunk);
        return send(res, 200, 'ok');
      }
      if (p.startsWith('/api/')) return send(res, 404, 'not found');
      if (opts.distDir) return serveStatic(opts.distDir, p, res, next);
      next();
    } catch (err) {
      serverLog(`request ${req.method} ${p} failed: ${(err as Error).message}`);
      send(res, 500, 'server error');
    }
  }

  async function serveStatic(dir: string, p: string, res: ServerResponse, next: Next): Promise<void> {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir) + path.sep)) return send(res, 403, 'forbidden');
    try {
      const data = await fsp.readFile(file);
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
      res.end(data);
    } catch {
      next();
    }
  }

  function attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') return; // leave Vite's HMR socket alone
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  }

  function close(): void {
    watcher.close();
    clearInterval(statusTimer);
    stopPerceptionLog();
    videoLog?.end();
    for (const ws of [...shows, ...remotes]) ws.terminate();
    wss.close();
  }

  return { middleware, attach, close };
}
