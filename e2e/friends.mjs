// Friend-request regression check.
//
// Covers the stale-inbox bug: after accepting, the row must disappear even if
// the follow-up inbox refresh fails, and a reject must stick on both sides.
// Creates throwaway accounts through the REST API, so it needs the local stack.
//
//   npm run dev            # another terminal
//   npm run e2e:friends

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? process.env.ZIM_E2E_BASE ?? 'https://127.0.0.1:5280';
const API = process.env.ZIM_API_BASE ?? 'http://127.0.0.1:8080';
const CHROME = process.env.ZIM_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.ZIM_DEBUG_PORT ?? 9473);
const OUT = path.resolve('_output/screens/friends');
const step = (message) => console.log(`- ${message}`);
fs.mkdirSync(OUT, { recursive: true });

const suffix = Date.now().toString(36);
const accounts = {
  alice: `fqa_${suffix}`,
  bob: `fqb_${suffix}`,
  carol: `fqc_${suffix}`,
};
const password = 'password123';

const api = async (method, route, body, token) => {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (payload.code !== 0) throw new Error(`${method} ${route} -> ${payload.code} ${payload.message}`);
  return payload.data;
};

const register = (username) => api('POST', '/v1/auth/register', {
  username, password, nickname: username, platform: 4,
});

const launchChrome = async () => {
  const profile = path.join(os.tmpdir(), 'zim-friends-chrome');
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

const setValue = (page, selector, value) => page.evaluate((sel, next) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, selector, value);

const login = async (page, username) => {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('form');
  await setValue(page, 'input[autocomplete="username"]', username);
  await setValue(page, 'input[autocomplete="current-password"]', password);
  await page.evaluate(() => document.querySelector('button[type="submit"]')?.click());
  await page.waitForSelector('[aria-label="主导航"]', { timeout: 20_000 });
};

const openFriends = async (page) => {
  await page.evaluate(() => document.querySelector('[aria-label="主导航"] button:nth-child(3)')?.click());
  await page.waitForFunction(
    () => document.querySelector('[aria-label="列表"]')?.textContent?.includes('好友申请')
      || document.querySelector('[aria-label="列表"]')?.textContent?.includes('还没有好友'),
    { timeout: 20_000 },
  );
};

const rowCount = (page) => page.evaluate(() => document.querySelectorAll('[data-friend-request]').length);

const main = async () => {
  const [alice, bob, carol] = await Promise.all([
    register(accounts.alice),
    register(accounts.bob),
    register(accounts.carol),
  ]);
  await api('POST', '/v1/friends', { friend_id: Number(alice.uid), why: '我是 bob' }, bob.access_token);
  await api('POST', '/v1/friends', { friend_id: Number(alice.uid), why: '我是 carol' }, carol.access_token);

  const { chrome, endpoint } = await launchChrome();
  const browser = await puppeteer.connect({ browserURL: endpoint });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      errors.push(message.text());
    }
  });

  try {
    await page.setViewport({ width: 1200, height: 800 });
    await login(page, accounts.alice);
    await openFriends(page);
    await page.waitForFunction(() => document.querySelectorAll('[data-friend-request]').length === 2, { timeout: 20_000 });
    step('two pending requests are visible');
    await page.screenshot({ path: path.join(OUT, '01-pending.png') });

    // Simulate the follow-up inbox refresh failing after a successful accept.
    await page.setRequestInterception(true);
    let abortNextInbox = false;
    page.on('request', (request) => {
      const isInbox = request.method() === 'GET' && request.url().includes('/v1/friend-requests');
      if (abortNextInbox && isInbox) {
        abortNextInbox = false;
        void request.abort();
        return;
      }
      void request.continue();
    });

    abortNextInbox = true;
    await page.evaluate((uid) => {
      document.querySelector(`[data-friend-request="${uid}"] [data-friend-answer="accept"]`)?.click();
    }, String(bob.uid));
    await page.waitForFunction(
      (uid) => document.querySelector(`[data-friend-request="${uid}"]`) === null,
      { timeout: 10_000 },
      String(bob.uid),
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(await rowCount(page), 1, 'only carol should remain');
    const afterAccept = await page.evaluate(() => ({
      friends: window.__zim.getSnapshot().friends.map((item) => String(item.friend_id)),
      requests: window.__zim.getSnapshot().friendRequests.map((item) => String(item.from_id)),
      toast: window.__zim.getSnapshot().toast?.text ?? '',
    }));
    assert.ok(afterAccept.friends.includes(String(bob.uid)), 'accepted friend should be visible');
    assert.deepEqual(afterAccept.requests, [String(carol.uid)]);
    step('accept removes the stale row even when the refresh fails');
    await page.screenshot({ path: path.join(OUT, '02-accepted.png') });

    const inbox = await api('GET', '/v1/friend-requests?type=in', undefined, alice.access_token);
    assert.deepEqual((inbox.requests ?? []).map((item) => String(item.from_id)), [String(carol.uid)]);

    // Reject carol; both the row and the server-side inbox must clear.
    await page.evaluate(() => window.__zim.refresh());
    await page.waitForFunction(
      (uid) => Boolean(document.querySelector(`[data-friend-request="${uid}"]`)),
      { timeout: 20_000 },
      String(carol.uid),
    );
    await page.evaluate((uid) => {
      document.querySelector(`[data-friend-request="${uid}"] [data-friend-answer="reject"]`)?.click();
    }, String(carol.uid));
    await page.waitForFunction(() => document.querySelectorAll('[data-friend-request]').length === 0, { timeout: 10_000 });
    const inboxAfterReject = await api('GET', '/v1/friend-requests?type=in', undefined, alice.access_token);
    assert.deepEqual(inboxAfterReject.requests ?? [], []);
    const carolOut = await api('GET', '/v1/friend-requests?type=out', undefined, carol.access_token);
    assert.equal(Number(carolOut.requests?.[0]?.status), 2, 'rejected request should have status 2');
    step('reject clears the row and the server inbox');
    await page.screenshot({ path: path.join(OUT, '03-rejected.png') });

    assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
    console.log('\nFriend-request checks passed.');
  } finally {
    browser.disconnect();
    chrome.kill();
  }
};

await main();
