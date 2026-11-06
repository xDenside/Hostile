import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { precompress } from './vite-precompress';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  const apiPort = Number(process.env.API_PORT || env.API_PORT || 4191);
  const webPort = Number(process.env.WEB_PORT || env.WEB_PORT || 5190);
  const lan = (process.env.LAN_MODE ?? env.LAN_MODE) === 'true';
  const apiTarget = `http://127.0.0.1:${apiPort}`;
  const guest = process.env.HOSTILE_GUEST === '1';
  const proxy = guest
    ? undefined
    : {
        '/api': { target: apiTarget, changeOrigin: false },
        '/socket.io': { target: apiTarget, ws: true, changeOrigin: false },
      };
  const input: Record<string, string> = { main: 'index.html' };
  if (!guest) input.bridge = 'bridge.html';

  return {
    plugins: [react(), precompress()],
    envDir: false,
    base: process.env.HOSTILE_BASE || '/',
    define: {
      'import.meta.env.HOSTILE_GUEST': JSON.stringify(guest ? '1' : ''),
      'import.meta.env.HOSTILE_TEST_RELAYS': JSON.stringify(process.env.HOSTILE_TEST_RELAYS ?? ''),
    },
    ...(guest ? { cacheDir: 'node_modules/.vite-guest' } : {}),
    server: {
      host: lan ? '0.0.0.0' : '127.0.0.1',
      port: webPort,
      strictPort: true,
      ...(process.env.VITE_NO_WATCH ? { watch: null } : {}),
      proxy,
    },
    preview: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
      proxy,
    },
    build: {
      outDir: 'dist',
      assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
      sourcemap: true,
      rollupOptions: { input },
      target: 'es2022',
      chunkSizeWarningLimit: 1500,
    },
    css: {
      modules: { localsConvention: 'camelCaseOnly' },
    },
  };
});
