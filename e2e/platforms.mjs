// Cross-shell layout check: desktop and phone widths against the running web
// build. Complements e2e/ui.mjs (which drives real messages) by asserting the
// responsive frame every shell shares.
//
//   npm run dev            # another terminal, HTTPS recommended for calls
//   npm run e2e:platforms

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? process.env.ZIM_E2E_BASE ?? 'https://127.0.0.1:5280';
const CHROME = process.env.ZIM_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.ZIM_DEBUG_PORT ?? 9467);
const OUT = path.resolve('_output/screens/platforms');
const step = (message) => console.log(`- ${message}`);

fs.mkdirSync(OUT, { recursive: true });

const launchChrome = async () => {
  const profile = path.join(os.tmpdir(), 'zim-platforms-chrome');
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
    '--disable-background-timer-throttling',
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
  await setValue(page, 'input[autocomplete="current-password"]', 'password');
  await page.evaluate(() => document.querySelector('button[type="submit"]')?.click());
  await page.waitForSelector('[aria-label="主导航"]', { timeout: 20_000 });
};

const frame = (page) => page.evaluate(() => {
  const rail = document.querySelector('aside[aria-label]') ?? document.querySelector('aside');
  const tabbar = document.querySelector('[data-mobile-tabbar]');
  return {
    platform: window.__zimPlatform?.kind,
    railDisplay: rail ? getComputedStyle(rail).display : 'missing',
    tabbarDisplay: tabbar ? getComputedStyle(tabbar).display : 'missing',
    rootHeight: Math.round(document.getElementById('root')?.getBoundingClientRect().height ?? -1),
    viewportHeight: window.innerHeight,
    safeTop: getComputedStyle(document.documentElement).getPropertyValue('--safe-top').trim(),
  };
});

const openConversation = async (page, title) => {
  // The conversation list arrives after the socket/rest bootstrap.
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-label="列表"] [data-row-title]').length > 0,
    { timeout: 20_000 },
  );
  let clicked = false;
  for (let attempt = 0; attempt < 10 && !clicked; attempt += 1) {
    clicked = await page.evaluate((needle) => {
      const row = [...document.querySelectorAll('[aria-label="列表"] [data-row-title]')]
        .find((node) => (node.textContent ?? '').includes(needle));
      if (!row) return false;
      (row.closest('button') ?? row).click();
      return true;
    }, title);
    if (!clicked) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!clicked) throw new Error(`no conversation row containing ${title}`);
  await page.waitForFunction(
    (needle) => document.querySelector('[aria-label="聊天"] h2')?.textContent?.includes(needle),
    { timeout: 10_000 },
    title,
  );
};

const main = async () => {
  const { chrome, endpoint } = await launchChrome();
  const browser = await puppeteer.connect({ browserURL: endpoint });
  const errors = [];

  const watch = (page) => {
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
  };

  // ---------------------------------------------------------------- desktop --
  const desktop = await browser.newPage();
  watch(desktop);
  await desktop.setViewport({ width: 1440, height: 900 });
  await login(desktop, 'alice');
  const desktopFrame = await frame(desktop);
  assert.equal(desktopFrame.platform, 'web');
  assert.equal(desktopFrame.railDisplay, 'flex', 'desktop rail must be visible');
  assert.equal(desktopFrame.tabbarDisplay, 'none', 'mobile tab bar must be hidden on desktop');
  assert.equal(desktopFrame.rootHeight, desktopFrame.viewportHeight, 'root must fill the viewport');
  step('desktop frame: rail visible, tab bar hidden');

  // A narrow desktop window falls back to the phone frame, not a broken rail.
  await desktop.setViewport({ width: 480, height: 820 });
  await desktop.waitForFunction(() => {
    const bar = document.querySelector('[data-mobile-tabbar]');
    return bar !== null && getComputedStyle(bar).display !== 'none';
  }, { timeout: 5000 });
  const narrowFrame = await frame(desktop);
  assert.equal(narrowFrame.railDisplay, 'none', 'rail must collapse below md');
  assert.equal(narrowFrame.tabbarDisplay, 'flex', 'tab bar must appear below md');
  step('narrow desktop falls back to the mobile frame');
  await desktop.setViewport({ width: 1440, height: 900 });

  await openConversation(desktop, 'Bob');
  await desktop.screenshot({ path: path.join(OUT, 'web-desktop-chat.png') });
  step('desktop chat screenshot');
  await desktop.close();

  // ------------------------------------------------------------------ phone --
  const phone = await browser.newPage();
  watch(phone);
  await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await login(phone, 'alice');
  const phoneFrame = await frame(phone);
  assert.equal(phoneFrame.railDisplay, 'none', 'rail must be hidden on a phone');
  assert.equal(phoneFrame.tabbarDisplay, 'flex', 'tab bar must be visible on a phone');
  assert.equal(phoneFrame.rootHeight, phoneFrame.viewportHeight, 'phone root must use dvh');
  await phone.waitForFunction(
    () => document.querySelectorAll('[aria-label="列表"] [data-row-title]').length > 0,
    { timeout: 20_000 },
  );
  await phone.screenshot({ path: path.join(OUT, 'web-phone-list.png') });
  step('phone list screenshot');

  // The account sheet hosts theme/notifications/logout on phones.
  await phone.evaluate(() => document.querySelector('[data-mobile-tab="me"]')?.click());
  await phone.waitForFunction(() => Boolean(document.querySelector('[data-profile-dialog][open]')), { timeout: 5000 });
  const profileLabel = await phone.evaluate(() => document.querySelector('[data-profile-dialog] [data-platform-label]')?.textContent ?? '');
  assert.ok(profileLabel.includes('Web'), `profile platform label = ${profileLabel}`);
  await phone.screenshot({ path: path.join(OUT, 'web-phone-profile.png') });
  await phone.evaluate(() => document.querySelector('[aria-label="关闭资料"]')?.click());
  await phone.waitForFunction(() => !document.querySelector('[data-profile-dialog][open]'), { timeout: 5000 });
  step('phone account sheet screenshot');

  await openConversation(phone, 'Bob');
  const chatFrame = await frame(phone);
  assert.ok(
    chatFrame.tabbarDisplay === 'none' || chatFrame.tabbarDisplay === 'missing',
    'tab bar yields to the chat composer',
  );
  await phone.screenshot({ path: path.join(OUT, 'web-phone-chat.png') });
  step('phone chat screenshot');

  // Back arrow returns to the list and restores the tab bar.
  await phone.evaluate(() => {
    const back = [...document.querySelectorAll('[aria-label="聊天"] button')]
      .find((node) => (node.textContent ?? '').trim() === '←');
    back?.click();
  });
  await phone.waitForFunction(() => {
    const bar = document.querySelector('[data-mobile-tabbar]');
    return bar !== null && getComputedStyle(bar).display !== 'none';
  }, { timeout: 5000 });
  step('phone back returns to the list');

  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  assert.ok(fs.existsSync(path.join(OUT, 'web-desktop-chat.png')));
  assert.ok(fs.existsSync(path.join(OUT, 'web-phone-list.png')));
  assert.ok(fs.existsSync(path.join(OUT, 'web-phone-chat.png')));

  console.log('\nPlatform layout checks passed.');
  browser.disconnect();
  chrome.kill();
};

await main();
