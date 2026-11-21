// ZIM wire client.
//
// Two transports carry the exact same [len4][ver1][op2][seq4] frame stream:
//   * WebSocket (`wss://host/ws`) — universal fallback;
//   * WebTransport (`https://host:port/wt`) — QUIC/HTTP3, one session = one
//     bidirectional stream (ADR-0040).
//
// Responsibilities: dial the gate, correlate request/response by seq, dispatch
// pushes (seq = 0), surface kick frames and reconnect with bounded backoff. When
// WebTransport is preferred it gets a 200ms handshake window; any failure falls
// back to WS for the rest of the session. No React or DOM beyond the standard
// WebSocket / WebTransport / Streams APIs.

import { ImError, wrapError } from './errors';
import { decodeFrame, encodeRequest } from './frame';
import {
  OP,
  decodeKickPush,
  decodeLoginRes,
  encodeLoginReq,
} from './messages';
import {
  buildWebTransportUrl,
  recordNativeQuicAttempt,
  recordTransportFallback,
  recordWebTransportAttempt,
  webTransportSupported,
} from './transport';
import type { NativeQuicBridge, NativeQuicConnection, NativeQuicTarget } from './quic';
import type { LoginRes } from './types';

// Dev-only socket counters: two live sockets for one account make the gate kick
// one of them, which shows up as an endless reconnect fight.
let socketSeq = 0;
let liveSockets = 0;

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'reconnected'
  | 'closed'
  | 'offline'
  | 'error';

export type ClientTransport = 'ws' | 'webtransport' | 'quic';

export interface PushEvent {
  opcode: number;
  payload: Uint8Array;
  code: number;
  message: string;
}

export interface KickEvent {
  reason: number;
  other_platform: number;
}

export type Decoder<T> = (bytes: Uint8Array) => T;

export interface RequestResult<T> {
  payload: T;
  code: number;
  message: string;
}

/** Minimal surface shared by the WebSocket and WebTransport adapters. */
interface WireSocket {
  binaryType?: BinaryType;
  readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  /** Optional deferred connect (WebTransport needs listeners attached first). */
  start?: () => void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}

interface WebTransportStreamLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export interface WebTransportLike {
  ready: Promise<void>;
  createBidirectionalStream(): Promise<WebTransportStreamLike>;
  close(): void;
}

export type WebTransportFactory = (url: string, options?: unknown) => WebTransportLike;

