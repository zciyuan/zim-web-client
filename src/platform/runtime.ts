// One boot hook for every delivery target. main.tsx awaits it before the first
// render so the store can construct its REST client with the native HTTP bridge.

import { platform } from './detect';
import { initHardwareBack, initSystemChrome } from './chrome';
import { initPlatformHttp } from './http';
import { initLinkInterceptor } from './links';
import { initPwaInstallPrompt } from './pwa';

let started = false;

const initTauriShell = async (): Promise<void> => {
  // Restore the previous window size/position before the first paint.
  const { restoreStateCurrent } = await import('@tauri-apps/plugin-window-state');
  await restoreStateCurrent().catch(() => undefined);
};

/**
 * Marks the document with the shell identity, starts native bridges and wires
 * global listeners. Idempotent, so StrictMode double-effects are harmless.
 */
export const initPlatform = async (): Promise<void> => {
  if (started) return;
  started = true;
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.classList.add(`platform-${platform.kind}`, `family-${platform.family}`);
    root.dataset.platform = platform.kind;
    root.dataset.family = platform.family;
    root.dataset.appVersion = platform.version;
  }
  initSystemChrome();
  initLinkInterceptor();
  initPwaInstallPrompt();

  const native = [
    initPlatformHttp(),
    platform.mobile ? initHardwareBack() : Promise.resolve(),
    platform.kind === 'tauri' ? initTauriShell() : Promise.resolve(),
  ];
  await Promise.allSettled(native);
  if (import.meta.env.DEV) {
    (window as unknown as { __zimPlatform?: unknown }).__zimPlatform = platform;
  }
};
