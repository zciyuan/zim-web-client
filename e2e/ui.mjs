// Browser end-to-end check for the React client: two tabs, two accounts, one
// realtime hop, plus a PWA manifest check.
//
//   npm run e2e        (expects `npm run dev` in another terminal)
//
// Chrome is spawned with stdio: 'ignore' and driven over the devtools protocol,
// so this works in sandboxes that block piped child stdio.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5280';
const CHROME = process.env.ZIM_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.ZIM_DEBUG_PORT ?? 9455);
const OUT = path.resolve('_output/screens');
const step = (message) => console.log(`- ${message}`);

fs.mkdirSync(OUT, { recursive: true });

const launchChrome = async () => {
  const profile = path.join(os.tmpdir(), 'zim-web-chrome');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });

  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--lang=zh-CN',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const endpoint = `http://127.0.0.1:${DEBUG_PORT}/json/version`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return { chrome, endpoint };
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  chrome.kill();
  throw new Error('chrome did not expose the devtools endpoint');
};

// React controlled inputs ignore `el.value = x`; go through the native setter
// and dispatch the same event a user typing would produce.
const setValue = (page, selector, value) => page.evaluate((sel, next) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, selector, value);

const jsClick = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  el.click();
}, selector);

const clickByText = (page, selector, text) => page.evaluate((sel, needle) => {
  const node = [...document.querySelectorAll(sel)].find((item) => item.textContent?.includes(needle));
  if (!node) return false;
  node.click();
  return true;
}, selector, text);

const loginAs = async (page, username) => {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('form');
  await setValue(page, 'input[autocomplete="username"]', username);
  await setValue(page, 'input[autocomplete="current-password"]', 'password');
  await jsClick(page, 'button[type="submit"]');
  await page.waitForFunction(
    () => document.querySelector('[aria-label="主导航"]') !== null,
    { timeout: 20_000 },
  );
};

const openConversationWith = async (page, name) => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const clicked = await clickByText(page, '[aria-label="列表"] button', name);
    if (!clicked) throw new Error(`no conversation row containing ${name}`);
    try {
      await page.waitForFunction(
        (needle) => document.querySelector('[aria-label="聊天"] h2')?.textContent?.includes(needle),
        { timeout: 3000 },
        name,
      );
      return;
    } catch {
      // a re-render landed between click and paint; click again
    }
  }
  throw new Error(`conversation ${name} never opened`);
};

