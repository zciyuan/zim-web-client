// Native raw-QUIC bridge contract.
//
// Browsers cannot dial the gate's due-quic endpoint (custom ALPN, not HTTP/3),
// so PC/App shells provide the connection natively: Tauri via quinn, Capacitor
// via an Android QUIC plugin. The bridge moves opaque ZIM frames; the JS client
// still owns framing, request correlation and reconnect.

export interface NativeQuicTarget {
  /** host:port of the gate's UDP QUIC listener. */
  addr: string;
  /** TLS server name; defaults to the address host. */
  serverName?: string;
  /** ALPN the gate uses (due-quic). */
  alpn?: string;
  /** Optional PEM CA bundle for private/self-signed deployments. */
  caFile?: string;
  /** Dev-only: skip certificate verification (never enable in production). */
  allowInsecure?: boolean;
}

export interface NativeQuicHandlers {
  onOpen: () => void;
  onData: (bytes: Uint8Array) => void;
  onClose: (code: number, reason: string) => void;
  onError: (error: unknown) => void;
}

export interface NativeQuicConnection {
  send(bytes: Uint8Array): void;
  close(): void;
}

export interface NativeQuicBridge {
  readonly available: boolean;
  connect(target: NativeQuicTarget, handlers: NativeQuicHandlers): NativeQuicConnection;
}
