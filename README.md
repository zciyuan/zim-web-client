# ZIM Web（React 三端前端）

**一套 React + TypeScript 代码，覆盖 Web / PC / App。** 协议层（WebSocket 帧 + protobuf + REST）在 `src/sdk/`，与 UI 无关；页面在 `src/components/`。

> 技术决策：`ZIM` 仓库 `docs/adr/0029-frontend-react-multiplatform.md`。
> 接口契约：`ZIM` 仓库 `docs/ZIM-02-业务与接口规范.md` §2（WS）、§3（REST）。
> 本仓库是**独立前端工程**，不进 `ZIM` 后端仓。

## 交付形态（重要）

| 端 | 形态 | 状态 |
|---|---|---|
| Web | `dist/` 静态托管 + 反向代理 `/v1`、`/ws`、`/rtc` | ✅ 已实现并持续联调（本地 + 线上 `https://120.55.6.180:12004`） |
| App（PWA） | `manifest.webmanifest` + `sw.js`，浏览器安装到主屏 | ✅ 已内置，随 Web 一起发布 |
| PC（Tauri 2） | `src-tauri/` 复用同一份 `dist/` | 🟡 **脚手架**：已配置 `devUrl`/`frontendDist`，但需要 Rust 工具链 + `@tauri-apps/cli` 才能真正构建，尚未产出安装包 |
| App（Capacitor） | `capacitor.config.ts` 指向 `dist/` | 🟡 **脚手架**：需要安装 Capacitor 包并 `cap add android/ios`，尚未生成原生工程 |

> 也就是说：**代码是一套**（业务、协议、UI 全在 `src/`，三端共享），但**交付验证过的只有 Web + PWA**；
> PC/移动原生壳是预留接口，未构建、未联调。壳层差异（QUIC/WebTransport、原生推送、后台保活、音频会话、权限）见下文。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | **React 19 + TypeScript 7** | 严格模式（`strict` + 未使用变量报错） |
| 样式 | **Tailwind CSS v4** | `@tailwindcss/vite`，无 `tailwind.config.js` |
| 构建 | **Vite 8** | 产物 `dist/`，gzip 后 JS ≈ 83 KB |
| Web | 直接部署 `dist/` | 静态托管 + `/v1`、`/ws`、`/rtc` 反向代理 |
| PC | **Tauri 2**（或 Electron） | `src-tauri/`，复用同一份 `dist/`（脚手架，未构建） |
| App | **PWA**（已内置 manifest + service worker）/ Capacitor（可选） | `public/manifest.webmanifest`、`capacitor.config.ts`（脚手架，未构建） |
| 传输 | WS（默认）/ QUIC 协商层 | `src/sdk/transport.ts`：解析 `transports`、灰度、200ms 回退；Web 只能 WS |

## 目录

```
zim-web/
├── src/
│   ├── sdk/                 # 与 UI 无关的 IM SDK（可被 CLI/壳复用）
│   │   ├── types.ts         # 线协议类型（snake_case，int64 = string）
│   │   ├── proto.ts         # protobuf 编解码（int64 → BigInt）
│   │   ├── messages.ts      # opcode + 各消息编解码
│   │   ├── frame.ts         # [len4][ver1][op2][seq4] 帧
│   │   ├── client.ts        # WS 传输：seq 关联 / 推送 / 重连 / 踢下线
│   │   ├── rest.ts          # REST /v1（统一解包 {code,data,message}）
│   │   └── history.ts       # 历史消息窗口扫描（前向游标）
│   ├── app/
│   │   ├── store.ts         # 连接 + REST + UI 状态（useSyncExternalStore）
│   │   └── format.ts        # 时间/预览/头像/角色格式化
│   ├── components/          # LoginView / Workspace / ChatPanel / MembersDialog …
│   ├── App.tsx
│   └── main.tsx
├── public/                  # PWA 清单、图标、service worker
├── src-tauri/               # Tauri 2 桌面壳
├── capacitor.config.ts      # Capacitor 移动壳（可选）
└── e2e/ui.mjs               # 双标签页 alice/bob 真实联调 + 截图
```

## 开发

```bash
npm install
npm run dev        # http://127.0.0.1:5280  （5173 落在本机保留端口段，故用 5280）
```

开发代理（`vite.config.ts`）把 `/v1` 转发到 `http://127.0.0.1:8080`、`/ws` 转发到 `ws://127.0.0.1:3553`，因此浏览器同源，**zim-api 不需要 CORS**。可用环境变量覆盖：

```bash
ZIM_API=http://10.0.0.5:8080 ZIM_WS=ws://10.0.0.5:3553 npm run dev
```

