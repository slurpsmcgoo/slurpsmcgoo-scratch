// Vite dev server and build. In dev, the show server (WebSocket relay, config
// push, logs, /remote) runs inside Vite's own HTTP server, so `npm run dev` is
// one process with instant reload on save.

import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import { createShowServer } from './server/app.ts';

export default defineConfig({
  server: {
    host: true, // reachable from a phone on home Wi-Fi for /remote
    port: 5173,
    // show.json changes are pushed over the WebSocket instead of reloading the page.
    watch: { ignored: ['**/config/**', '**/logs/**'] },
  },
  build: { target: 'es2023', assetsInlineLimit: 0 },
  // The pose worker is an ES module worker (it loads MediaPipe's ES-module WASM loader).
  worker: { format: 'es' },
  plugins: [
    {
      name: 'show-server',
      configureServer(server) {
        // MediaPipe's loader import()s its WASM glue script from public/models/wasm/.
        // Vite's dev server refuses imports from public/ (the request gets an
        // ?import query), so serve those files as plain scripts. Builds don't need this.
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? '/', 'http://x');
          const m = /^\/models\/wasm\/([\w.-]+\.js)$/.exec(url.pathname);
          if (!m || !url.searchParams.has('import')) return next();
          fs.readFile(path.join(import.meta.dirname, 'public', 'models', 'wasm', m[1]!), (err, data) => {
            if (err) return next();
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            res.end(data);
          });
        });
        const show = createShowServer({ root: import.meta.dirname });
        server.middlewares.use((req, res, next) => void show.middleware(req, res, next));
        if (server.httpServer) show.attach(server.httpServer as import('node:http').Server);
        server.httpServer?.on('close', () => show.close());
      },
    },
  ],
});
