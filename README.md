# ZIM Web（React 三端前端）

**一套 React + TypeScript 代码，覆盖 Web / PC / App。** 协议层（WebSocket 帧 + protobuf + REST）在 `src/sdk/`，与 UI 无关；页面在 `src/components/`。

> 技术决策：`ZIM` 仓库 `docs/adr/0029-frontend-react-multiplatform.md`。
> 接口契约：`ZIM` 仓库 `docs/ZIM-02-业务与接口规范.md` §2（WS）、§3（REST）。
> 本仓库是**独立前端工程**，不进 `ZIM` 后端仓。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | **React 19 + TypeScript 7** | 严格模式（`strict` + 未使用变量报错） |
| 样式 | **Tailwind CSS v4** | `@tailwindcss/vite`，无 `tailwind.config.js` |
| 构建 | **Vite 8** | 产物 `dist/`，gzip 后 JS ≈ 83 KB |
| Web | 直接部署 `dist/` | 静态托管 + `/v1`、`/ws` 反向代理 |
| PC | **Tauri 2**（或 Electron） | `src-tauri/`，复用同一份 `dist/` |
| App | **PWA**（已内置 manifest + service worker）/ Capacitor（可选） | `public/manifest.webmanifest`、`capacitor.config.ts` |

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

```bash
npm install -D @capacitor/cli && npm install @capacitor/core @capacitor/android @capacitor/ios
npx cap add android && npx cap add ios
npm run build && npx cap sync
npx cap open android
```

`capacitor.config.ts` 的 `webDir` 已指向 `dist`。原生推送（APNs/FCM）与后台接收仍需厂商通道配置——这部分对应 `ZIM` 的离线推送链路。

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
- WS 仍以 `token=` 直连（`POST /v1/auth/ws-ticket` 未实现）。
- 未做：图片/文件上传、RTC 通话页、撤回/编辑 UI、reaction、离线推送角标。
- 服务端在 gate/push 重启后可能出现推送路由缓存失效（`not found endpoint`）：重启 `zim-push` 可恢复；`zim-node-msg` 残留绑定会让账号被反复踢下线（`closed 1006`），重启该容器可恢复。
