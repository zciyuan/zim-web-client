import type { PlatformInfo, PlatformKind } from './types';

const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.1.0';

interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

const capacitor = (): CapacitorBridge | undefined =>
  (typeof window === 'undefined' ? undefined : (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor);

const isTauriRuntime = (): boolean => {
  if (typeof window === 'undefined') return false;
  const candidate = window as unknown as { __TAURI_INTERNALS__?: unknown; isTauri?: boolean };
  return candidate.isTauri === true || candidate.__TAURI_INTERNALS__ !== undefined;
};

const isCapacitorRuntime = (): boolean => {
  const bridge = capacitor();
  if (!bridge) return false;
  if (typeof bridge.isNativePlatform === 'function') return bridge.isNativePlatform();
  return bridge.getPlatform !== undefined && bridge.getPlatform() !== 'web';
};

const isStandalone = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function'
    && (window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: window-controls-overlay)').matches)) {
    return true;
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
};

const desktopLabel = (): string => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) return 'Windows 桌面端';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS 桌面端';
  if (/Linux/i.test(ua)) return 'Linux 桌面端';
  return '桌面端';
};

const detectKind = (): PlatformKind => {
  if (typeof window === 'undefined') return 'web';
  if (isTauriRuntime()) return 'tauri';
  if (isCapacitorRuntime()) {
    const raw = capacitor()?.getPlatform?.() ?? '';
    return raw === 'ios' ? 'ios' : 'android';
  }
  return isStandalone() ? 'pwa' : 'web';
};

const buildInfo = (kind: PlatformKind): PlatformInfo => {
  const native = kind === 'tauri' || kind === 'android' || kind === 'ios';
  const desktop = kind === 'tauri';
  const mobile = kind === 'android' || kind === 'ios';
  const label = kind === 'tauri'
    ? desktopLabel()
    : kind === 'android'
      ? 'Android App'
      : kind === 'ios'
        ? 'iOS App'
        : kind === 'pwa'
          ? 'PWA 应用'
          : 'Web 浏览器';

  return {
    kind,
    family: desktop ? 'pc' : mobile || kind === 'pwa' ? 'app' : 'web',
    label,
    version: APP_VERSION,
    native,
    desktop,
    mobile,
    capabilities: {
      nativeHttp: native,
      nativeNotifications: native || (typeof Notification !== 'undefined' && typeof window !== 'undefined'),
      chooseFileSaveLocation: kind === 'tauri',
      externalBrowser: native,
      hardwareBack: kind === 'android',
      installPrompt: kind === 'web',
      windowState: kind === 'tauri',
      xhrUploadProgress: !native,
      // PC uses the quinn bridge; Android uses the Capacitor ZimQuic plugin.
      nativeQuic: kind === 'tauri' || kind === 'android',
    },
  };
};

/** Static description of the running shell (computed once at boot). */
export const platform: PlatformInfo = buildInfo(detectKind());

/** Cheap checks shared by the rest of the app. */
export const isWebShell = platform.family === 'web';
export const isPcShell = platform.family === 'pc';
export const isAppShell = platform.family === 'app';
export const isNativeShell = platform.native;
