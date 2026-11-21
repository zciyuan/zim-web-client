# 三端自查自检记录

时间：2026-11-18 · 主机：Windows（x64）· 分支：`master`（工作区改动未提交）

## 环境

| 工具 | 版本 |
|---|---|
| Node.js / npm | v22.16.0 / 11.4.1 |
| TypeScript / Vite | 7.0.2 / 8.3.8 |
| Rust / Cargo | 1.100.0 |
| Tauri CLI | 2.12.5（tauri 2.12.6） |
| JDK | Temurin 21.0.13 |
| Android SDK | 36 / build-tools 36.0.0 / platform-tools 37.0.1 |
| Capacitor | 8.6.2 |

## Web / PWA

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 0 error |
| 生产构建 | `npm run build` | ✅ `dist/`（JS gzip ≈ 273 KB） |
| 平台契约 | `npm run check:platforms` | ✅ 75 项全部通过 |
| 布局与截图 | `npm run e2e:platforms` | ✅ 桌面 / 窄窗 / 手机布局断言，含「我的」面板 |
| 好友申请回归 | `npm run e2e:friends` | ✅ 同意/拒绝后行立即消失；模拟收件箱刷新失败仍不残留死按钮 |
| 传输协商/QUIC | `npm run e2e:transport` | ✅ transports 解析、灰度、WebTransport URL、分片帧重组、首选 WebTransport 登录、握手失败回退真实 WS 登录 |
| 双账号消息链路 | `npm run e2e` | 🟡 传输重构后连续通过前 20 步（消息/群/上传/同步/通话发起），停在真人通话媒体接通的 20s 计时（headless LiveKit 时序）；此前同一套件通过 45 步 |

截图：`_output/screens/platforms/web-desktop-chat.png`、`web-phone-list.png`、`web-phone-chat.png`、`web-phone-profile.png`。

> e2e 运行期间本地后端（`zim-gate` / `zim-push` / `zim-node-msg`）会被外部进程重启；台架已加入「接收方保持前台 + 发送用 DOM 点击」以规避 headless Chrome 冻结后台 WebSocket，但后端重启仍会造成个别步骤超时。可复现：重启后端后单独跑 `npm run e2e`。

## PC（Tauri）

| 检查 | 结果 |
|---|---|
| `cargo check` | ✅ |
| 安装包构建 | ✅ `bundle/msi/ZIM_0.1.0_x64_en-US.msi`、`bundle/nsis/ZIM_0.1.0_x64-setup.exe` |
| 运行态启动 | ✅ 窗口标题 `ZIM`，`http://tauri.localhost`，平台识别为 `tauri` / `Windows 桌面端` |
| 原生 HTTP | ✅ 通过 plugin-http 访问本地网关（URLPattern scope `http://*:*/*`） |
| WebSocket / 登录 | ✅ 经 `http://127.0.0.1:5290` 本地网关登录 alice，加载会话列表并打开 Bob 会话 |
| 运行态截图 | ✅ `_output/screens/pc/tauri-login.png`、`tauri-after-login.png`、`tauri-chat.png`、`final-launch.png` |
| 托盘 / 单实例 / 窗口状态 / 通知 / 保存对话框 | 已接入（代码 + 权限 + 构建校验）；托盘点击与保存对话框需人工交互验证 |

## QUIC / WebTransport

| 检查 | 结果 |
|---|---|
| 协商 | ✅ `transports` 解析、`ratio=0` 回退、无 WebTransport 环境回退、URL 追加 ticket/platform/sdk |
| 流适配 | ✅ CONNECT → 双向流 → 分片帧重组 → 发送（内存 session） |
| 首选路径 | ✅ mock WebTransport 服务端完成 1001 Login，`transport=webtransport` |
| 回退路径 | ✅ 首选 WebTransport 指向死端点，自动回退到真实 WS 并登录成功 |
| 真实 HTTP/3 | ✅ 从 ZIM 源码构建 `zim-gate`，Docker 网络内临时启动 UDP 12003 WebTransport gate（ECDSA 证书）；Chrome 用 `serverCertificateHashes` 登录成功：`uid=20809`、`transport=webtransport`、约 25ms。测试 gate 已移除 |
| 原生裸 QUIC（PC） | ✅ Tauri/quinn 实机登录本地 `transport=quic` gate：`transport.kind="quic"`、`nativeQuicOk=1`、约 40ms；截图 `_output/screens/quic/pc-raw-quic.png` |
| 原生裸 QUIC（Android） | ✅ Kwik 插件编译进 APK；JVM 冒烟连接本地 due-quic gate 成功（`tests=1 failures=0`）；未在真机/模拟器跑 UI |
| 原生裸 QUIC（iOS） | 🟡 未接入，自动走 WebTransport/WS |
| 默认服务端 | ⚠️ 本地 compose 默认未启用 `zim-gate-wt`/`quic`、`/v1/ws/ticket` 的 `transports` 为空，因此默认联调仍走 WS；服务端下发后自动升级 |

## App（Android）

| 检查 | 结果 |
|---|---|
| `cap sync android` | ✅ 9 个 Capacitor 插件 |
| `gradlew assembleDebug` | ✅ 全量构建 `BUILD SUCCESSFUL in 5m 07s`；增量复建 6s |
| APK | ✅ `android/app/build/outputs/apk/debug/app-debug.apk`（约 7.2 MB） |
| APK 元数据 | ✅ `com.zim.im`、versionName 0.1.0、minSdk 24、targetSdk 36 |
| 权限 | ✅ INTERNET、POST_NOTIFICATIONS（+ 通知插件 VIBRATE/WAKE_LOCK） |
| Web 资源 | ✅ `assets/public/index.html` 与全部 hashed chunks 已打包 |
| 真机/模拟器运行 | ⚠️ 本机无 Android 设备/模拟器，未做运行态验证 |

## App（iOS）

| 检查 | 结果 |
|---|---|
| `cap add ios` / `cap sync ios` | ✅ 工程、SPM 插件与权限声明生成 |
| 编译 | ⚠️ 需 macOS + Xcode，Windows 上未验证 |

## 已知未验证项

- iOS 真机编译、APNs 推送、后台音频。
- Android 真机运行（返回键、状态栏、键盘、通知权限弹窗）。
- PC 托盘点击行为与原生保存对话框的交互（已静态检查与构建验证）。
- 生产 `wss` SFU 下的 PC 通话（开发机使用 `ws`，PC 不强制 TLS 时可用；生产必须 HTTPS/WSS）。
