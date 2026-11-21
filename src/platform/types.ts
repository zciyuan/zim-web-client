// Platform contract shared by the Web, PC (Tauri) and App (Capacitor/PWA)
// shells. UI code must branch on these capability flags instead of sniffing the
// user agent, and every shell-specific API lives under src/platform/.

export type PlatformKind = 'web' | 'pwa' | 'tauri' | 'android' | 'ios';

/** Delivery target: browser, desktop shell, or installed app. */
export type PlatformFamily = 'web' | 'pc' | 'app';

export interface PlatformCapabilities {
  /** REST/upload traffic needs a native bridge to bypass WebView CORS. */
  nativeHttp: boolean;
  /** System notifications are available through a native bridge. */
  nativeNotifications: boolean;
  /** A save dialog lets the user choose where exported files land. */
  chooseFileSaveLocation: boolean;
  /** External links must be handed to the system browser. */
  externalBrowser: boolean;
  /** Android hardware back button reaches the web layer. */
  hardwareBack: boolean;
  /** The browser exposes beforeinstallprompt (installable PWA). */
  installPrompt: boolean;
  /** The shell restores window size/position between launches. */
  windowState: boolean;
  /** XHR upload progress is reliable (plain browser / PWA). */
  xhrUploadProgress: boolean;
  /** A native raw-QUIC bridge (due-quic ALPN) is available. */
  nativeQuic: boolean;
}

export interface PlatformInfo {
  kind: PlatformKind;
  family: PlatformFamily;
  /** Human-readable target shown on the login screen and in Settings. */
  label: string;
  /** Client version injected at build time from package.json. */
  version: string;
  native: boolean;
  desktop: boolean;
  mobile: boolean;
  capabilities: PlatformCapabilities;
}

export type ColorScheme = 'light' | 'dark';

export type SaveOutcome = 'saved' | 'downloaded' | 'shared' | 'cancelled' | 'failed';

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';
