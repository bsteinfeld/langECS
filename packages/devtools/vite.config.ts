import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds the inspector UI into dist/ui, next to tsdown's dist/index.js.
// `pnpm build` runs tsdown first (it cleans dist/), then this.
export default defineConfig({
  root: 'ui',
  plugins: [react()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
  },
  server: {
    // `pnpm dev:ui` for developing the UI itself: proxy live data to a
    // running devtools server (e.g. the examples/devtools-demo world).
    proxy: {
      '/ws': { target: 'ws://localhost:4477', ws: true },
      '/v1': 'http://localhost:4477',
    },
  },
});
