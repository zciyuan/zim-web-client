// Transport negotiation unit checks (browser-side).
//
// Verifies the QUIC/WebTransport decision, URL construction and the WS fallback
// ladder without needing a live HTTP/3 gate.
//
//   npm run dev
//   npm run e2e:transport

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? process.env.ZIM_E2E_BASE ?? 'https://127.0.0.1:5280';
const API = process.env.ZIM_API_BASE ?? 'http://127.0.0.1:8080';
const CHROME = process.env.ZIM_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.ZIM_DEBUG_PORT ?? 9474);
const OUT = path.resolve('_output/screens/transport');
fs.mkdirSync(OUT, { recursive: true });

const launchChrome = async () => {
  const profile = path.join(os.tmpdir(), 'zim-transport-chrome');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--ignore-certificate-errors',
    '--lang=zh-CN',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const endpoint = `http://127.0.0.1:${DEBUG_PORT}/json/version`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return { chrome, endpoint };
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  chrome.kill();
  throw new Error('chrome did not expose the devtools endpoint');
};

const { chrome, endpoint } = await launchChrome();
const browser = await puppeteer.connect({ browserURL: endpoint });
const page = await browser.newPage();
try {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => Boolean(window.__zimTransport), { timeout: 20_000 });

  const result = await page.evaluate(async () => {
    const transport = window.__zimTransport;
    const original = window.WebTransport;
    const out = {};
    try {
      window.WebTransport = class {
        constructor() { this.ready = Promise.resolve(); }
        close() {}
      };
      out.supported = transport.decide(
        [{ type: 'webtransport', url: 'https://127.0.0.1:12002' }],
        'device|10001',
      );
      out.ratioZero = transport.decide(
        [{ type: 'webtransport', url: 'https://127.0.0.1:12002/wt', ratio: 0 }],
        'device|10001',
      );
      out.nativeQuic = transport.decide(
        [{ type: 'quic', addr: '127.0.0.1:12004', alpn: 'due-quic' }],
        'device|10001',
        { nativeQuic: true },
      );
      out.nativeQuicOnly = transport.decide(
        [{ type: 'quic', addr: '127.0.0.1:12004', alpn: 'due-quic' }],
        'device|10001',
      );
      out.probe = await transport.probe('https://127.0.0.1:12002/wt', 200);
      out.url = transport.buildWebTransportUrl({
        url: 'https://127.0.0.1:12002/wt',
        ticket: 't_abc',
        platform: 4,
        sdk: 'web-2.0.0',
      });
      // Simulate a browser without WebTransport (Safari/older WebViews).
      delete window.WebTransport;
      out.unsupported = transport.decide(
        [{ type: 'webtransport', url: 'https://127.0.0.1:12002/wt' }],
        'device|10001',
      );
    } finally {
      if (original === undefined) delete window.WebTransport;
      else window.WebTransport = original;
    }
    out.parsedObject = transport.parse({
      transports: [
        { type: 'ws', url: 'wss://im.example.com/ws' },
        { type: 'webtransport', url: 'https://im.example.com/wt', ratio: 10 },
        { type: 'quic', addr: 'im.example.com:12000', alpn: 'due-quic' },
      ],
    });
    out.parsedString = transport.parse('[{"type":"webtransport","url":"https://x/wt"}]');
    return out;
  });

  assert.equal(result.supported.kind, 'webtransport');
  assert.equal(result.supported.reason, 'webtransport-ready');
  assert.equal(result.supported.option.url, 'https://127.0.0.1:12002');
  assert.equal(result.ratioZero.kind, 'ws');
  assert.equal(result.ratioZero.reason, 'default-ws');
  assert.equal(result.nativeQuic.kind, 'quic');
  assert.equal(result.nativeQuic.reason, 'quic-ready');
  assert.equal(result.nativeQuicOnly.kind, 'ws');
  assert.equal(result.nativeQuicOnly.reason, 'quic-native-only');
  assert.equal(result.probe.ok, true);
  assert.equal(result.parsedObject.length, 3);
  assert.equal(result.parsedObject[1].type, 'webtransport');
  assert.equal(result.parsedString[0].url, 'https://x/wt');
  assert.equal(result.unsupported.kind, 'ws');
  assert.equal(result.unsupported.reason, 'webtransport-unsupported');
  const built = new URL(result.url);
  assert.equal(built.pathname, '/wt');
  assert.equal(built.searchParams.get('ticket'), 't_abc');
  assert.equal(built.searchParams.get('platform'), '4');
  assert.equal(built.searchParams.get('sdk'), 'web-2.0.0');

  // Exercise the WebTransport adapter (CONNECT -> stream -> frame reassembly)
  // with an in-memory session, since a live HTTP/3 gate is optional.
  const adapter = await page.evaluate(async () => {
    const { WebTransportSocket, encodeFrame } = window.__zimSdk;
    let controller = null;
    let closed = false;
    const writes = [];
    const readable = new ReadableStream({
      start(value) { controller = value; },
    });
    const writable = new WritableStream({
      write(chunk) { writes.push(Array.from(chunk)); },
    });
    const factory = () => ({
      ready: Promise.resolve(),
      close() { closed = true; },
      createBidirectionalStream: async () => ({ readable, writable }),
    });
    const socket = new WebTransportSocket('https://127.0.0.1:12002/wt', factory, 200);
    const opened = new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', (event) => reject(event));
    });
    socket.start();
    await opened;
    const received = [];
    socket.addEventListener('message', (event) => {
      received.push(Array.from(new Uint8Array(event.data)));
    });
    const frame = encodeFrame({ opcode: 1901, seq: 0, body: new Uint8Array([1, 2, 3]) });
    controller.enqueue(frame.slice(0, 5));
    controller.enqueue(frame.slice(5));
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.send(new Uint8Array([9, 8, 7]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.close();
    return { frame: Array.from(frame), received, writes, closed };
  });
  assert.deepEqual(adapter.received[0], adapter.frame);
  assert.deepEqual(adapter.writes[0], [9, 8, 7]);
  assert.equal(adapter.closed, true);
  console.log('WebTransport adapter checks passed.');

  // Native raw-QUIC adapter: bridge events -> frame reassembly -> outbound.
  const nativeAdapter = await page.evaluate(async () => {
    const { NativeQuicSocket, encodeFrame } = window.__zimSdk;
    let handlers = null;
    let closed = false;
    const writes = [];
    const bridge = {
      available: true,
      connect(_target, next) {
        handlers = next;
        return {
          send(bytes) { writes.push(Array.from(bytes)); },
          close() { closed = true; },
        };
      },
    };
    const socket = new NativeQuicSocket(bridge, { addr: '127.0.0.1:12004' });
    const opened = new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', (event) => reject(event));
    });
    socket.start();
    handlers.onOpen();
    await opened;
    const received = [];
    socket.addEventListener('message', (event) => {
      received.push(Array.from(new Uint8Array(event.data)));
    });
    const frame = encodeFrame({ opcode: 1901, seq: 0, body: new Uint8Array([1, 2, 3]) });
    handlers.onData(frame.slice(0, 4));
    handlers.onData(frame.slice(4));
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.send(new Uint8Array([7, 8, 9]));
    socket.close();
    return { frame: Array.from(frame), received, writes, closed };
  });
  assert.deepEqual(nativeAdapter.received[0], nativeAdapter.frame);
  assert.deepEqual(nativeAdapter.writes[0], [7, 8, 9]);
  assert.equal(nativeAdapter.closed, true);
  console.log('Native QUIC adapter checks passed.');

  // Preferred raw QUIC end-to-end through IMClient with a mock native bridge.
  const nativePreferred = await page.evaluate(async () => {
    const { IMClient, Writer, encodeFrame, encodeEnvelope } = window.__zimSdk;
    let handlers = null;
    let closed = false;
    const bridge = {
      available: true,
      connect(_target, next) {
        handlers = next;
        setTimeout(() => next.onOpen(), 0);
        return {
          send() {
            // First frame is 1001 Login with seq=1; answer it.
            const login = new Writer()
              .string(1, '12001')
              .string(2, 'quic-native')
              .int64(4, '1')
              .finish();
            next.onData(encodeFrame({
              opcode: 1001,
              seq: 1,
              body: encodeEnvelope({ opcode: 1001, payload: login }),
            }));
          },
          close() { closed = true; },
        };
      },
    };
    const client = new IMClient({
      baseUrl: 'wss://127.0.0.1:5280',
      transport: 'quic',
      nativeQuic: bridge,
      quic: { addr: '127.0.0.1:12004', serverName: '127.0.0.1' },
      sdk: 'e2e-quic',
      deviceId: 'e2e-quic-device',
      deviceName: 'e2e',
    });
    const login = await client.open('mock-token');
    const kind = client.transport;
    client.close();
    return { uid: login.uid, kind, closed };
  });
  assert.equal(nativePreferred.kind, 'quic');
  assert.equal(nativePreferred.uid, '12001');
  console.log('Native QUIC preferred login passed.');

  // Full preferred-transport path against an in-memory WebTransport server:
  // client frame -> mock login response -> IMClient resolves over QUIC.
  const preferred = await page.evaluate(async () => {
    const { IMClient, Writer, encodeFrame, decodeFrame, encodeEnvelope } = window.__zimSdk;
    let controller = null;
    const readable = new ReadableStream({ start(value) { controller = value; } });
    const writable = new WritableStream({
      write() {
        // The first request is always 1001 Login with seq=1; respond in kind.
        const login = new Writer()
          .string(1, '11001')
          .string(2, 'quic-tester')
          .int64(4, '1')
          .finish();
        controller.enqueue(encodeFrame({
          opcode: 1001,
          seq: 1,
          body: encodeEnvelope({ opcode: 1001, payload: login }),
        }));
      },
    });
    const factory = () => ({
      ready: Promise.resolve(),
      close() {},
      createBidirectionalStream: async () => ({ readable, writable }),
    });
    const client = new IMClient({
      baseUrl: 'wss://127.0.0.1:5280',
      transport: 'webtransport',
      webTransportUrl: 'https://127.0.0.1:12002/wt',
      webTransportTicketProvider: async () => 't_mock',
      webTransportFactory: factory,
      webTransportTimeoutMs: 500,
      sdk: 'e2e-transport',
      deviceId: 'e2e-transport-device',
      deviceName: 'e2e',
    });
    const login = await client.open('mock-token');
    const kind = client.transport;
    client.close();
    return { uid: login.uid, nickname: login.nickname, kind };
  });
  assert.equal(preferred.kind, 'webtransport');
  assert.equal(preferred.uid, '11001');
  assert.equal(preferred.nickname, 'quic-tester');
  console.log('WebTransport preferred login passed.');

  // Real fallback: prefer a dead WebTransport endpoint, then complete a real
  // ZIM login over WS through the dev proxy. This needs the local backend; if it
  // is down the offline negotiation checks above still stand.
  const username = `qtx_${Date.now().toString(36)}`;
  let token = '';
  try {
    const response = await fetch(`${API}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'password123', nickname: username, platform: 4 }),
    });
    const payload = await response.json();
    if (payload.code === 0) token = payload.data.access_token;
  } catch {
    // backend offline: skip the live fallback assertion
  }
  if (token) {
    const fallback = await page.evaluate(async (accessToken) => {
      const client = new window.__zimSdk.IMClient({
        baseUrl: location.origin.replace(/^http/, 'ws'),
        transport: 'webtransport',
        webTransportUrl: 'https://127.0.0.1:59999/wt',
        webTransportTicketProvider: async () => 't_fake',
        webTransportTimeoutMs: 200,
        sdk: 'e2e-transport',
        deviceId: 'e2e-transport-device',
        deviceName: 'e2e',
      });
      const login = await client.open(accessToken);
      const kind = client.transport;
      client.close();
      return { uid: login.uid, kind };
    }, token);
    assert.equal(fallback.kind, 'ws');
    assert.ok(fallback.uid);
    console.log('WebTransport -> WebSocket fallback login passed.');

    const nativeFallback = await page.evaluate(async (accessToken) => {
      const client = new window.__zimSdk.IMClient({
        baseUrl: location.origin.replace(/^http/, 'ws'),
        transport: 'quic',
        nativeQuic: {
          available: true,
          connect() { throw new Error('mock native QUIC unavailable'); },
        },
        quic: { addr: '127.0.0.1:12004' },
        sdk: 'e2e-quic-fallback',
        deviceId: 'e2e-quic-fallback',
        deviceName: 'e2e',
      });
      const login = await client.open(accessToken);
      const kind = client.transport;
      client.close();
      return { uid: login.uid, kind };
    }, token);
    assert.equal(nativeFallback.kind, 'ws');
    assert.ok(nativeFallback.uid);
    console.log('Native QUIC -> WebSocket fallback login passed.');
  } else {
    console.warn('backend offline; skipped live fallback login');
  }

  await page.screenshot({ path: path.join(OUT, 'negotiation.png') });
  console.log('Transport negotiation checks passed.');
} finally {
  browser.disconnect();
  chrome.kill();
}
