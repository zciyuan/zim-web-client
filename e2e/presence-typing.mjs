import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

// Self-check for docs/tasks/frontend-presence-typing.md against the local stack.
const target = process.argv[2] ?? 'https://127.0.0.1:5280';
const OUT = path.resolve('_output/screens');
fs.mkdirSync(OUT, { recursive: true });

const profile = path.join(os.tmpdir(), 'zim-probe-presence');
fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--remote-debugging-port=9811', `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--ignore-certificate-errors',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  'about:blank',
], { stdio: 'ignore' });
for (let i = 0; i < 60; i += 1) {
  try { const r = await fetch('http://127.0.0.1:9811/json/version'); if (r.ok) break; } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 250));
}
const browser = await puppeteer.connect({
  browserURL: 'http://127.0.0.1:9811',
  defaultViewport: { width: 1280, height: 860 },
  protocolTimeout: 40000,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const login = async (user) => {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`${user} PAGEERROR:`, String(e).slice(0, 160)));
  await page.goto(target, { waitUntil: 'networkidle2' });
  await page.waitForSelector('form');
  await page.evaluate((u) => {
    const set = (sel, value) => {
      const el = document.querySelector(sel);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('input[autocomplete="username"]', u);
    set('input[autocomplete="current-password"]', 'password');
    document.querySelector('button[type="submit"]').click();
  }, user);
  await page.waitForFunction(() => window.__zim?.getSnapshot().status === 'ready', { timeout: 25_000 });
  await page.waitForFunction(() => window.__zim.getSnapshot().connection === 'open', { timeout: 25_000 });
  return page;
};

const openDirect = async (page) => {
  await page.evaluate(() => window.__zim.openConversation('s_10001_10002'));
  await page.waitForFunction(() => document.querySelector('[aria-label="聊天"] textarea') !== null, { timeout: 15_000 })
    .catch(() => undefined);
  await sleep(400);
};

const headerTyping = (page) => page.evaluate(() => {
  const line = document.querySelector('[aria-label="聊天"] [data-typing]');
  return { typing: line?.getAttribute('data-typing') ?? 'none', text: line?.textContent ?? '' };
});

const typeInComposer = (page, text) => page.evaluate((value) => {
  const input = document.querySelector('[aria-label="聊天"] textarea');
  if (!input) return false;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}, text);

const alice = await login('alice');
const bob = await login('bob');
await sleep(1200);

// ---------------------------------------------------------------- presence --
await alice.bringToFront();
const presence = await alice.evaluate(async () => {
  await window.__zim.refreshPresence(['10001', '10002', '10003'], true);
  return {
    self: window.__zim.presenceOf('10001'),
    peer: window.__zim.presenceOf('10002'),
    absent: window.__zim.presenceOf('10003'),
  };
});
check('presence: api marks online/offline', presence.peer === true && presence.absent === false, JSON.stringify(presence));

await openDirect(alice);
const dot = await alice.evaluate(() => document.querySelector('[data-conversation-row="s_10001_10002"] [data-online]')
  ?.getAttribute('data-online') ?? 'missing');
check('presence: conversation row shows a green dot', dot === 'true', `data-online=${dot}`);
const friendDot = await alice.evaluate(() => {
  const buttons = [...document.querySelectorAll('[aria-label="主导航"] button')];
  buttons[2]?.click();
  return document.querySelector('[data-online]')?.getAttribute('data-online') ?? 'missing';
});
check('presence: friend list shows a dot', friendDot !== 'missing', `data-online=${friendDot}`);

// ------------------------------------------------------------------ typing --
await bob.bringToFront();
await openDirect(bob);
await typeInComposer(bob, 'hello');
await sleep(900);
await alice.bringToFront();
const typingOn = await headerTyping(alice);
check('typing: peer shows 「对方正在输入…」', typingOn.typing === 'true' && typingOn.text.includes('正在输入'), JSON.stringify(typingOn));

await sleep(4500);
const typingOff = await headerTyping(alice);
check('typing: stops after 3s idle', typingOff.typing === 'false', `data-typing=${typingOff.typing}`);

await typeInComposer(bob, 'again');
await sleep(600);
await bob.evaluate(async () => window.__zim.sendMessage(`typing-clear ${Date.now() % 10000}`));
await sleep(800);
const typingAfterSend = await headerTyping(alice);
check('typing: sending clears the hint', typingAfterSend.typing === 'false', `data-typing=${typingAfterSend.typing}`);

// ------------------------------------------------------------------ groups --
const group = await alice.evaluate(async () => {
  const state = window.__zim.getSnapshot();
  const bobFriend = state.friends.find((item) => String(item.friend_id) === '10002');
  const name = `presence-group-${Date.now() % 10000}`;
  const gid = await window.__zim.createGroup(name, [String(bobFriend.friend_id)]);
  return { gid: String(gid), name };
});
await sleep(1200);
for (const page of [bob, alice]) {
  await page.evaluate((g) => {
    window.__zim.openGroup({ group_id: g.gid, display_id: g.gid, name: g.name });
  }, group);
}
await sleep(900);
const groupCid = await alice.evaluate(() => window.__zim.getSnapshot().activeCid);
const bobCid = await bob.evaluate(() => window.__zim.getSnapshot().activeCid);
await bob.bringToFront();
// A brand-new group has no conversation row until the first message, and the
// server resolves typing through that row: send one first, then type.
await bob.evaluate(async (name) => window.__zim.sendMessage(`group-ready ${name}`), group.name);
await sleep(1500);
await typeInComposer(bob, 'hi group');
await sleep(900);
await alice.bringToFront();
const groupHint = await headerTyping(alice);
check(
  'typing: group shows 「昵称 正在输入…」',
  groupCid === bobCid && groupCid !== null
    && groupHint.typing === 'true' && groupHint.text.includes('正在输入') && !groupHint.text.startsWith('有人'),
  `${groupCid} / ${bobCid} / ${JSON.stringify(groupHint)}`,
);

// Group members dialog shows the same green dots.
await bob.evaluate(() => document.querySelector('[aria-label="群设置"]')?.click());
await sleep(1200);
await bob.evaluate(() => {
  const tab = [...document.querySelectorAll('dialog[open] button')]
    .find((item) => (item.textContent ?? '').trim().startsWith('成员'));
  tab?.click();
});
let memberDot = 'missing';
for (let attempt = 0; attempt < 20 && memberDot === 'missing'; attempt += 1) {
  await sleep(400);
  memberDot = await bob.evaluate(() => document.querySelector('[data-member-row] [data-online]')?.getAttribute('data-online') ?? 'missing');
}
await bob.evaluate(() => {
  const button = [...document.querySelectorAll('dialog[open] button')].find((item) => item.textContent?.trim() === '关闭');
  button?.click();
});
check('presence: group member rows show a dot', memberDot === 'true', `data-online=${memberDot}`);

// Leaving the conversation clears our own typing state for the peer.
await bob.bringToFront();
await bob.evaluate(() => window.__zim.openConversation('s_10001_10002'));
await sleep(900);
await alice.bringToFront();
const afterLeave = await headerTyping(alice);
check('typing: switching conversation clears the hint', afterLeave.typing === 'false', `data-typing=${afterLeave.typing}`);

// ------------------------------------------------------------ call 180001 --
await bob.evaluate(() => window.__zim.logout());
await sleep(1500);
await openDirect(alice);
await alice.evaluate(() => window.__zim.startCall(1));
await sleep(2500);
const offlineCall = await alice.evaluate(() => ({
  phase: window.__zim.getSnapshot().call.phase,
  toast: window.__zim.getSnapshot().toast?.text ?? '',
}));
check('call: offline peer → 对方不在线, no room', offlineCall.phase === 'idle' && offlineCall.toast.includes('对方不在线'), JSON.stringify(offlineCall));

// -------------------------------------------------------- call phase 4 -----
const bob2 = await login('bob');
await bob2.bringToFront();
await sleep(2500);
await openDirect(bob2);
await sleep(600);
await alice.evaluate(() => window.__zim.startCall(1));
await sleep(3000);
const ringState = await bob2.evaluate(() => ({
  phase: window.__zim.getSnapshot().call.phase,
  callId: window.__zim.getSnapshot().call.callId,
}));
await bob2.evaluate((id) => {
  const enc = new TextEncoder();
  const parts = [];
  const varint = (value) => {
    const out = [];
    let v = value;
    while (v > 127) { out.push((v & 127) | 128); v >>>= 7; }
    out.push(v);
    return out;
  };
  const str = enc.encode(id);
  parts.push(0x0a, ...varint(str.length), ...str); // field 1: call_id
  parts.push(0x10, ...varint(4)); // field 2: phase = 4
  window.__zimPush(1802, new Uint8Array(parts));
}, ringState.callId);
await sleep(1500);
const elsewhere = await bob2.evaluate(() => ({
  phase: window.__zim.getSnapshot().call.phase,
  toast: window.__zim.getSnapshot().toast?.text ?? '',
}));
check(
  'call: phase=4 → 已在其他设备接听',
  ringState.phase === 'incoming' && elsewhere.phase === 'idle' && elsewhere.toast.includes('其他设备'),
  JSON.stringify({ ringState: ringState.phase, elsewhere }),
);
await alice.evaluate(() => window.__zim.cancelCall()).catch(() => undefined);

await alice.screenshot({ path: path.join(OUT, 'presence-typing.png') });
// Leave cleanly: logout deactivates the device rows this run registered.
await alice.evaluate(() => window.__zim.logout());
await bob2.evaluate(() => window.__zim.logout());
await browser.close();
chrome.kill();

const failed = results.filter((item) => !item.ok);
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} presence/typing/call self-check: ${results.length - failed.length}/${results.length}`);
if (failed.length > 0) process.exit(1);
