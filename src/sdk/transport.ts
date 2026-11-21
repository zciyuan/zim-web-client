// Transport negotiation for the ZIM client.
//
// The gate exposes three wire endpoints:
//   * WebSocket (`wss://host/ws`) — universal fallback;
//   * a raw QUIC listener (`udp://host:12000`, ALPN due-quic) — native apps only;
//   * a WebTransport endpoint (`https://host:12001/wt`, HTTP/3 + CONNECT) — the
//     QUIC-family transport browsers and WebViews can actually dial.
//
// `GET /v1/ws/ticket` returns `{ticket, transports}`. The client picks
// WebTransport when it is advertised, the browser supports it, the device is in
// the gray ratio, and its 200ms handshake succeeds; otherwise it falls back to
// WS and records why. The frame stream is identical on both transports.

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
  kind: 'ws' | 'webtransport' | 'quic';
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
  nativeQuicProbes: number;
  nativeQuicOk: number;
  nativeQuicFailures: number;
  fallbacks: number;
  lastRttMs: number;
  lastReason: string;
}

export const transportStats: TransportStats = {
  decisions: 0,
  webtransportProbes: 0,
  webtransportOk: 0,
  webtransportFailures: 0,
  nativeQuicProbes: 0,
  nativeQuicOk: 0,
  nativeQuicFailures: 0,
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
  const raw = option.url ?? (option.addr ? `https://${option.addr}` : '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    // The gate serves WebTransport on /wt; tolerate an origin-only advertisement.
    if (!url.pathname || url.pathname === '/') url.pathname = '/wt';
    return url.toString();
  } catch {
    return raw;
  }
};

/** Builds the CONNECT URL with the one-shot ticket (or a direct token). */
export const buildWebTransportUrl = (options: {
  url: string;
  ticket?: string;
  token?: string;
  platform?: number;
  sdk?: string;
}): string => {
  const url = new URL(options.url);
  if (options.ticket) url.searchParams.set('ticket', options.ticket);
  else if (options.token) url.searchParams.set('token', options.token);
  url.searchParams.set('platform', String(options.platform ?? 4));
  url.searchParams.set('sdk', options.sdk ?? 'web-2.0.0');
  return url.toString();
};

/** Picks the transport for this device. Never throws. */
export const decideTransport = (
  options: TransportOption[],
  seed: string,
  capabilities: { nativeQuic?: boolean } = {},
): TransportDecision => {
  const bucket = transportBucket(seed);
  const quic = options.find((option) => option.type === 'quic'
    && (option.ratio === undefined || bucket < option.ratio));
  if (quic && capabilities.nativeQuic) {
    return { kind: 'quic', reason: 'quic-ready', option: quic, bucket };
  }
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
    try {
      if (new URL(url).protocol !== 'https:') {
        return { kind: 'ws', reason: 'webtransport-insecure', option: webtransport, bucket };
      }
    } catch {
      return { kind: 'ws', reason: 'webtransport-url-invalid', option: webtransport, bucket };
    }
    return { kind: 'webtransport', reason: 'webtransport-ready', option: webtransport, bucket };
  }
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

/** Records one real WebTransport dial (not the preflight probe). */
export const recordWebTransportAttempt = (ok: boolean, ms: number, reason: string): void => {
  transportStats.webtransportProbes += 1;
  if (ok) transportStats.webtransportOk += 1;
  else transportStats.webtransportFailures += 1;
  transportStats.lastRttMs = ms;
  transportStats.lastReason = reason;
};

/** Records one native raw-QUIC dial. */
export const recordNativeQuicAttempt = (ok: boolean, ms: number, reason: string): void => {
  transportStats.nativeQuicProbes += 1;
  if (ok) transportStats.nativeQuicOk += 1;
  else transportStats.nativeQuicFailures += 1;
  transportStats.lastRttMs = ms;
  transportStats.lastReason = reason;
};

/** Records a fallback from the advertised transport to WebSocket. */
export const recordTransportFallback = (reason: string): void => {
  transportStats.fallbacks += 1;
  transportStats.lastReason = reason;
};
