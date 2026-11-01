import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the build works under any GitHub Pages sub-path.
  base: './',
  server: { host: true, port: 5174 },
  // Rapier's WebAssembly is inlined in the bundle (~1.5 MB gzipped), so the main chunk is big by design.
  build: { target: 'es2023', chunkSizeWarningLimit: 6000 },
});
