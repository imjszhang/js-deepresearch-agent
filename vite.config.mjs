import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./web/index.html', import.meta.url)),
        progress: fileURLToPath(new URL('./web/progress.html', import.meta.url)),
        results: fileURLToPath(new URL('./web/results.html', import.meta.url)),
        history: fileURLToPath(new URL('./web/history.html', import.meta.url)),
        wiki: fileURLToPath(new URL('./web/wiki.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
  test: {
    environment: 'node',
    root: '.',
    include: ['tests/**/*.test.mjs'],
  },
});
