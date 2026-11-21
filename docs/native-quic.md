# PC / App 原生裸 QUIC

WebTransport 是浏览器/WebView 能用的 QUIC；裸 QUIC（`due-quic` ALPN）没有浏览器 API，所以 PC/App 由原生壳直接建 QUIC 连接。当前状态：

| 平台 | 实现 | 状态 |
|---|---|---|
| PC（Tauri） | Rust `quinn` + TLS 1.3 + ALPN `due-quic` | ✅ 已实机登录 |
| App（Android/Capacitor） | 纯 Java Kwik + 原生插件 `ZimQuic` | ✅ 已编译，Kwik 对 gate 的 JVM 冒烟通过 |
| App（iOS） | 暂无 iOS 原生 QUIC 库接入 | 🟡 继续走 WebTransport/WS |

## 服务端协议

- gate 以 `[network] transport = "quic"` 启动独立 UDP 部署；
- TLS 1.3，ALPN 固定 **`due-quic`**（due 的 quic 插件硬编码，配置里的 `alpn` 不生效）；
- 客户端建连后打开 **一条双向流**，先发一个空 ZIM 帧 `[00 00 00 07 01 00 00 00 00 00 00]`（opcode=0/seq=0）宣告流，并每 15s 重发作为应用心跳；
- 之后收发与 WS/WebTransport 完全相同的 `[len4][ver1][op2][seq4][Envelope]` 帧；
- 认证用 `1001 Login` 里的 access token；裸 QUIC 不经过 gate 的 HTTP upgrade，因此**不使用 `/v1/ws/ticket` 的 ticket**；
- 服务端不会主动发握手帧；首个心跳只是让 due 的 quic server 能向客户端 push。

服务端配置：

```toml
[network]
transport = "quic"

[network.quic.server]
addr = ":12000"
certFile = "/etc/zim/quic/tls.crt"
keyFile = "/etc/zim/quic/tls.key"
alpn = "due-quic"   # 仅文档用途；客户端/服务端实现固定为 due-quic

# zim-api
[zim.transport]
quicAddr = "im.example.com:12000"
```

UDP 端口必须在 LB / 安全组放通；证书必须是客户端信任的 CA（Android 使用系统信任库，PC 使用系统信任库 + Mozilla 根）。

## PC（Tauri / quinn）

`src-tauri/src/quic.rs`：

- 命令 `quic_connect({ id, addr, serverName, caFile })`：创建 quinn endpoint、TLS 1.3、ALPN `due-quic`，打开一条双向流并发送初始心跳；
- 入站流按 chunk 通过事件 `quic://data/{id}` 以 base64 发给 WebView；
- 命令 `quic_send({ id, data })`、`quic_close({ id })`；
- 每 15s 心跳；连接/流结束时发 `quic://closed/{id}`；
- 建连/开流有 **5s** 超时，超时后自动进入下一传输，避免弱网卡在 QUIC；
- 证书：`caFile` 为空时使用系统信任库（`rustls-native-certs`），失败再回退 Mozilla 根；`caFile` 可指向私有 CA PEM。没有“跳过证书校验”的生产开关。

前端：`src/platform/quic.ts` 的 Tauri bridge 把命令/事件适配成 `NativeQuicBridge`；`src/sdk/client.ts` 的 `NativeQuicSocket` 负责帧重组、发送、关闭。传输选择在 `decideTransport` 中优先原生 QUIC（服务端下发 `quic` 且壳支持时），失败按 `quic -> webtransport -> ws` 回退。

实机自检：临时把 API 的 `quicAddr` 指到本地 gate，Tauri debug 包登录后：

```json
{ "kind": "quic", "reason": "quic-ready", "conn": "open",
  "stats": { "nativeQuicProbes": 1, "nativeQuicOk": 1, "lastRttMs": 40 } }
```

截图：`_output/screens/quic/pc-raw-quic.png`。

## Android（Capacitor / Kwik）

- `android/app/build.gradle` 引入 `tech.kwik:kwik:0.12.3`（纯 Java QUIC，无需 NDK）；
- `ZimQuicPlugin.java`：`connect/send/close`，Kwik 建 QUIC + 双向流（10s 连接超时），初始/每 15s 心跳，读线程通过 `quicData` 事件回传 base64；
- `MainActivity` 注册插件；`src/platform/quic.ts` 的 Capacitor bridge 调用它；
- 生产默认使用系统信任库校验服务端证书；`VITE_ZIM_QUIC_INSECURE=1` 仅用于本地自签证书调试，正常构建不会设置；
- Android 自定义 CA 文件尚未接入；生产请使用公共 CA 或把 CA 装入系统信任库。

JVM 冒烟（不需要模拟器，验证 Kwik 与 gate 的协议互通）：

```bash
cd android
ZIM_QUIC_TEST_ADDR=127.0.0.1 ZIM_QUIC_TEST_PORT=12004 \
  gradlew.bat testDebugUnitTest --tests com.zim.im.ZimQuicSmokeTest
```

结果：`tests=1 failures=0`，连接本地 `transport=quic` gate 并发送初始心跳成功。

## iOS

Capacitor iOS 工程目前没有裸 QUIC 原生实现；`platform.capabilities.nativeQuic` 在 iOS 为 `false`，因此自动走 WebTransport（若 WKWebView 支持）或 WS。后续可选方案：

- Apple `Network.framework` 的 QUIC/NWConnection API；需要 macOS/Xcode 验证；
- 或接入 quiche/SwiftNIOQUIC 的 XCFramework。

在 iOS 原生层完成前，iOS 端不会被错误地标记为“已走裸 QUIC”。

## 测试与回退

- `npm run e2e:transport`：原生 QUIC 适配器、mock 登录、原生 QUIC 失败后真实 WS 登录；
- Rust：`cargo test ... dials_due_quic`（需 `ZIM_QUIC_TEST_ADDR` / `ZIM_QUIC_TEST_CA`）；
- Android：上面的 JVM 冒烟；
- PC 实机：Tauri debug 包 + 临时 API `quicAddr`，`transport.kind === "quic"`。

回退顺序：原生 QUIC → WebTransport（有 URL 且浏览器支持）→ WS。回退后本次会话不再反复重试 QUIC；重连会重新评估。

## 安全注意

- `noServerCertificateCheck` 只允许在 `VITE_ZIM_QUIC_INSECURE=1` 的调试构建出现；
- 生产必须使用受信任证书，并保持 ALPN `due-quic`；
- 裸 QUIC 不消耗 ticket，认证仍依赖 1001 Login 的 access token；
- 不要把测试用 `quicAddr` 或自签 CA 带进生产配置。
