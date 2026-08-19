import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The client renders OpenUI Lang with @openuidev/react-lang's <Renderer>, so
// there's no local parser to alias — the server streams Lang source and the
// Renderer parses it in the browser.
export default defineConfig({
  plugins: [
    react(),
  ],
  server: {
    port: 5173,
    // Proxy the agent so the browser and server share an origin (no CORS in play).
    proxy: {
      '/agent': 'http://localhost:8787',
    },
  },
});
