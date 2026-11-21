// Native chrome & lifecycle: status bar, keyboard theme, hardware back,
// splash screen and haptic feedback. All calls are best-effort: a missing
// plugin must never break the app.

import { platform } from './detect';
import type { ColorScheme } from './types';

export type BackHandler = () => boolean;

let backHandler: BackHandler | null = null;
let chromeScheme: ColorScheme = 'light';

const themeMeta = (): void => {
  const color = chromeScheme === 'dark' ? '#0f172a' : '#f8fafc';
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute('content', color);
  });
  document.documentElement.style.colorScheme = chromeScheme;
};

const applyCapacitorChrome = async (): Promise<void> => {
  const [{ StatusBar, Style }, { Keyboard, KeyboardStyle }] = await Promise.all([
    import('@capacitor/status-bar'),
    import('@capacitor/keyboard'),
  ]);
  await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined);
  await StatusBar.setStyle({ style: chromeScheme === 'dark' ? Style.Dark : Style.Light }).catch(() => undefined);
  await StatusBar.setBackgroundColor({ color: chromeScheme === 'dark' ? '#0f172a' : '#f8fafc' })
    .catch(() => undefined);
  await Keyboard.setStyle({ style: chromeScheme === 'dark' ? KeyboardStyle.Dark : KeyboardStyle.Light })
    .catch(() => undefined);
};

const applyTauriChrome = async (): Promise<void> => {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setTheme(chromeScheme).catch(() => undefined);
};

/** Keeps the native status bar / window theme in sync with the app theme. */
export const applySystemChrome = (scheme: ColorScheme): void => {
  if (typeof document === 'undefined') return;
  chromeScheme = scheme;
  themeMeta();
  if (platform.kind === 'tauri') void applyTauriChrome().catch(() => undefined);
  else if (platform.mobile) void applyCapacitorChrome().catch(() => undefined);
};

export const initSystemChrome = (): void => {
  const dark = document.documentElement.classList.contains('dark');
  applySystemChrome(dark ? 'dark' : 'light');
};

/** Registers the screen-level Android back handler. */
export const setHardwareBackHandler = (handler: BackHandler | null): void => {
  backHandler = handler;
};

/** Called by the Capacitor shell once so back never quits from a chat by accident. */
export const initHardwareBack = async (): Promise<void> => {
  if (!platform.mobile) return;
  const { App } = await import('@capacitor/app');
  if (platform.capabilities.hardwareBack) {
    await App.addListener('backButton', () => {
      if (backHandler?.()) return;
      void App.exitApp();
    });
  }
  // Background -> foreground must reconcile messages/rooms on iOS and Android.
  await App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) window.dispatchEvent(new Event('zim:resume'));
  });
};

/** Light haptic on navigation taps; a no-op on the web and PC. */
export const tapFeedback = (): void => {
  if (!platform.mobile) return;
  void import('@capacitor/haptics')
    .then(({ Haptics, ImpactStyle }) => Haptics.impact({ style: ImpactStyle.Light }))
    .catch(() => undefined);
};

/** Hides the native launch screen after React's first paint. */
export const hideNativeSplash = (): void => {
  if (!platform.mobile) return;
  void import('@capacitor/splash-screen')
    .then(({ SplashScreen }) => SplashScreen.hide())
    .catch(() => undefined);
};

export const exitApp = (): void => {
  if (!platform.mobile) return;
  void import('@capacitor/app').then(({ App }) => App.exitApp()).catch(() => undefined);
};
