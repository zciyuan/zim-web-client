# AGENTS.md — 三端同步开发约定

这个仓库是 **ZIM 的 Web / PC / App 共用前端**。任何功能开发都必须同时考虑三端，禁止只改 Web。

## 每次改动前

1. 读 `docs/platform-matrix.md`，确认改动属于「业务/UI」「壳能力」还是「展示适配」。
2. 需要壳能力时，先在 `src/platform/` 定义抽象，再分别接 Tauri（`src-tauri/`）与 Capacitor（`android/`、`ios/`）。

## 硬性规则

- 除 `src/platform/` 外，**禁止** import `@tauri-apps/*`、`@capacitor/*`。
- 禁止用 `navigator.userAgent` 决定布局；布局用 Tailwind 断点（`md:`）和 CSS 安全区变量（`--safe-*`）。
- 新增原生插件/权限时，三处同步：Cargo 依赖 + Rust 注册 + capabilities；Capacitor 配置 + AndroidManifest + Info.plist。
- 修改版本号时同步：`package.json`、`src-tauri/tauri.conf.json`、`android/app/build.gradle`。
- Web 端行为不得回退：PWA manifest、service worker、同源代理（留空接入地址）必须保持可用。

## 每次改动后

```bash
npm run check:platforms   # 平台契约、权限、版本、边界
npm run typecheck
npm run build
```

涉及 UI 时再跑：

```bash
npm run dev               # 另一个终端
npm run e2e:platforms     # 桌面 + 手机布局与截图
npm run e2e:friends       # 好友申请同意/拒绝回归
npm run e2e:transport     # QUIC/WebTransport 协商、适配器、WS 回退
npm run e2e               # 双账号消息链路
```

涉及壳层时：

```bash
npm run build:pc          # Windows 安装包
npm run build:android     # Android APK
```

## 交付判断

一个功能算“完成”，必须满足：

- Web/PWA：`npm run build` 通过，关键路径可用；
- PC：安装包能构建，桌面窗口/托盘/通知/导出路径未退化；
- App：`cap sync` 后 APK 能构建，Android 返回键、安全区、状态栏、键盘行为正常；
- iOS：工程能 `cap sync`，权限声明完整（Windows 上无法编译，需在 macOS 验证）；
- `_output/screens/platforms/` 有最新的桌面与手机截图。
