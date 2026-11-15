import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { imStore } from './app/store';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing');

// Dev-only handle for the e2e harness and for poking at state in devtools.
if (import.meta.env.DEV) {
  (window as unknown as { __zim?: unknown }).__zim = imStore;
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
