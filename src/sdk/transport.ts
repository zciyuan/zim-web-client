// Transport negotiation for the ZIM client.
//
// The gate exposes two wire endpoints:
//   * WebSocket (`wss://host/ws`), the only transport a browser can dial today;
//   * a raw QUIC listener (`udp://host:12000`) whose ALPN is a custom due
//     protocol, not HTTP/3. Browsers have no API for raw QUIC/ALPN, so the web
//     client can never use it directly — native apps can.
//
// `transports` may be published through /v1/client-config (or later through
// /v1/ws/ticket). This module parses it, applies the gray ratio, and decides
// which transport the browser should use. WebTransport is the only QUIC-family
// option a browser could use, and it needs a server-side WebTransport gateway
// (HTTP/3 + CONNECT) that the gate does not expose yet: until then the decision
// stays `ws` with an explicit reason, so the contract's 200ms fallback and
// rollout metrics are already in place.

export type TransportType = 'ws' | 'webtransport' | 'quic';

export interface TransportOption {
  type: TransportType;
  /** host:port of the raw QUIC listener (native clients). */
  addr?: string;
  /** https origin of a WebTransport gateway (browsers). */
  url?: string;
  alpn?: string;
  ca?: string;
  /** 0-100 gray ratio: only this share of devices prefers the transport. */
  ratio?: number;
}

export interface TransportDecision {
  kind: 'ws' | 'webtransport';
  reason: string;
  option?: TransportOption;
  /** stable 0-99 bucket of this device/account (gray rollout). */
  bucket: number;
}

export interface TransportStats {
  decisions: number;
  webtransportProbes: number;
  webtransportOk: number;
  webtransportFailures: number;
  fallbacks: number;
  lastRttMs: number;
  lastReason: string;
}

export const transportStats: TransportStats = {
  decisions: 0,
  webtransportProbes: 0,
  webtransportOk: 0,
  webtransportFailures: 0,
  fallbacks: 0,
  lastRttMs: 0,
  lastReason: '',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Accepts an array, a JSON string or `{ transports: [...] }`. */
export const parseTransports = (value: unknown): TransportOption[] => {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    try {
      return parseTransports(JSON.parse(text));
    } catch {
      return [];
    }
  }
  let list: unknown[] = [];
  if (Array.isArray(value)) list = value;
  else if (isRecord(value) && Array.isArray(value.transports)) list = value.transports;
  else return [];
  const options: TransportOption[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const type = String(item.type ?? '').toLowerCase();
    if (type !== 'quic' && type !== 'webtransport' && type !== 'ws') continue;
    const option: TransportOption = { type: type as TransportType };
    if (typeof item.addr === 'string') option.addr = item.addr;
    if (typeof item.url === 'string') option.url = item.url;
    if (typeof item.alpn === 'string') option.alpn = item.alpn;
    if (typeof item.ca === 'string') option.ca = item.ca;
    if (typeof item.ratio === 'number' && Number.isFinite(item.ratio)) {
      option.ratio = Math.min(Math.max(item.ratio, 0), 100);
    }
    options.push(option);
  }
  return options;
};

/** FNV-1a: a stable 0-99 bucket for the same device/account. */
export const transportBucket = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
};

export const webTransportSupported = (): boolean =>
  typeof (globalThis as { WebTransport?: unknown }).WebTransport !== 'undefined';

export const webTransportGatewayUrl = (option: TransportOption): string => {
  if (option.url) return option.url;
  if (!option.addr) return '';
  // The contract gives host:port for the QUIC listener; WebTransport shares the
  // UDP port on an https origin.
  return `https://${option.addr}`;
};

/** Picks the transport for this device. Never throws. */
export const decideTransport = (options: TransportOption[], seed: string): TransportDecision => {
  const bucket = transportBucket(seed);
  const webtransport = options.find((option) => {
    if (option.type !== 'webtransport') return false;
    return option.ratio === undefined || bucket < option.ratio;
  });
  if (webtransport) {
    const url = webTransportGatewayUrl(webtransport);
    if (!webTransportSupported()) {
      return { kind: 'ws', reason: 'webtransport-unsupported', option: webtransport, bucket };
    }
    if (!url) {
      return { kind: 'ws', reason: 'webtransport-url-missing', option: webtransport, bucket };
    }
    // The browser transport itself is not shipped yet: the gate still speaks a
    // custom QUIC protocol (ALPN due-quic), not WebTransport/HTTP3.
    return { kind: 'ws', reason: 'webtransport-not-implemented', option: webtransport, bucket };
  }
  const quic = options.find((option) => option.type === 'quic'
    && (option.ratio === undefined || bucket < option.ratio));
  if (quic) {
    return { kind: 'ws', reason: 'quic-native-only', option: quic, bucket };
  }
  return { kind: 'ws', reason: 'default-ws', bucket };
};

export interface ProbeResult {
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * Probes a WebTransport gateway: the contract gives the QUIC handshake/first
 * frame 200ms before falling back to WS. Only `ready` is awaited (the session
 * framing is a later step), and a hung handshake is abandoned.
 */
export const probeWebTransport = async (url: string, timeoutMs = 200): Promise<ProbeResult> => {
  const started = Date.now();
  transportStats.webtransportProbes += 1;
  const WebTransportCtor = (globalThis as {
    WebTransport?: new (url: string) => { ready: Promise<void>; close?: () => void };
  }).WebTransport;
  if (!WebTransportCtor) {
    transportStats.webtransportFailures += 1;
    transportStats.lastRttMs = 0;
    transportStats.lastReason = 'webtransport-unsupported';
    return { ok: false, ms: 0, error: 'WebTransport is not supported' };
  }
  let session: { ready: Promise<void>; close?: () => void } | null = null;
  try {
    session = new WebTransportCtor(url);
    await Promise.race([
      session.ready,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('webtransport timeout')), timeoutMs);
      }),
    ]);
    const ms = Date.now() - started;
    transportStats.webtransportOk += 1;
    transportStats.lastRttMs = ms;
    transportStats.lastReason = 'webtransport-ready';
    return { ok: true, ms };
  } catch (err) {
    const ms = Date.now() - started;
    transportStats.webtransportFailures += 1;
    transportStats.lastRttMs = ms;
    transportStats.lastReason = 'webtransport-failed';
    return { ok: false, ms, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      session?.close?.();
    } catch {
      // already closed
    }
  }
};

/** Records the decision so the rollout can be inspected (dev hook / metrics). */
export const recordDecision = (decision: TransportDecision): TransportDecision => {
  transportStats.decisions += 1;
  transportStats.lastReason = decision.reason;
  if (decision.kind === 'ws' && decision.option) transportStats.fallbacks += 1;
  return decision;
};
