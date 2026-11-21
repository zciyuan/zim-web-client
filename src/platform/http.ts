// Native HTTP bridge.
//
// A WebView that hosts the bundle from `tauri.localhost` (PC) or
// `https://localhost` (App) is a different origin from the API, so plain fetch
// is blocked by CORS. Tauri routes requests through Rust (plugin-http); on
// Capacitor the core `CapacitorHttp` patch of window.fetch takes care of it.
//
// `platformFetch` is installed on IMHttp before any request is made and stays a
// no-op wrapper on the web.

import { platform } from './detect';

let nativeFetch: typeof fetch | null = null;
let initPromise: Promise<void> | null = null;

const withNativeBody = async (init?: RequestInit): Promise<RequestInit | undefined> => {
  if (!init || typeof Blob === 'undefined' || !(init.body instanceof Blob)) return init;
  // plugin-http accepts ArrayBuffer, not Blob; the REST layer uploads blobs.
  return { ...init, body: await init.body.arrayBuffer() };
};

export const platformFetch: typeof fetch = (input, init) => {
  const impl = nativeFetch;
  if (!impl) return globalThis.fetch(input, init);
  return withNativeBody(init).then((next) => impl(input, next));
};

/** Wires the native bridge when the shell needs one. Safe to call repeatedly. */
export const initPlatformHttp = (): Promise<void> => {
  if (platform.kind !== 'tauri') return Promise.resolve();
  initPromise ??= import('@tauri-apps/plugin-http')
    .then((mod) => {
      nativeFetch = mod.fetch as unknown as typeof fetch;
    })
    .catch((err: unknown) => {
      // Keep the plain fetch: the app still reports the real CORS/network error
      // instead of failing to boot.
      console.warn('[zim] native HTTP bridge unavailable', err);
      nativeFetch = null;
    });
  return initPromise;
};
