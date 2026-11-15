// WebSocket transport for the ZIM client.
//
// Responsibilities: dial the gate, correlate request/response by seq, dispatch
// server pushes (seq = 0), surface kick frames and reconnect with a bounded
// backoff. It knows nothing about React or the DOM beyond the global WebSocket.

import { ImError, wrapError } from './errors';
import { decodeFrame, encodeRequest } from './frame';
import {
  OP,
  decodeKickPush,
  decodeLoginRes,
  encodeLoginReq,
} from './messages';
import type { LoginRes } from './types';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'reconnected'
  | 'closed'
  | 'offline'
  | 'error';

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

export interface IMClientOptions {
  /** '' means same origin; 'https://host:port' is also accepted. */
  baseUrl?: string;
  platform?: number;
  sdk?: string;
  deviceId?: string;
  deviceName?: string;
  socketFactory?: (url: string) => WebSocket;
  onState?: (state: ConnectionState) => void;
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
  let origin = options.baseUrl ?? '';
  if (!origin && typeof window !== 'undefined' && window.location) {
    origin = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
  }
  const url = new URL('/ws', origin || 'http://127.0.0.1');
  url.searchParams.set('token', options.token);
  url.searchParams.set('platform', String(options.platform ?? 4));
  url.searchParams.set('sdk', options.sdk ?? 'web-1.0.0');
  return url.toString();
};

interface Pending {
  resolve: (value: RequestResult<unknown>) => void;
  reject: (error: ImError) => void;
  decode?: Decoder<unknown>;
  timer: ReturnType<typeof setTimeout>;
}

export class IMClient {
  private socket: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private currentState: ConnectionState = 'idle';
  private token = '';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  private readonly options: Required<
    Pick<IMClientOptions, 'platform' | 'sdk' | 'deviceId' | 'deviceName' | 'requestTimeoutMs'>
  > &
    IMClientOptions;

  login: LoginRes | null = null;

  constructor(options: IMClientOptions = {}) {
    this.options = {
      platform: 4,
      sdk: 'web-1.0.0',
      deviceId: '',
      deviceName: '浏览器',
      requestTimeoutMs: 10_000,
      ...options,
    };
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  private setState(state: ConnectionState): void {
    this.currentState = state;
    this.options.onState?.(state);
  }

  /** Dials the gate and completes op:1001. Resolves with LoginRes. */
  async open(token: string): Promise<LoginRes> {
    this.token = token;
    this.manualClose = false;
    this.reconnectAttempt = 0;
    return this.dial();
  }

  private dial(): Promise<LoginRes> {
    return new Promise<LoginRes>((resolve, reject) => {
      this.setState('connecting');
      let settled = false;
      const settle = <T>(fn: (value: T) => void, value: T): void => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      const url = buildSocketUrl({
        baseUrl: this.options.baseUrl,
        token: this.token,
        platform: this.options.platform,
        sdk: this.options.sdk,
      });

      let socket: WebSocket;
      try {
        socket = this.options.socketFactory
          ? this.options.socketFactory(url)
          : new WebSocket(url);
      } catch (err) {
        this.setState('closed');
        settle(reject, wrapError(err));
        return;
      }
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      socket.addEventListener('error', () => {
        this.setState('error');
        settle(reject, new ImError(0, '无法连接网关（ws 握手失败）'));
      });

      socket.addEventListener('open', () => {
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
          .catch((err: unknown) => {
            settle(reject, wrapError(err));
            this.close();
          });
      });

      socket.addEventListener('close', (event) => {
        this.flushPending(new ImError(0, '连接已断开'));
        this.setState('closed');
        this.socket = null;
        settle(reject, new ImError(0, '连接已关闭'));
        if (!this.manualClose) this.scheduleReconnect();
        void event;
      });

      socket.addEventListener('message', (event: MessageEvent) => {
        let frame;
        try {
          frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
        } catch (err) {
          this.setState('error');
          this.options.onPush?.({ opcode: 0, payload: new Uint8Array(0), code: 0, message: String(err) });
          return;
        }
        this.dispatch(frame);
      });
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
    } catch (err) {
      pending.reject(wrapError(err));
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
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
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
        // The view is a valid BufferSource at runtime; the cast only bridges
        // lib.dom's stricter BufferSource<ArrayBuffer> typing in TS >= 5.7.
        this.socket?.send(encodeRequest(opcode, seq, payload) as unknown as BufferSource);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(wrapError(err));
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