## 构建与校验

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc + vite build → dist/
npm run preview     # 预览产物（:4173）
npm run e2e         # 需要 dev server 与后端栈在跑
```

`npm run e2e` 用 `puppeteer-core` 拉起无头 Chrome，两个标签页分别登录 alice / bob，验证：登录 → 打开会话 → 发消息 → 对端 **1901 实时到达** → 回复落地为 `sent` → 群线程可打开 → PWA manifest 可读。截图输出到 `_output/screens/`。

> 群成员弹窗（`GET /v1/groups/{gid}/members` + `GET /v1/users?uids=`）当前未纳入自动化断言，只做了手工验证。

## 三端打包

### PC（Tauri 2）

> 状态：**脚手架**（`src-tauri/` 有 `Cargo.toml`/`tauri.conf.json`/图标，但没有 `Cargo.lock`/`target/`，即从未构建）。
> 本机也没有 Rust 工具链与 `@tauri-apps/cli`。

```bash
# 首次需要 Rust 工具链 + 平台依赖：https://tauri.app/start/prerequisites/
npm install -D @tauri-apps/cli
npx tauri dev      # 开发态（内嵌 devUrl）
npx tauri build    # 产出 Windows .msi/.exe、macOS .app/.dmg
```

`src-tauri/tauri.conf.json` 已把 `devUrl` 指向 `http://127.0.0.1:5280`、`frontendDist` 指向 `../dist`。

> 桌面壳里页面不在 `http://127.0.0.1:5280`，所以登录页的「接入地址」必须填服务端地址（如 `https://im.example.com`）。
> 跨域请求在壳内仍受 WebView 的 CORS 约束：生产建议网关同域，或改用 `tauri-plugin-http` 走 Rust 侧请求。

### App（PWA，推荐先走这条）

`npm run build` 后由 HTTPS 静态站点托管即可安装到主屏。已包含：

- `manifest.webmanifest`（standalone、图标、主题色）
- `sw.js`：仅缓存应用壳，**不缓存 `/v1` 与 `/ws`**
- 生产构建时在 `main.tsx` 注册

### App（Capacitor，需要原生能力时）

> 状态：**脚手架**（只有 `capacitor.config.ts`，未安装 `@capacitor/*`，也没有 `android/`、`ios/` 工程）。
> 原生推送、后台保活、音频会话需要在这一步接。

```bash
npm install -D @capacitor/cli && npm install @capacitor/core @capacitor/android @capacitor/ios
npx cap add android && npx cap add ios
npm run build && npx cap sync
npx cap open android
```

`capacitor.config.ts` 的 `webDir` 已指向 `dist`。原生推送（APNs/FCM）与后台接收仍需厂商通道配置——这部分对应 `ZIM` 的离线推送链路。

## 功能状态（2026-11）

已实现并验证：

- **消息**：单聊/群聊文本、图片、文件、语音、视频附件上传（预签名 PUT）、引用回复、转发/合并转发、撤回/编辑、reaction、会话内搜索、全局搜索、@ 提醒、未读/已读回执、草稿、多选转发、长文折叠、链接识别。
- **好友/群**：好友申请与审批、备注、黑名单、群创建/改名/公告/成员角色/禁言、群事件 1904 实时刷新、入群申请。
- **通话**：
  - 1v1 语音/视频：振铃、接听、拒绝、取消、多端抢接（phase=4）、扬声器/静音/摄像头开关；
  - 普通群：常驻房间（`target_type=2`），无振铃，横幅/卡片一键加入，`1803` 退出、最后一人结束；
  - 家庭组：振铃/自动接听保留（`target_type=3`），支持随时加入/退出与 `1805` 房间状态；
  - 通话前申请麦克风/摄像头权限，摄像头不可用自动降级语音；30s 心跳；页面卸载 best-effort `1803`。
- **协议/可靠性**：`1801` 即入房（invite token）、`1802 phase=2` token 进房、1805 对账（重连/回前台）、房间花名册看门狗（SFU 信令僵死自愈）、`180009` 换 token 重连。
- **传输协商**：读取 `transports`、按设备灰度、200ms WebTransport 探测回退；Web 端当前固定 WS（原因见 ADR）。

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

- 历史分页只能前向（`begin_seq/end_seq/limit` 无 `desc`），尾部与"更早"都用窗口扫描，见 `src/sdk/history.ts`。
- 客户端 WS 仍以 `token=` 直连；服务端 `/v1/ws/ticket` 已存在但客户端未改用它。
- **PC/移动原生壳未构建**：Tauri 需要 Rust 工具链与 `@tauri-apps/cli`；Capacitor 需要安装 `@capacitor/*` 并生成 `android/`、`ios/` 工程。当前没有安装包。
- **原生平台能力待接**：APNs/FCM 离线推送与角标、后台保活、iOS `AVAudioSession`/Android 音频焦点、原生权限弹窗。
- **QUIC**：gate 的 QUIC 是 due 自定义协议（ALPN `due-quic`，非 HTTP/3），浏览器无法直连；Web 端要等 WebTransport 网关（HTTP/3 + CONNECT）与 `transports` 下发。
- **TURN over TLS(443) 未部署**：对称 NAT/4G 下仍可能"接通但无声"。
- 服务端在 gate/push 重启后可能出现推送路由缓存失效（`not found endpoint`）：重启 `zim-push` 可恢复；`zim-node-msg` 残留绑定会让账号被反复踢下线（`closed 1006`），重启该容器可恢复。
