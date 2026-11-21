# QUIC / WebTransport 接入

浏览器和 WebView 无法使用裸 QUIC（`due-quic` ALPN 没有 JS API），所以 Web/PWA 走 ZIM 的 **WebTransport**（HTTP/3 + CONNECT + 一条双向流），底层仍是 QUIC。PC/Android 的原生裸 QUIC 见 [native-quic.md](native-quic.md)。

> WebTransport 需要服务端 `zim-gate` 以 `transport=webtransport` 部署、下发 `webtransportUrl`；裸 QUIC 需要 `transport=quic` + `quicAddr`。两者可以同时部署，客户端优先原生 QUIC，其次 WebTransport，最后 WS。

## 前端流程

1. 登录成功后请求 `GET /v1/ws/ticket?platform=4`：
   ```json
   { "ticket": "t_…", "expires_in": 60,
     "transports": [
       { "type": "ws", "url": "wss://host/ws" },
       { "type": "webtransport", "url": "https://host:12001/wt" }
     ] }
   ```
   ticket 是一次性的（Redis `GetDel`），过期 60 秒。
2. `decideTransport` 选择：
   - 浏览器支持 `WebTransport`；
   - 有 `webtransport` 条目且设备落在 `ratio` 灰度为内；
   - 否则 WS（`webtransport-unsupported` / `default-ws` / `quic-native-only`）。
3. `IMClient` 以 **200ms** 为 QUIC 握手 + 首流窗口：
   - CONNECT `https://host:port/wt?ticket=…&platform=4&sdk=…`；
   - `await session.ready`，随后立刻 `createBidirectionalStream()`；
   - 打开成功后在同一双向流上收发不变的 `[len4][ver1][op2][seq4][Envelope]` 帧；
   - 超时/失败则本次及后续重连降级 WS，并记录 `transportStats`；UI「我的 → 传输」显示 `WebSocket（QUIC 回退）`。
4. 断线重连：
   - WebTransport 路径会通过 ticket provider 重新取 ticket（一次性）；
   - WS 路径继续使用 `token=`；
   - 已降级的会话不再反复尝试 QUIC，避免弱网下抖动。

实现位置：`src/sdk/transport.ts`（协商/URL/指标）、`src/sdk/client.ts`（WebTransport 流适配、帧重组、回退）、`src/sdk/rest.ts#wsTicket`、`src/app/store.ts#loadTransportConfig`。

## 服务端前置条件

- `zim-gate` 以 `[network] transport = "webtransport"` 启动独立 UDP 部署；
- `[network.webtransport.server]`：`addr`、`path=/wt`、TLS 1.3 证书、`handshakeTimeout`、`authorizeTimeout`、`heartbeatInterval`；
- `zim-api` 下发：
  ```toml
  [zim.transport]
  wsUrl = "wss://im.example.com/ws"
  webtransportUrl = "https://im.example.com:12001/wt"
  ```
- UDP 端口在 LB / 安全组 / DDoS 防护上放通；`webtransportUrl` 指向 UDP 入口而不是单个 Pod；
- 浏览器 Origin 在 `[zim.gate] origins` 白名单内；
- **生产必须使用受信任 CA 的证书**。WebTransport 不接受自签名证书；测试可用 `serverCertificateHashes`（ECDSA P-256、有效期 ≤14 天）或把测试 CA 装入系统信任区。

服务端设计见 ZIM 仓 `docs/adr/0040-webtransport-listener.md`；协商背景见 `docs/adr/0029-frontend-react-multiplatform.md`。

## 自检

```bash
npm run dev
npm run e2e:transport
```

覆盖：

- `transports` 解析、灰度为 0、无 WebTransport 支持、URL 构造（ticket/platform/sdk）；
- WebTransport 适配器：CONNECT → 双向流 → 分片帧重组 → 发送；
- 首选 WebTransport 的完整 `IMClient` 登录（内存 mock 服务端）；
- WebTransport 握手失败后真实 WS 登录回退；
- 真实 HTTP/3 gate（ZIM 源码构建，UDP 12003 + ECDSA `serverCertificateHashes`）登录成功：`uid=20809`、`transport=webtransport`、约 25ms。

> 当前本地 `docker compose` 默认不启动 `zim-gate-wt` / 不配置 `webtransportUrl`，所以日常 Web 联调仍走 WS；前端已就绪，服务端下发后自动升级，无需改前端。
