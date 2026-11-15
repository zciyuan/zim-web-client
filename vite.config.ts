import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The dev server proxies /v1 and /ws so the browser stays on one origin and the
// service needs no CORS exception. Override the targets with ZIM_API / ZIM_WS.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'ZIM_');
  const api = env.ZIM_API ?? 'http://127.0.0.1:8080';
  const ws = env.ZIM_WS ?? 'ws://127.0.0.1:3553';

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      // 5173/5180 fall inside a Windows excluded port range (5145-5244) on this
      // host, so the dev server uses 5280. Override with `vite --port`.
      port: 5280,
      strictPort: true,
      proxy: {
        '/v1': { target: api, changeOrigin: true },
        '/ws': { target: ws, ws: true },
      },
    },
    preview: { port: 4173 },
    build: { target: 'es2020', sourcemap: true },
  };
});