export interface IMClientOptions {
  /** '' means same origin; 'https://host:port' is also accepted. */
  baseUrl?: string;
  platform?: number;
  sdk?: string;
  deviceId?: string;
  deviceName?: string;
  socketFactory?: (url: string) => WebSocket;
  /** Preferred transport; WebTransport/native QUIC silently fall back to WS. */
  transport?: ClientTransport;
  /** Native raw-QUIC bridge (Tauri/Capacitor). */
  nativeQuic?: NativeQuicBridge;
  /** Raw QUIC endpoint from the `transports` advertisement. */
  quic?: NativeQuicTarget;
  /** Give the native QUIC handshake this long before falling back. */
  nativeQuicTimeoutMs?: number;
  /** Full CONNECT URL from GET /v1/ws/ticket (`.../wt`). */
  webTransportUrl?: string;
  /** One-shot ticket for the first WebTransport dial. */
  webTransportTicket?: string;
  /** Fetches a fresh one-shot ticket for reconnects. */
  webTransportTicketProvider?: () => Promise<string>;
  /** Test seam; defaults to globalThis.WebTransport. */
  webTransportFactory?: WebTransportFactory;
  /** Extra WebTransport constructor options (e.g. serverCertificateHashes). */
  webTransportOptions?: unknown;
  /** Contract fallback window for the QUIC handshake + first stream. */
  webTransportTimeoutMs?: number;
  /** Reports the transport actually in use (e.g. ws after a QUIC fallback). */
  onTransport?: (kind: ClientTransport, reason: string) => void;
  onState?: (state: ConnectionState, detail?: { code?: number; reason?: string }) => void;
  onPush?: (event: PushEvent) => void;
  onKick?: (event: KickEvent) => void;
  requestTimeoutMs?: number;
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

/** Builds the gate URL: /ws?token=&platform=&sdk= */
export const buildSocketUrl = (options: {
  baseUrl?: string;
  token: string;
  platform?: number;
  sdk?: string;
}): string => {
  let origin = options.baseUrl ?? (import.meta.env.VITE_WS_ORIGIN as string | undefined) ?? '';
  if (!origin && typeof window !== 'undefined' && window.location) {
    origin = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
  }
  const url = new URL('/ws', origin || 'http://127.0.0.1');
  url.searchParams.set('token', options.token);
  url.searchParams.set('platform', String(options.platform ?? 4));
  url.searchParams.set('sdk', options.sdk ?? 'web-1.0.0');
  return url.toString();
};

const webTransportCtor = (): WebTransportFactory | null => {
  const ctor = (globalThis as { WebTransport?: unknown }).WebTransport;
  if (typeof ctor !== 'function') return null;
  // WebTransport is a constructor; the factory seam still wants a plain call.
  return (url, options) => new (ctor as new (url: string, options?: unknown) => WebTransportLike)(url, options);
};

function emit(listener: ((event: unknown) => void) | undefined, event: unknown): void {
  if (listener) listener(event);
}

/** Reassembles ZIM frames from arbitrary stream/QUIC chunks. */
class FrameAssembler {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (merged.length - offset >= 4) {
      const length = view.getUint32(offset);
      const total = 4 + length;
      // A frame body is capped at 64 KiB by frame.ts; reject corrupt streams.
      if (length > 1024 * 1024) throw new Error(`frame too large: ${length}`);
      if (merged.length - offset < total) break;
      frames.push(merged.slice(offset, offset + total));
      offset += total;
    }
    this.buffer = merged.slice(offset);
    return frames;
  }
}

/**
 * WebTransport adapter with a WebSocket-shaped surface:
 * CONNECT -> await ready -> open one bidirectional stream -> frame the stream.
 */
export class WebTransportSocket implements WireSocket {  binaryType: BinaryType = 'arraybuffer';
  readyState = 0;

  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  private session: WebTransportLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private frames = new FrameAssembler();
  private closed = false;
  private started = false;

  constructor(
    private readonly url: string,
    private readonly factory: WebTransportFactory,
    private readonly timeoutMs: number,
    private readonly options?: unknown,
  ) {
    // Connection is started explicitly by IMClient after listeners are attached;
    // an immediately-rejecting ready promise would otherwise be lost.
  }

  /** Starts CONNECT; safe to call once after event listeners are registered. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.connect();
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  private fire(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) emit(listener, event);
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.fire('error', error);
    this.fire('close', {
      code: 1006,
      reason: error instanceof Error ? error.message : String(error),
    });
    try {
      this.session?.close();
    } catch {
      // already closed
    }
    this.session = null;
    this.reader = null;
    this.writer = null;
  }

  private async connect(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      this.session = this.factory(this.url, this.options);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('webtransport timeout')), this.timeoutMs);
      });
      await Promise.race([this.session.ready, timeout]);
      const stream = await Promise.race([this.session.createBidirectionalStream(), timeout]);
      this.reader = stream.readable.getReader();
      this.writer = stream.writable.getWriter();
      if (timer) clearTimeout(timer);
      this.readyState = 1;
      this.fire('open');
      void this.read();
    } catch (error) {
      if (timer) clearTimeout(timer);
      this.fail(error);
    }
  }

  private async read(): Promise<void> {
    try {
      while (!this.closed) {
        const { value, done } = await this.reader!.read();
        if (done) break;
        if (value) this.consume(value);
      }
      if (!this.closed) this.fail(new Error('webtransport stream closed'));
    } catch (error) {
      this.fail(error);
    }
  }

  /** Reassembles ZIM frames from arbitrary stream chunks. */
  private consume(chunk: Uint8Array): void {
    try {
      for (const frame of this.frames.push(chunk)) {
        this.fire('message', { data: frame.buffer });
      }
    } catch (error) {
      this.fail(error);
    }
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 1 || !this.writer) throw new Error('webtransport not open');
    const copy = data.slice();
    this.writes = this.writes
      .then(() => this.writer!.write(copy))
      .catch((error: unknown) => this.fail(error));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    const reader = this.reader;
    const writer = this.writer;
    this.reader = null;
    this.writer = null;
    void reader?.cancel().catch(() => undefined);
    void writer?.close().catch(() => undefined);
    try {
      this.session?.close();
    } catch {
      // already closed
    }
    this.session = null;
    this.fire('close', { code: 1000, reason: '' });
  }
}

