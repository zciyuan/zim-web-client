// Public platform surface. UI and app code import from here only; shell
// packages (Tauri/Capacitor) are loaded dynamically inside this folder.

export { platform, isAppShell, isNativeShell, isPcShell, isWebShell } from './detect';
export type {
  ColorScheme,
  NotificationPermissionState,
  PlatformCapabilities,
  PlatformFamily,
  PlatformInfo,
  PlatformKind,
  SaveOutcome,
} from './types';

export { initPlatform } from './runtime';
export {
  applySystemChrome,
  exitApp,
  hideNativeSplash,
  setHardwareBackHandler,
  tapFeedback,
  type BackHandler,
} from './chrome';
export { platformFetch } from './http';
export { nativeQuicBridge } from './quic';
export { saveTextFile } from './files';
export { openExternal } from './links';
export { notificationPermission, requestNotificationPermission, showNotification, type SystemNotification } from './notifications';
export { promptPwaInstall } from './pwa';
export { useInstallPrompt, useMediaQuery, usePlatform, type InstallPromptHandle } from './react';
