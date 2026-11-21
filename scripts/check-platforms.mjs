// Static three-platform contract check.
//
// The project ships one React bundle to Web, PC (Tauri) and App (Capacitor).
// This script fails fast when a change makes one shell stale: config drift,
// shell packages imported outside src/platform, missing native permissions or
// a lost PWA manifest field.
//
//   npm run check:platforms

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));
const failures = [];
const passes = [];

const check = (name, ok, detail = '') => {
  if (ok) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
};

const pkg = JSON.parse(read('package.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const capacitor = JSON.parse(read('capacitor.config.json'));
const capability = JSON.parse(read('src-tauri/capabilities/default.json'));
const manifest = JSON.parse(read('public/manifest.webmanifest'));

// ---------------------------------------------------------------- layout --
const requiredFiles = [
  'src/platform/index.ts',
  'src/platform/detect.ts',
  'src/platform/runtime.ts',
  'src/platform/http.ts',
  'src/platform/quic.ts',
  'src/sdk/quic.ts',
  'src-tauri/src/quic.rs',
  'android/app/src/main/java/com/zim/im/ZimQuicPlugin.java',
  'android/app/src/main/java/com/zim/im/MainActivity.java',
  'docs/native-quic.md',
  'docs/quic-webtransport.md',
  'src/platform/notifications.ts',
  'src/platform/files.ts',
  'src/platform/chrome.ts',
  'src-tauri/src/main.rs',
  'src-tauri/tauri.conf.json',
  'src-tauri/capabilities/default.json',
  'capacitor.config.json',
  'android/app/src/main/AndroidManifest.xml',
  'android/app/src/main/res/values/colors.xml',
  'ios/App/App/Info.plist',
  'public/manifest.webmanifest',
  'docs/platform-matrix.md',
];
for (const file of requiredFiles) check(`file ${file}`, exists(file));

// ------------------------------------------------------ platform boundary --
const sources = walk('src').filter((file) => /\.(ts|tsx)$/.test(file));
const outsidePlatform = sources.filter((file) => !file.startsWith('src/platform/')
  && /(?:from\s+|import\s*\(\s*)['"]@(?:tauri-apps|capacitor)\//.test(read(file)));
check('no shell SDK imports outside src/platform', outsidePlatform.length === 0, outsidePlatform.join(', '));

const platformIndex = exists('src/platform/index.ts') ? read('src/platform/index.ts') : '';
for (const symbol of ['platform', 'initPlatform', 'saveTextFile', 'showNotification', 'usePlatform', 'nativeQuicBridge']) {
  check(`platform exports ${symbol}`, platformIndex.includes(symbol));
}

const cargo = read('src-tauri/Cargo.toml');
const appGradle = read('android/app/build.gradle');
check('Tauri depends on quinn for raw QUIC', cargo.includes('quinn'));
check('Android depends on Kwik for raw QUIC', appGradle.includes('tech.kwik:kwik'));
check('platform capabilities expose nativeQuic', read('src/platform/types.ts').includes('nativeQuic'));
check('Android plugin registered in MainActivity', read('android/app/src/main/java/com/zim/im/MainActivity.java').includes('ZimQuicPlugin.class'));

// ---------------------------------------------------------------- scripts --
const requiredScripts = ['dev', 'dev:pc', 'build', 'build:pc', 'build:android', 'build:ios', 'sync:app', 'check:platforms', 'e2e:platforms', 'e2e:friends', 'e2e:transport'];
for (const script of requiredScripts) check(`script ${script}`, Boolean(pkg.scripts?.[script]));

// ------------------------------------------------------------------- PWA --
check('PWA manifest start_url', manifest.start_url === '/');
check('PWA manifest standalone display', manifest.display === 'standalone');
check('PWA manifest icons >= 3', Array.isArray(manifest.icons) && manifest.icons.length >= 3);
check('PWA manifest lang zh-CN', manifest.lang === 'zh-CN');
const indexHtml = read('index.html');
check('viewport-fit=cover', indexHtml.includes('viewport-fit=cover'));
check('manifest registered in index.html', indexHtml.includes('manifest.webmanifest'));
check('boot theme script present', indexHtml.includes("localStorage.getItem('zim.theme')"));
check('service worker exists', exists('public/sw.js'));

// ------------------------------------------------------------------- PC ---
const windowConfig = tauri.app?.windows?.[0] ?? {};
check('Tauri productName ZIM', tauri.productName === 'ZIM');
check('Tauri version matches package.json', tauri.version === pkg.version, `${tauri.version} != ${pkg.version}`);
check('Tauri window minWidth >= 900', Number(windowConfig.minWidth) >= 900);
check('Tauri frontendDist points at dist', tauri.build?.frontendDist === '../dist');
const permissions = JSON.stringify(capability.permissions ?? []);
for (const permission of ['http:', 'notification:', 'dialog:', 'fs:', 'opener:', 'window-state:']) {
  check(`Tauri capability ${permission}`, permissions.includes(permission));
}
check('Tauri HTTP scope uses URLPattern wildcards', permissions.includes('http://*:*/*') && permissions.includes('https://*:*/*'));
const rust = read('src-tauri/src/main.rs');
for (const plugin of ['http', 'notification', 'dialog', 'fs', 'opener', 'window-state', 'single-instance']) {
  check(`Tauri plugin ${plugin} registered`, rust.includes(`tauri_plugin_${plugin.replaceAll('-', '_')}`));
}
check('Tauri tray hides on close', rust.includes('CloseRequested') && rust.includes('prevent_close'));
check('Tauri bundle icon.ico', read('src-tauri/tauri.conf.json').includes('icon.ico'));
check('Tauri icon.ico file', exists('src-tauri/icons/icon.ico'));

// ------------------------------------------------------------------ App ---
check('Capacitor appId', capacitor.appId === 'com.zim.im');
check('Capacitor webDir dist', capacitor.webDir === 'dist');
check('Capacitor native HTTP patch', capacitor.plugins?.CapacitorHttp?.enabled === true);
check('Capacitor status bar plugin', Boolean(capacitor.plugins?.StatusBar));
check('Capacitor keyboard plugin', Boolean(capacitor.plugins?.Keyboard));
check('Capacitor Android project', exists('android/app/build.gradle'));
check('Capacitor iOS project', exists('ios/App/App/Info.plist'));
const androidManifest = read('android/app/src/main/AndroidManifest.xml');
check('Android INTERNET permission', androidManifest.includes('android.permission.INTERNET'));
check('Android POST_NOTIFICATIONS permission', androidManifest.includes('android.permission.POST_NOTIFICATIONS'));
check('Android adjustResize', androidManifest.includes('adjustResize'));
check('Android debug cleartext', exists('android/app/src/debug/AndroidManifest.xml')
  && read('android/app/src/debug/AndroidManifest.xml').includes('usesCleartextTraffic="true"'));
const androidGradle = read('android/app/build.gradle');
check('Android versionName matches package.json', androidGradle.includes(`versionName "${pkg.version}"`));
const infoPlist = read('ios/App/App/Info.plist');
for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'UIBackgroundModes']) {
  check(`iOS Info.plist ${key}`, infoPlist.includes(key));
}

// ---------------------------------------------------------------- summary --
for (const line of passes) console.log(`ok   ${line}`);
if (failures.length > 0) {
  console.error('');
  for (const line of failures) console.error(`FAIL ${line}`);
  console.error(`\n${failures.length} platform contract check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${passes.length} platform contract checks passed.`);
