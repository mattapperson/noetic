import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The client renders with noetic's REAL OpenUI Lang parser. It's pure (imports
// only ./document, no node/memory deps), so we alias it straight to source and
// let esbuild compile the TS — no build step, no bundling the whole package.
const OPENUI_SRC = resolve(__dirname, '../../../packages/openui/src/lang');

export default defineConfig({
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      '@openui/parser': resolve(OPENUI_SRC, 'parser.ts'),
      '@openui/document': resolve(OPENUI_SRC, 'document.ts'),
    },
  },
  server: {
    port: 5173,
    // Proxy the agent so the browser and server share an origin (no CORS in play).
    proxy: {
      '/agent': 'http://localhost:8787',
    },
  },
});
