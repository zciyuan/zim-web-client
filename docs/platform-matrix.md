# 三端平台矩阵（Web / PC / App）

本仓库只有**一份业务代码**：`src/sdk/`（协议）、`src/app/`（状态）、`src/components/`（UI）。
三端的差异只允许出现在 `src/platform/` 与三个壳目录：

| 目标 | 壳/产物 | 入口 | 构建命令 |
|---|---|---|---|
| Web | 静态站点 `dist/` + 反向代理 `/v1` `/ws` `/rtc` | `index.html` | `npm run build` |
| PWA | `public/manifest.webmanifest` + `public/sw.js`，随 Web 发布 | 同上 | `npm run build` |
| PC | Tauri 2（`src-tauri/`），Windows `.msi` / `.exe` | `src-tauri/src/main.rs` | `npm run build:pc` |
| App | Capacitor 8（`android/`、`ios/`），APK / Xcode 工程 | `capacitor.config.json` | `npm run build:android` / `build:ios` |

## 平台能力

`src/platform/detect.ts` 在启动时判定 `platform.kind`：
`web` | `pwa` | `tauri` | `android` | `ios`，并提供 `capabilities`：

| 能力 | Web/PWA | PC (Tauri) | App (Capacitor) |
|---|---|---|---|
| `nativeHttp`（绕过 WebView CORS） | 否（同源代理） | 是（plugin-http） | 是（CapacitorHttp） |
| `nativeNotifications` | Notification API | 系统通知 | 本地通知 |
| `chooseFileSaveLocation` | 浏览器下载 | 原生保存对话框 | 系统分享面板 |
| `externalBrowser` | 新标签页 | 系统浏览器 | 应用内浏览器 |
| `hardwareBack` | — | — | Android 返回键 |
| `installPrompt` | `beforeinstallprompt` | — | — |
| `windowState` | — | 记住窗口大小/位置 | — |
| `xhrUploadProgress` | 是 | 否（走原生 fetch） | 否（走原生 fetch） |

## 传输（QUIC / WebTransport）

三端共用 `src/sdk/transport.ts` + `client.ts`：

- 登录后从 `GET /v1/ws/ticket` 读取 `ws` / `quic` / `webtransport`；
- **PC/Android 原生裸 QUIC**：服务端下发 `quicAddr` 且对应壳具备 bridge 时，优先直连 `due-quic`（PC: Rust quinn；Android: Kwik 原生插件）；iOS 未接入原生 QUIC；
- 浏览器/WebView 支持 WebTransport 且服务端下发时，走 QUIC/HTTP3（一条双向流承载原帧格式）；
- 失败顺序 `quic → webtransport → ws`，回退后本次会话不再反复尝试；断线重连重新领取一次性 ticket；
- 裸 QUIC 用 1001 Login 的 token 认证，不消耗 ticket。

服务端部署与证书要求见 [quic-webtransport.md](quic-webtransport.md)、[native-quic.md](native-quic.md)。

## 代码边界（强制）

1. **只有 `src/platform/` 可以 import `@tauri-apps/*` 或 `@capacitor/*`**。`npm run check:platforms` 会扫描并失败。
2. UI 通过 `usePlatform()`、`saveTextFile()`、`showNotification()`、`setHardwareBackHandler()` 等抽象调用壳能力。
3. 新增功能时，先判断它属于：
   - 业务/UI：只写一份，三端自动获得；
   - 壳能力：在 `src/platform/` 增加能力，同时在三个壳里补齐实现与权限；
   - 纯展示适配：用 CSS 断点 / `--safe-*` 变量，不要用 UA 判断布局。
4. 新增原生权限或插件时，必须同步：
   - PC：`src-tauri/Cargo.toml` + `src-tauri/src/main.rs` + `src-tauri/capabilities/default.json`
   - App：`capacitor.config.json` + `android/.../AndroidManifest.xml` + `ios/App/App/Info.plist`
5. 改完跑 `npm run check:platforms`；版本号改动时同步 `package.json`、`src-tauri/tauri.conf.json`、`android/app/build.gradle`。

## 三端验证

```bash
npm run check            # typecheck + web build + 平台契约静态检查
npm run dev              # https://127.0.0.1:5280
npm run e2e:platforms    # 桌面/手机布局 + 截图（_output/screens/platforms）
npm run e2e              # 双账号真实消息链路
npm run build:pc         # PC 安装包（需要 Rust + MSVC）
npm run build:android    # Android APK（需要 JDK 21 + Android SDK 36）
```

App 的 iOS 工程可在 macOS 上用 Xcode 打开 `ios/App/App.xcworkspace`；Windows 上只能生成/同步工程，不能编译 iOS。

## 壳层差异说明

- **PC**：关闭窗口收进托盘，WebSocket 保持在线；托盘左键恢复、菜单退出；二次启动聚焦已运行实例；窗口状态自动恢复。
- **App**：状态栏/键盘随主题切换；Android 返回键优先关弹窗 → 退出会话 → 回会话列表 → 退出应用；后台回前台会触发同步对账。
- **通话**：三端共用 WebRTC/LiveKit 代码。App 已在 `Info.plist` 声明摄像头/麦克风/相册权限与后台音频；Android 录音权限由 WebView 在运行时申请。TLS（wss）是生产环境的前提。
- **登录**：Web/PWA 可留空接入地址（同源代理）；PC/App 必须填写 `https://` 服务器地址。
