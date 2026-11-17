import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { callSession } from './app/call';
import { imStore } from './app/store';
import { decideTransport, parseTransports, probeWebTransport, transportStats } from './sdk/transport';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing');

// Dev-only handle for the e2e harness and for poking at state in devtools.
if (import.meta.env.DEV) {
  (window as unknown as { __zim?: unknown }).__zim = imStore;
  (window as unknown as { __zimCall?: unknown }).__zimCall = callSession;
  (window as unknown as { __zimPush?: unknown }).__zimPush = (opcode: number, payload: Uint8Array) => imStore.devPush(opcode, payload);
  (window as unknown as { __zimTransport?: unknown }).__zimTransport = {
    decide: decideTransport,
    parse: parseTransports,
    probe: probeWebTransport,
    stats: transportStats,
  };
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker only exists in production builds; registering it in dev
// would cache modules and fight Vite's HMR.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