/**
 * Raw-QUIC adapter: the native bridge owns TLS/QUIC/stream/heartbeat; this class
 * gives the client the same event surface as WebSocket/WebTransport.
 */
export class NativeQuicSocket implements WireSocket {
  binaryType: BinaryType = 'arraybuffer';
  readyState = 0;

  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  private readonly frames = new FrameAssembler();
  private connection: NativeQuicConnection | null = null;
  private started = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly bridge: NativeQuicBridge,
    private readonly target: NativeQuicTarget,
    private readonly timeoutMs = 5000,
  ) {}

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  private fire(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) emit(listener, event);
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.readyState = 3;
    this.fire('error', error);
    this.fire('close', { code: 1006, reason: error instanceof Error ? error.message : String(error) });
    try {
      this.connection?.close();
    } catch {
      // already closed
    }
    this.connection = null;
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.readyState = 3;
    this.fire('close', { code, reason });
    this.connection = null;
  }

  /** Starts the native QUIC connection after listeners are attached. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.timer = setTimeout(() => {
      this.fail(new Error('native QUIC handshake timeout'));
    }, this.timeoutMs);
    try {
      this.connection = this.bridge.connect(this.target, {
        onOpen: () => {
          // A synchronous bridge may fire this before connect() returns.
          queueMicrotask(() => {
            if (this.closed) {
              try {
                this.connection?.close();
              } catch {
                // already closed
              }
              return;
            }
            this.clearTimer();
            this.readyState = 1;
            this.fire('open');
          });
        },
        onData: (bytes) => {
          if (this.closed) return;
          try {
            for (const frame of this.frames.push(bytes)) {
              this.fire('message', { data: frame.buffer });
            }
          } catch (error) {
            this.fail(error);
          }
        },
        onClose: (code, reason) => this.finish(code, reason),
        onError: (error) => this.fail(error),
      });
    } catch (error) {
      this.fail(error);
    }
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 1 || !this.connection) throw new Error('native quic not open');
    try {
      this.connection.send(data);
    } catch (error) {
      this.fail(error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.readyState = 3;
    try {
      this.connection?.close();
    } catch {
      // already closed
    }
    this.connection = null;
    this.fire('close', { code: 1000, reason: '' });
  }
}

interface Pending {  resolve: (value: RequestResult<unknown>) => void;
  reject: (error: ImError) => void;
  decode?: Decoder<unknown>;
  timer: ReturnType<typeof setTimeout>;
}

export class IMClient {
  private socket: WireSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private currentState: ConnectionState = 'idle';
  private token = '';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  /** Set after a WebTransport fallback: reconnect straight to WS. */
  private downgraded = false;
  private activeKind: ClientTransport = 'ws';
  private readonly options: IMClientOptions & Required<
    Pick<IMClientOptions, 'platform' | 'sdk' | 'deviceId' | 'deviceName' | 'requestTimeoutMs' | 'transport' | 'webTransportTimeoutMs'>
  >;

  login: LoginRes | null = null;

  constructor(options: IMClientOptions = {}) {
    this.options = {
      platform: 4,
      sdk: 'web-1.0.0',
      deviceId: '',
      deviceName: '浏览器',
      requestTimeoutMs: 10_000,
      transport: 'ws',
      webTransportTimeoutMs: 200,
      ...options,
    };
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  /** Transport actually carrying (or attempting) the current connection. */
  get transport(): ClientTransport {
    return this.activeKind;
  }

  private setState(state: ConnectionState, detail?: { code?: number; reason?: string }): void {
    this.currentState = state;
    this.options.onState?.(state, detail);
  }

  /** Dials the gate and completes op:1001. Resolves with LoginRes. */
  async open(token: string): Promise<LoginRes> {
    this.token = token;
    this.manualClose = false;
    this.reconnectAttempt = 0;
    this.downgraded = false;
    return this.dial();
  }

  private async dial(): Promise<LoginRes> {
    const preferred = this.options.transport ?? 'ws';
    const attempts: ClientTransport[] = [];
    if (!this.downgraded) {
      if (preferred === 'quic' && this.options.nativeQuic?.available && this.options.quic) {
        attempts.push('quic');
      }
      if (preferred !== 'ws'
        && this.options.webTransportUrl
        && webTransportSupported()) {
        attempts.push('webtransport');
      }
    }
    attempts.push('ws');

    let lastError: unknown = null;
    for (const kind of attempts) {
      const started = Date.now();
      try {
        const login = await this.dialWire(kind, kind === 'ws');
        this.activeKind = kind;
        const fallback = kind !== preferred;
        this.downgraded = fallback;
        if (kind === 'quic') {
          recordNativeQuicAttempt(true, Date.now() - started, 'quic-connected');
        } else if (kind === 'webtransport') {
          recordWebTransportAttempt(true, Date.now() - started, 'webtransport-connected');
        }
        this.options.onTransport?.(
          kind,
          fallback ? `${preferred}-fallback` : `${kind}-connected`,
        );
        return login;
      } catch (error) {
        lastError = error;
        if (this.manualClose) throw error;
        if (kind === 'quic') {
          recordNativeQuicAttempt(false, Date.now() - started, 'quic-failed');
          recordTransportFallback('quic-fallback');
        } else if (kind === 'webtransport') {
          recordWebTransportAttempt(false, Date.now() - started, 'webtransport-failed');
          recordTransportFallback('webtransport-fallback');
        }
        if (import.meta.env.DEV) {
          console.debug(`[zim] ${kind} failed, trying the next transport`, error);
        }
      }
    }
    throw wrapError(lastError ?? new ImError(0, '所有传输均连接失败'));
  }

  private async createWire(kind: ClientTransport): Promise<WireSocket> {
    if (kind === 'quic') {
      const bridge = this.options.nativeQuic;
      const target = this.options.quic;
      if (!bridge?.available || !target) throw new ImError(0, '原生 QUIC 不可用');
      return new NativeQuicSocket(bridge, target, this.options.nativeQuicTimeoutMs ?? 5000);
    }
    if (kind === 'webtransport') {
      const url = this.options.webTransportUrl;
      const factory = this.options.webTransportFactory ?? webTransportCtor();
      if (!url || !factory) throw new ImError(0, 'WebTransport 不可用');
      const ticket = this.options.webTransportTicket
        ?? (this.options.webTransportTicketProvider
          ? await this.options.webTransportTicketProvider()
          : '');
      if (!ticket) throw new ImError(0, 'WebTransport ticket 获取失败');
      return new WebTransportSocket(
        buildWebTransportUrl({
          url,
          ticket,
          token: this.token,
          platform: this.options.platform,
          sdk: this.options.sdk,
        }),
        factory,
        this.options.webTransportTimeoutMs,
        this.options.webTransportOptions,
      );
    }
    const url = buildSocketUrl({
      baseUrl: this.options.baseUrl,
      token: this.token,
      platform: this.options.platform,
      sdk: this.options.sdk,
    });
    const socket = this.options.socketFactory
      ? this.options.socketFactory(url)
      : new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    return socket as unknown as WireSocket;
  }

  private async dialWire(kind: ClientTransport, allowReconnect: boolean): Promise<LoginRes> {
    const wire = await this.createWire(kind);
    return new Promise<LoginRes>((resolve, reject) => {
      this.setState('connecting');
      let settled = false;
      const settle = <T>(fn: (value: T) => void, value: T): void => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      this.socket = wire;
      if (import.meta.env.DEV) {
        console.debug(`[zim] ${kind} socket#${++socketSeq} created (live=${++liveSockets})`);
      }

      wire.addEventListener('error', (event) => {
        this.setState('error');
        const detail = event instanceof Error ? event.message : '握手失败';
        settle(reject, new ImError(0, `无法连接网关（${kind} 握手失败：${detail}）`));
      });

      wire.addEventListener('open', () => {
        this.setState('open');
        this.request(
          OP.LOGIN,
          encodeLoginReq({
            token: this.token,
            platform: this.options.platform,
            sdk: this.options.sdk,
            deviceId: this.options.deviceId,
            deviceName: this.options.deviceName,
          }),
          decodeLoginRes,
        )
          .then(({ payload }) => {
            this.login = payload;
            this.reconnectAttempt = 0;
            settle(resolve, payload);
          })
          .catch((error: unknown) => {
            settle(reject, wrapError(error));
            this.close();
          });
      });

      wire.addEventListener('close', (event) => {
        this.flushPending(new ImError(0, '连接已断开'));
        if (this.socket === wire) this.socket = null;
        const code = (event as { code?: number } | undefined)?.code;
        const reason = (event as { reason?: string } | undefined)?.reason;
        this.setState('closed', { code, reason });
        if (import.meta.env.DEV) console.debug(`[zim] ${kind} socket closed (live=${--liveSockets}) code=${code ?? ''}`);
        settle(reject, new ImError(0, '连接已关闭'));
        if (!this.manualClose && allowReconnect) this.scheduleReconnect();
      });

      wire.addEventListener('message', (event) => {
        const data = (event as { data?: unknown } | undefined)?.data;
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data instanceof Uint8Array
            ? data
            : null;
        if (!bytes) return;
        let frame;
        try {
          frame = decodeFrame(bytes);
        } catch (error) {
          this.setState('error');
          if (import.meta.env.DEV) console.debug('[zim] frame decode failed', error);
          return;
        }
        this.dispatch(frame);
      });

      // WebTransport's CONNECT must not start until the listeners above exist:
      // a dead QUIC endpoint can reject ready in the same microtask.
      wire.start?.();
    });
  }

  private dispatch(frame: { opcode: number; seq: number; envelope: { payload: Uint8Array; code: number; message: string } }): void {
    const { opcode, seq, envelope } = frame;
    if (seq === 0) {
      if (opcode === OP.PUSH_KICK) {
        this.manualClose = true;
        this.options.onKick?.(decodeKickPush(envelope.payload));
        return;
      }
      this.options.onPush?.({
        opcode,
        payload: envelope.payload,
        code: envelope.code,
        message: envelope.message,
      });
      return;
    }

    const pending = this.pending.get(seq);
    if (!pending) return;
    this.pending.delete(seq);
    clearTimeout(pending.timer);

    if (envelope.code !== 0) {
      pending.reject(new ImError(envelope.code, envelope.message));
      return;
    }
    try {
      pending.resolve({
        payload: pending.decode ? pending.decode(envelope.payload) : envelope.payload,
        code: envelope.code,
        message: envelope.message,
      });
    } catch (error) {
      pending.reject(wrapError(error));
    }
  }

  private flushPending(error: ImError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      this.setState('offline');
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt++];
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.dial()
        .then(() => {
          this.options.onState?.('reconnected');
        })
        .catch(() => {
          // dial() already scheduled the next attempt through the close handler
        });
    }, delay);
  }

  /** Sends one request and resolves with its decoded response payload. */
  async request<T>(
    opcode: number,
    payload: Uint8Array,
    decode?: Decoder<T>,
  ): Promise<RequestResult<T>> {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new ImError(0, '连接未就绪');
    }
    const seq = ++this.seq;
    const result = await new Promise<RequestResult<unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new ImError(0, `请求超时：op ${opcode}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(seq, {
        resolve,
        reject,
        decode: decode as Decoder<unknown> | undefined,
        timer,
      });
      try {
        this.socket?.send(encodeRequest(opcode, seq, payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(wrapError(error));
      }
    });
    return result as RequestResult<T>;
  }

  /** Closes without scheduling a reconnect. */
  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.flushPending(new ImError(0, '连接已关闭'));
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
  }
}
