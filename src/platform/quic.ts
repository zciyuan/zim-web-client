// Native raw-QUIC bridge for the PC shell (Tauri/quinn).
//
// The Android bridge is added by the Capacitor plugin; until it is installed the
// App keeps using WebTransport/WS. Web/PWA never gets a native bridge.

import type {
  NativeQuicBridge,
  NativeQuicConnection,
  NativeQuicHandlers,
  NativeQuicTarget,
} from '../sdk/quic';
import { platform } from './detect';

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const encodeBase64 = (bytes: Uint8Array): string => {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_CHARS[(triple >> 18) & 63];
    out += BASE64_CHARS[(triple >> 12) & 63];
    out += index + 1 < bytes.length ? BASE64_CHARS[(triple >> 6) & 63] : '=';
    out += index + 2 < bytes.length ? BASE64_CHARS[triple & 63] : '=';
  }
  return out;
};

const decodeBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, '');
  const output = new Uint8Array(Math.max(0, Math.floor((clean.length * 3) / 4) - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0)));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of clean) {
    if (char === '=') break;
    buffer = (buffer << 6) | BASE64_CHARS.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[offset++] = (buffer >> bits) & 0xff;
    }
  }
  return output.slice(0, offset);
};

const hostOf = (addr: string): string => {
  if (addr.startsWith('[')) return addr.slice(1, addr.indexOf(']'));
  return addr.split(':')[0] ?? addr;
};

const caFile = (): string => (import.meta.env.VITE_ZIM_QUIC_CA_FILE as string | undefined) ?? '';

let connectionSeq = 0;

const tauriBridge: NativeQuicBridge = {
  available: platform.kind === 'tauri',
  connect(target: NativeQuicTarget, handlers: NativeQuicHandlers): NativeQuicConnection {
    const id = `tq_${Date.now().toString(36)}_${++connectionSeq}`;
    let closed = false;
    let invokeFn: ((command: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;    const unlisteners: (() => void)[] = [];

    const cleanup = (): void => {
      const pending = unlisteners.splice(0);
      for (const unlisten of pending) {
        try {
          unlisten();
        } catch {
          // listener already gone
        }
      }
    };

    const finish = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      cleanup();
      if (invokeFn) void invokeFn('quic_close', { id }).catch(() => undefined);
      handlers.onClose(code, reason);
    };

    void (async () => {
      const [{ invoke }, { listen }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/api/event'),
      ]);
      invokeFn = invoke as unknown as (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      unlisteners.push(await listen<string>(`quic://data/${id}`, (event) => {
        if (closed) return;
        handlers.onData(decodeBase64(String(event.payload ?? '')));
      }));
      unlisteners.push(await listen<{ code?: number; reason?: string }>(`quic://closed/${id}`, (event) => {
        finish(Number(event.payload?.code ?? 1006), String(event.payload?.reason ?? 'QUIC closed'));
      }));
      await invoke('quic_connect', {
        id,
        addr: target.addr,
        serverName: target.serverName ?? hostOf(target.addr),
        caFile: target.caFile ?? caFile(),
      });
      if (!closed) handlers.onOpen();
    })().catch((error: unknown) => {
      if (closed) return;
      closed = true;
      cleanup();
      handlers.onError(error);
      handlers.onClose(1006, String(error));
    });

    return {
      send(bytes: Uint8Array): void {
        if (closed || !invokeFn) return;
        void invokeFn('quic_send', { id, data: encodeBase64(bytes) })
          .catch((error: unknown) => {
            if (closed) return;
            closed = true;
            cleanup();
            handlers.onError(error);
            handlers.onClose(1006, String(error));
          });
      },
      close(): void {
        if (closed) return;
        closed = true;
        cleanup();
        if (invokeFn) void invokeFn('quic_close', { id }).catch(() => undefined);
      },
    };
  },
};

interface ZimQuicPluginApi {
  connect: (options: Record<string, unknown>) => Promise<void>;
  send: (options: Record<string, unknown>) => Promise<void>;
  close: (options: Record<string, unknown>) => Promise<void>;
  addListener: (event: string, listener: (payload: unknown) => void) => Promise<{ remove: () => void }>;
}

/**
 * Capacitor Android bridge (native ZimQuic plugin). iOS has no plugin yet and
 * stays on WebTransport/WS.
 */
const capacitorBridge: NativeQuicBridge = {
  available: platform.kind === 'android',
  connect(target: NativeQuicTarget, handlers: NativeQuicHandlers): NativeQuicConnection {
    const id = `cq_${Date.now().toString(36)}_${++connectionSeq}`;
    let closed = false;
    let plugin: ZimQuicPluginApi | null = null;
    const handles: { remove: () => void }[] = [];

    const cleanup = (): void => {
      for (const handle of handles.splice(0)) {
        try {
          handle.remove();
        } catch {
          // already removed
        }
      }
    };

    const finish = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      cleanup();
      handlers.onClose(code, reason);
    };

    void (async () => {
      const { registerPlugin } = await import('@capacitor/core');
      plugin = registerPlugin<ZimQuicPluginApi>('ZimQuic') as unknown as ZimQuicPluginApi;
      handles.push(await plugin!.addListener('quicData', (payload) => {
        if (closed) return;
        const data = payload as { id?: string; data?: string };
        if (String(data.id ?? '') !== id) return;
        handlers.onData(decodeBase64(String(data.data ?? '')));
      }));
      handles.push(await plugin!.addListener('quicClosed', (payload) => {
        if (closed) return;
        const data = payload as { id?: string; code?: number; reason?: string };
        if (String(data.id ?? '') !== id) return;
        finish(Number(data.code ?? 1006), String(data.reason ?? 'QUIC closed'));
      }));
      await plugin!.connect({
        id,
        addr: target.addr,
        serverName: target.serverName ?? hostOf(target.addr),
        alpn: target.alpn ?? 'due-quic',
        allowInsecure: target.allowInsecure === true,
        caFile: target.caFile ?? caFile(),
      });
      if (!closed) handlers.onOpen();
    })().catch((error: unknown) => {
      if (closed) return;
      closed = true;
      cleanup();
      handlers.onError(error);
      handlers.onClose(1006, String(error));
    });

    return {
      send(bytes: Uint8Array): void {
        if (closed || !plugin) return;
        void plugin.send({ id, data: encodeBase64(bytes) }).catch((error: unknown) => {
          if (closed) return;
          closed = true;
          cleanup();
          handlers.onError(error);
          handlers.onClose(1006, String(error));
        });
      },
      close(): void {
        if (closed) return;
        closed = true;
        cleanup();
        if (plugin) void plugin.close({ id }).catch(() => undefined);
      },
    };
  },
};

/**
 * Raw QUIC is only meaningful where a native bridge exists. Android plugs in a
 * Capacitor implementation; Web/PWA and iOS (no plugin yet) return null.
 */
export const nativeQuicBridge: NativeQuicBridge | null = platform.kind === 'tauri'
  ? tauriBridge
  : platform.kind === 'android'
    ? capacitorBridge
    : null;
