import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The dev server proxies /v1 and /ws so the browser stays on one origin and the
// service needs no CORS exception. Override the targets with ZIM_API / ZIM_WS.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'ZIM_');
  const api = env.ZIM_API ?? 'http://127.0.0.1:8080';
  const ws = env.ZIM_WS ?? 'ws://127.0.0.1:3553';

  // WebRTC calls and PWA install need a secure context, which a plain LAN IP is
  // not. `ZIM_HTTPS=1 npx vite` serves TLS from certs/dev-*.pem (see README).
  const https = env.ZIM_HTTPS === '1'
    ? { key: readFileSync('certs/dev-key.pem'), cert: readFileSync('certs/dev-cert.pem') }
    : undefined;

  return {
    plugins: [react(), tailwindcss()],
    server: {
      // Bind every interface (IPv4 + IPv6) so phones/other machines on the LAN
      // can open the app. Override with ZIM_HOST (e.g. 127.0.0.1 for local only).
      host: env.ZIM_HOST ?? true,
      // A dev server on the LAN is addressed by IP/hostname: skip the Host check.
      allowedHosts: env.ZIM_ALLOWED_HOSTS ? env.ZIM_ALLOWED_HOSTS.split(',') : true,
      // 5173/5180 fall inside a Windows excluded port range (5145-5244) on this
      // host, so the dev server uses 5280. Override with `vite --port`.
      port: 5280,
      strictPort: true,
      ...(https ? { https } : {}),
      proxy: {
        '/v1': { target: api, changeOrigin: true },
        '/ws': { target: ws, ws: true },
        // LiveKit signalling: browsers on the LAN reach it through this origin,
        // so calls reuse the page certificate instead of a loopback ws:// URL.
        '/rtc': { target: env.ZIM_RTC ?? 'ws://127.0.0.1:7880', ws: true },
      },
    },
    preview: { port: 4173, host: env.ZIM_HOST ?? '0.0.0.0' },
    build: { target: 'es2020', sourcemap: true },
  };
});
