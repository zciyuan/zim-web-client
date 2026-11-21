# ZIM 三端客户端（React + TypeScript）

**一套 React + TypeScript 代码，交付 Web / PC / App。** 协议层（WebSocket / WebTransport 帧 + protobuf + REST）在 `src/sdk/`，业务状态在 `src/app/`，界面在 `src/components/`；三端差异全部收敛在 `src/platform/` 和三个壳目录里。

> 技术决策：`ZIM` 仓库 `docs/adr/0029-frontend-react-multiplatform.md`。
> 接口契约：`ZIM` 仓库 `docs/ZIM-02-业务与接口规范.md` §2（WS）、§3（REST）。
> 本仓库是**独立前端工程**，不进 `ZIM` 后端仓。
> 三端同步开发约定见 [AGENTS.md](AGENTS.md)，能力矩阵见 [docs/platform-matrix.md](docs/platform-matrix.md)，QUIC/WebTransport 接入见 [docs/quic-webtransport.md](docs/quic-webtransport.md)，PC/Android 原生裸 QUIC 见 [docs/native-quic.md](docs/native-quic.md)。

## 交付形态

| 端 | 形态 | 状态 |
|---|---|---|
| Web | `dist/` 静态托管 + 反向代理 `/v1`、`/ws`、`/rtc` | ✅ 已实现并持续联调 |
| PWA | `manifest.webmanifest` + `sw.js`，随 Web 发布 | ✅ 已内置，可安装到桌面/主屏 |
| PC | Tauri 2（`src-tauri/`），复用同一份 `dist/` | ✅ 可构建 `.msi` / `.exe`，托盘/窗口状态/原生通知/原生 HTTP/保存对话框已接 |
| App（Android） | Capacitor 8（`android/`），复用同一份 `dist/` | ✅ 原生工程已生成，状态栏/键盘/返回键/安全区/分享导出已接 |
| App（iOS） | Capacitor 8（`ios/`） | 🟡 工程与权限声明已生成；需 macOS + Xcode 编译验证 |

## 三端架构

```
src/
├── sdk/                 # 与 UI/壳无关的 IM SDK（WS/WebTransport、protobuf、REST、历史、通话信令）
├── app/                 # 连接、REST、UI 状态（store / call / format）
├── components/          # 一套响应式界面（桌面 Rail+Sidebar+Chat，手机 BottomTab+Chat）
└── platform/            # 唯一允许接触原生壳的目录
    ├── detect.ts        # web | pwa | tauri | android | ios + capabilities
    ├── http.ts          # PC 走 Tauri plugin-http，App 走 CapacitorHttp，Web 走 fetch
    ├── notifications.ts # 浏览器 / Tauri / Capacitor 本地通知
    ├── files.ts         # 浏览器下载 / 原生保存对话框 / 系统分享
    ├── chrome.ts        # 状态栏、键盘主题、Android 返回键、启动屏、触感
    ├── pwa.ts           # beforeinstallprompt
    └── runtime.ts       # 启动引导（main.tsx 在首帧前 await）
```

- **业务/UI 只写一份**：新功能默认三端同时获得。
- **壳能力先抽象**：在 `src/platform/` 增加能力，再在 Tauri/Capacitor 两侧补齐实现与权限。
- **布局只用断点与安全区**：`md:` 断点 + `--safe-*` CSS 变量，不用 UA 判断布局。

## 开发

```bash
npm install
npm run dev        # https://127.0.0.1:5280（ZIM_HTTPS=1 时启用 TLS）
```

开发代理（`vite.config.ts`）把 `/v1` 转发到 `http://127.0.0.1:8080`、`/ws` 转到 `ws://127.0.0.1:3553`、`/rtc` 转到 LiveKit，浏览器保持同源。可用环境变量覆盖：

```bash
ZIM_API=http://10.0.0.5:8080 ZIM_WS=ws://10.0.0.5:3553 npm run dev
```

PC/App 原生壳从本地加载页面，需要一个**同时提供 `/v1` 与 `/ws` 的单一来源**。本地联调时另开一个 HTTP 网关（不带 TLS，避免自签证书问题）：

```bash
npm run dev:gateway     # http://127.0.0.1:5290，代理 /v1 /ws /rtc
```

然后在 PC/App 的「接入地址」里填 `http://127.0.0.1:5290`（真机用电脑的局域网 IP）。生产环境填网关的 `https://` 地址。

## 构建与校验

