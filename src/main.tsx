import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { callSession } from './app/call';
import { imStore } from './app/store';
import { hideNativeSplash, initPlatform, platform } from './platform';
import { IMClient, NativeQuicSocket, WebTransportSocket } from './sdk/client';
import { decodeFrame, encodeFrame } from './sdk/frame';
import { encodeEnvelope } from './sdk/messages';
import { Writer } from './sdk/proto';
import { buildWebTransportUrl, decideTransport, parseTransports, probeWebTransport, transportStats } from './sdk/transport';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing');

const render = (): void => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // The native launch screen may only disappear once React painted.
  requestAnimationFrame(hideNativeSplash);
};

// Boot the shell first: the store's REST client needs the native HTTP bridge
// (Tauri) before restore() fires on App mount.
void initPlatform().finally(render);

// Dev-only handle for the e2e harness and for poking at state in devtools.
// The explicit env escape hatch is used by the packaged-shell transport probe;
// a normal production build never sets it.
if (import.meta.env.DEV || import.meta.env.VITE_ZIM_DEV_HOOKS === '1') {
  (window as unknown as { __zim?: unknown }).__zim = imStore;
  (window as unknown as { __zimCall?: unknown }).__zimCall = callSession;
  (window as unknown as { __zimPlatform?: unknown }).__zimPlatform = platform;
  (window as unknown as { __zimPush?: unknown }).__zimPush = (opcode: number, payload: Uint8Array) => imStore.devPush(opcode, payload);
  (window as unknown as { __zimTransport?: unknown }).__zimTransport = {
    decide: decideTransport,
    parse: parseTransports,
    probe: probeWebTransport,
    stats: transportStats,
    buildWebTransportUrl,
  };
  // Transport-level harness (real WebTransport against a local gate).
  (window as unknown as { __zimSdk?: unknown }).__zimSdk = {
    IMClient,
    WebTransportSocket,
    NativeQuicSocket,
    encodeFrame,
    decodeFrame,
    encodeEnvelope,
    Writer,
  };
}

// The service worker only exists in production builds; registering it in dev
// would cache modules and fight Vite's HMR. Native shells bundle their own
// assets already and iOS WKWebView does not need an SW.
if (import.meta.env.PROD && !platform.native && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
