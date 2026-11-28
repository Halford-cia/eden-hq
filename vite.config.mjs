import { defineConfig } from 'vite';

// The browser build reads only VITE_SUPABASE_URL and
// VITE_SUPABASE_PUBLISHABLE_KEY (scripts/build-guard.mjs enforces it).
export default defineConfig({
  envPrefix: 'VITE_',
  build: {
    sourcemap: false,
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