```bash
npm run typecheck        # tsc --noEmit
npm run build            # tsc + vite build → dist/
npm run check:platforms  # 三端契约静态检查（边界/权限/版本/PWA/原生工程）
npm run check            # typecheck + build + check:platforms
npm run e2e              # 双账号真实消息链路（需要 dev server + 后端栈）
npm run e2e:platforms    # 桌面/手机布局断言 + 截图（_output/screens/platforms）
npm run e2e:friends      # 好友申请同意/拒绝回归（含刷新失败场景）
npm run e2e:transport    # 传输协商、WebTransport 适配器、WS 回退
```

## PC（Tauri 2）

```bash
npm run build:pc     # = tauri build，产物在 src-tauri/target/release/bundle/
npm run dev:pc       # = tauri dev，自动拉起 Vite
```

已接入的桌面能力：

- 关闭窗口收进**托盘**，WebSocket 保持在线；托盘左键恢复，菜单可退出；
- **单实例**：重复启动只聚焦已有窗口，避免同账号双连接互踢；
- **窗口状态**恢复（大小/位置/最大化）；
- **系统通知**（Tauri notification plugin）；
- **原生 HTTP**（plugin-http）绕过 WebView CORS，登录页填写 `https://` 服务器地址即可；
- **导出聊天记录**使用原生保存对话框 + 文件系统写入；
- 聊天中的链接交给系统浏览器打开。

> 安装包：`src-tauri/target/release/bundle/msi/ZIM_0.1.0_x64_en-US.msi`、
> `src-tauri/target/release/bundle/nsis/ZIM_0.1.0_x64-setup.exe`（本机构建产物，不提交仓库）。

## App（PWA / Capacitor）

### PWA

`npm run build` 后由 HTTPS 站点托管即可安装到主屏。已包含：

- `manifest.webmanifest`（standalone、图标、主题色、快捷方式）
- `sw.js`：仅缓存应用壳，**不缓存 `/v1` 与 `/ws`**，导航网络优先、离线回退
- 生产构建时由 `main.tsx` 注册；原生壳内自动跳过

### Android（Capacitor）

