// Show-mode server: serves the built app from dist/, the /remote page and the
// WebSocket relay. Listens on all interfaces so a phone on home Wi-Fi can
// reach /remote; the show page itself is opened on localhost (camera access
// needs a secure origin, and localhost counts as one).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShowServer } from './app.ts';

const root = path.resolve(import.meta.dirname, '..');
const distDir = path.join(root, 'dist');

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('dist/ is missing. Run `npm run build` first (scripts/start-show.sh does this for you).');
  process.exit(1);
}

let port = Number(process.env.PORT);
if (!port) {
  try {
    port = JSON.parse(fs.readFileSync(path.join(root, 'config', 'show.json'), 'utf8')).server.port;
  } catch {
    port = 8787;
  }
}

const show = createShowServer({ root, distDir });
const server = http.createServer((req, res) => {
  show.middleware(req, res, () => {
    res.statusCode = 404;
    res.end('not found');
  });
});
show.attach(server);

server.listen(port, '0.0.0.0', () => {
  console.log(`Show page:   http://localhost:${port}/`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`Phone remote: http://${a.address}:${port}/remote`);
    }
  }
});

const shutdown = () => {
  show.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
