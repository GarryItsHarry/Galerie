import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: './', // relative Pfade: läuft auch als statische Demo in einem Unterordner
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: {
    host: '0.0.0.0',
    proxy: { '/api': 'http://localhost:3000', '/files': 'http://localhost:3000' },
  },
});
