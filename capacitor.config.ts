// Capacitor wrapper for the same web build (optional path; PWA needs no native
// toolchain). `webDir` points at the Vite output, so `npm run build && npx cap
// sync` is the whole workflow.
//
// Required packages before use:
//   npm i -D @capacitor/cli && npm i @capacitor/core @capacitor/android @capacitor/ios
// The import is type-only so this file stays inert until Capacitor is installed.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck -- @capacitor/cli types exist only after the optional install

const config = {
  appId: 'com.zim.im',
  appName: 'ZIM',
  webDir: 'dist',
  bundledWebRuntime: false,
  server: {
    // https scheme keeps localStorage/sessionStorage and service workers usable.
    androidScheme: 'https',
  },
};

export default config;