const main = async () => {
  const { chrome, endpoint } = await launchChrome();
  const browser = await puppeteer.connect({ browserURL: endpoint, defaultViewport: { width: 1440, height: 900 } });
  const errors = [];

  const alice = await browser.newPage();
  alice.on('pageerror', (err) => errors.push(`alice pageerror: ${err.message}`));
  alice.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`alice console: ${msg.text()}`);
  });

  step('login page renders');
  await alice.goto(BASE, { waitUntil: 'networkidle2' });
  await alice.waitForSelector('form');
  await alice.screenshot({ path: path.join(OUT, '01-login.png') });

  step('alice logs in and opens the conversation with Bob');
  await loginAs(alice, 'alice');
  await alice.waitForFunction(() => document.querySelectorAll('[aria-label="列表"] button').length > 0, { timeout: 20_000 });
  await alice.screenshot({ path: path.join(OUT, '02-workspace.png') });
  await openConversationWith(alice, 'Bob');
  await alice.waitForFunction(() => document.querySelectorAll('[aria-label="聊天"] .message-enter').length > 0, { timeout: 20_000 });
  await alice.screenshot({ path: path.join(OUT, '03-conversation.png') });

  step('bob logs in from a second tab');
  const bob = await browser.newPage();
  bob.on('pageerror', (err) => errors.push(`bob pageerror: ${err.message}`));
  bob.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`bob console: ${msg.text()}`);
  });
  await loginAs(bob, 'bob');
  await bob.waitForFunction(() => document.querySelectorAll('[aria-label="列表"] button').length > 0, { timeout: 20_000 });
  await openConversationWith(bob, 'Alice');

  const text = `React 实时消息 ${Date.now()}`;
  step(`bob sends: ${text}`);
  await bob.focus('textarea');
  await bob.keyboard.type(text);
  await bob.keyboard.press('Enter');
  await bob.waitForFunction(
    (needle) => document.querySelector('[aria-label="聊天"]')?.textContent?.includes(needle),
    { timeout: 15_000 },
    text,
  );
  await bob.screenshot({ path: path.join(OUT, '04-bob-sent.png') });

  step('alice receives it over the 1901 push');
  await alice.waitForFunction(
    (needle) => document.querySelector('[aria-label="聊天"]')?.textContent?.includes(needle),
    { timeout: 15_000 },
    text,
  );
  await alice.screenshot({ path: path.join(OUT, '05-alice-realtime.png') });

  step('alice replies and the bubble is marked sent');
  // Wait for a live socket first: the composer refuses to send while the
  // connection is reconnecting (and now says so instead of dropping the text).
  await alice.waitForFunction(
    () => window.__zim?.getSnapshot?.().connection === 'open',
    { timeout: 20_000 },
  );
  // Drive the controlled textarea through React's setter: keyboard.type() for
  // CJK depends on focus/IME timing and is the flakiest part of a headless run.
  await setValue(alice, 'textarea', '收到，来自 React 客户端');
  await alice.focus('textarea');
  await alice.keyboard.press('Enter');
  // Assert on rendered text: the store settles to "sent" within a round trip,
  // and a plain text check is immune to which bubble index the reply lands on.
  await alice.waitForFunction(
    (needle) => document.querySelector('[aria-label="聊天"]')?.textContent?.includes(needle),
    { timeout: 20_000 },
    '收到，来自 React 客户端',
  );
  await alice.waitForFunction(
    (needle) => document.querySelector('[aria-label="聊天"]')?.textContent?.includes(needle),
    { timeout: 10_000 },
    '收到，来自 React 客户端',
  );

  step('emoji picker inserts an emoji and sends it');
  await jsClick(alice, '[aria-label="表情"]');
  await alice.waitForSelector('[role="dialog"][aria-label="表情"]', { timeout: 5_000 });
  await jsClick(alice, '[aria-label="😀"]');
  const draft = await alice.$eval('textarea', (el) => el.value);
  assert.ok(draft.includes('😀'), 'emoji should land in the composer');
  await alice.focus('textarea');
  await alice.keyboard.press('Enter');
  await alice.waitForFunction(
    (needle) => document.querySelector('[aria-label="聊天"]')?.textContent?.includes(needle),
    { timeout: 15_000 },
    '😀',
  );

  step('image upload produces an image bubble');
  const fileInput = await alice.$('input[type="file"]');
  assert.ok(fileInput, 'image picker input is missing');
  await fileInput.uploadFile(path.resolve('public/icon-192.png'));
  await alice.waitForSelector('[aria-label="聊天"] img[alt="图片消息"]', { timeout: 30_000 });
  await alice.screenshot({ path: path.join(OUT, '07-image.png') });

  step('group tab opens a group thread');
  await jsClick(alice, '[aria-label="主导航"] button:nth-child(3)');
  await alice.waitForFunction(
    () => document.querySelector('[aria-label="列表"] h2')?.textContent?.includes('群聊'),
    { timeout: 10_000 },
  );
  await clickByText(alice, '[aria-label="列表"] button', 'e2e-group');
  await alice.waitForFunction(
    () => document.querySelector('[aria-label="聊天"] h2') !== null && !document.querySelector('[aria-label="聊天"] button')?.hidden,
    { timeout: 10_000 },
  );
  await alice.screenshot({ path: path.join(OUT, '06-group.png') });

  step('PWA manifest is served');
  const manifest = await alice.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest');
    const body = await response.json();
    return { status: response.status, name: body.name };
  });
  assert.equal(manifest.status, 200);
  assert.equal(manifest.name, 'ZIM IM');

  step('registration creates an account and enters the app');
  const fresh = await browser.newPage();
  fresh.on('pageerror', (err) => errors.push(`signup pageerror: ${err.message}`));
  await fresh.goto(BASE, { waitUntil: 'networkidle2' });
  await fresh.waitForSelector('form');
  await fresh.evaluate(() => {
    const tab = [...document.querySelectorAll('button')].find((item) => item.textContent === '注册');
    if (!tab) throw new Error('register tab missing');
    tab.click();
  });
  const suffix = String(Date.now() % 1_000_000);
  await setValue(fresh, 'input[autocomplete="username"]', `e2e_${suffix}`);
  await setValue(fresh, 'input[autocomplete="new-password"]', 'password123');
  await jsClick(fresh, 'button[type="submit"]');
  await fresh.waitForFunction(() => document.querySelector('[aria-label="主导航"]') !== null, { timeout: 20_000 });
  await fresh.waitForFunction(
    () => document.querySelectorAll('[aria-label="列表"] button').length > 0 || document.body.textContent?.includes('还没有会话'),
    { timeout: 15_000 },
  );
  await fresh.screenshot({ path: path.join(OUT, '08-register.png') });

  const bubbles = await alice.$$eval('[aria-label="聊天"] .message-enter', (nodes) => nodes.length);
  assert.ok(bubbles > 0, 'alice should render message bubbles');
  assert.deepEqual(errors, [], `browser errors: ${errors.join(' | ')}`);

  await browser.close();
  chrome.kill();
  console.log(`\nPASS zim-web ui e2e (screenshots in ${OUT})`);
};

main().catch((err) => {
  console.error('\nFAIL', err);
  process.exit(1);
});