```bash
npm run build:android    # build + cap sync + gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

首次构建需要：

- JDK 21（`JAVA_HOME`）
- Android SDK 36（`ANDROID_HOME`，含 `platforms;android-36`、`build-tools;36.0.0`、`platform-tools`）

已接入：状态栏/键盘跟随主题、Android 返回键分级处理（关弹窗 → 退会话 → 回会话列表 → 退出）、安全区适配、本地通知、系统分享导出、Haptics 轻触反馈、`CapacitorHttp` 原生网络。`android/app/src/debug/AndroidManifest.xml` 仅在 debug 构建放开明文 HTTP，release 保持 HTTPS-only。

### iOS（Capacitor）

```bash
npm run build:ios        # build + cap sync ios
open ios/App/App.xcodeproj     # 需 macOS + Xcode
```

`Info.plist` 已声明摄像头、麦克风、相册权限、后台音频与 `ITSAppUsesNonExemptEncryption=false`。Windows 上只能同步工程，不能编译 iOS。

## 功能状态（2026-11）

已实现并验证：

- **消息**：单聊/群聊文本、图片、文件、语音、视频附件上传（预签名 PUT）、引用回复、转发/合并转发、撤回/编辑、reaction、会话内搜索、全局搜索、@ 提醒、未读/已读回执、草稿、多选转发、长文折叠、链接识别。
- **好友/群**：好友申请与审批（同意/拒绝后立即从收件箱移除，刷新失败也不会留下无法操作的行）、备注、黑名单、群创建/改名/公告/成员角色/禁言、群事件 1904 实时刷新、入群申请。
- **通话**：1v1 与群/家庭房间的振铃、接听、拒绝、取消、多端抢接、常驻房间、权限预检、摄像头不可用降级语音、30s 心跳、`1801/1802/1803/1805/180009` 全链路。
- **协议/可靠性**：1805 对账、房间花名册看门狗、`transports` 协商与 200ms WebTransport 回退、断线重连与增量同步。
- **传输**：登录后从 `/v1/ws/ticket` 读取 `ws` / `quic` / `webtransport`。浏览器/WebView 走 WebTransport（HTTP/3+一条双向流）；PC（Tauri/quinn）和 Android（Capacitor/Kwik）在服务端下发 `quicAddr` 时优先直连**裸 QUIC**（ALPN `due-quic`），失败按 `quic → webtransport → ws` 回退；断线重连会重新领取一次性 ticket（裸 QUIC 用 token 认证，不消耗 ticket）。
- **三端框架**：响应式双形态界面、安全区、Android 返回键、PWA 安装、桌面托盘、原生通知、原生 HTTP、原生保存/分享、平台信息面板。

## 与 ZIM 后端的契约

| 能力 | 接口 |
|---|---|
| 登录 / 刷新 / 登出 | `POST /v1/auth/token`、`POST /v1/auth/refresh`、WS `1001` / `1002` |
| 会话 / 历史 / 已读 | `GET /v1/conversations`、`GET .../{cid}/messages`、`POST .../{cid}/read`、WS `1505` |
| 发消息 | WS `1501`（单聊）、`1502`（群聊） |
| 收消息 | WS 推送 `1901`（按 `server_msg_id` 去重）、`1902` 踢下线 |
| 好友 / 群 | `GET /v1/friends`、`GET /v1/groups`、`GET /v1/groups/{gid}/members`、WS `1314` |

**ID 精度**：REST 会把 int64 序列化成 JSON number，雪花 `group_id` 会被 JS 四舍五入。所以**所有用于请求的 ID 都从字符串来源取**：`conversation_id`（`s_a_b` / `g_gid`）或 protobuf 载荷；群 gid 再用 WS `1314 MyGroups` 校正。

## 已知限制

- **iOS**：工程已生成并同步，但未在 macOS 上编译、未做真机推送/通话验证。
- **原生推送**：APNs/FCM 离线推送与角标尚未接入（需要厂商证书/通道配置）；当前使用本地通知 + 前端在线推送。
- **PC 通话**：WebView2 的 WebRTC 需要 `wss` SFU；生产环境必须为 HTTPS/WSS，开发机上可改用 Web 端验证通话。
- **PC/App 首次登录**：必须填写同时代理 `/v1` 与 `/ws` 的服务器地址；只填 API 端口会出现「ws 握手失败」。
- **历史分页**只能前向（`begin_seq/end_seq/limit` 无 `desc`），尾部与"更早"都用窗口扫描，见 `src/sdk/history.ts`。
- **QUIC**：Web/PWA 走 **WebTransport**（HTTP/3+CONNECT）；PC 用 Tauri/quinn、Android 用 Capacitor/Kwik 直连**裸 QUIC**（ALPN `due-quic`），iOS 原生裸 QUIC 尚未接入（自动回退 WebTransport/WS）。裸 QUIC 需要服务端以 `transport=quic` 部署并在 `/v1/ws/ticket` 下发 `quicAddr`，且 UDP 端口放通、证书受信任。详见 [docs/native-quic.md](docs/native-quic.md)。
- **TURN over TLS(443) 未部署**：对称 NAT/4G 下仍可能"接通但无声"。
- 服务端在 gate/push 重启后可能出现推送路由缓存失效（`not found endpoint`）：重启 `zim-push` 可恢复；`zim-node-msg` 残留绑定会让账号被反复踢下线（`closed 1006`），重启该容器可恢复。

## 通话提示“没有麦克风”的排查

权限预检（`src/app/media-devices.ts`）会先用浏览器默认设备，失败后再逐个枚举 `audioinput` 重试，因此“Windows 里耳机能说话、浏览器却说没有麦克风”分两种情况：

1. **浏览器能枚举到麦克风，但默认设备是失效的旧 deviceId**（USB 耳机换过口/重新插拔最常见）。预检会自动切到可用的输入，并用同一个 `deviceId` 让 LiveKit 发布该麦克风，Toast 提示“已切换可用的麦克风：<设备名>”。
2. **浏览器一个 `audioinput` 都枚举不到**。此时不是应用能修复的问题：
   - 远程桌面（RDP）会话默认不把本机麦克风带进会话，`mstsc` → 选项 → 本地资源 → 远程音频 → 设置 → 勾选“从这台计算机录制”后重连；服务器侧还需 `fDisableAudioCapture=0`（本仓库验证机为 0）。
   - 本机使用时检查 Windows 设置 → 隐私和安全性 → 麦克风 → “让桌面应用访问你的麦克风”。
   - Chrome 的麦克风权限被拒会单独提示，用地址栏站点设置放开即可。

可在浏览器控制台执行 `navigator.mediaDevices.enumerateDevices()` 自检：`audioinput` 为空就是第 2 种情况。