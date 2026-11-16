// One live socket per account: the gate closes the previous connection when the
// same account binds again, so two tabs logged in as the same user kick each
// other forever (visible as an endless "正在重连中").
//
// Leadership is a localStorage lease renewed by the owning tab; a tab that does
// not own the lease stays read-only and can take over on demand.

import { randomId } from './id';

const LEASE_KEY = 'zim.tab.leader';
const CHANNEL = 'zim-tab-channel';
const LEASE_TTL_MS = 6000;
const RENEW_MS = 2000;

interface Lease {
  id: string;
  ts: number;
}

export const tabId = (): string => {
  const key = 'zim.tab.id';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = randomId();
    sessionStorage.setItem(key, id);
  }
  return id;
};

const readLease = (): Lease | null => {
  try {
    const raw = localStorage.getItem(LEASE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Lease;
    if (typeof parsed?.id !== 'string' || typeof parsed?.ts !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeLease = (): void => {
  localStorage.setItem(LEASE_KEY, JSON.stringify({ id: tabId(), ts: Date.now() }));
};

const channel = (): BroadcastChannel | null => {
  if (typeof BroadcastChannel === 'undefined') return null;
  return new BroadcastChannel(CHANNEL);
};

/** True when this tab owns (or just acquired) the socket lease. */
export const claimTabLeadership = (force = false): boolean => {
  const lease = readLease();
  const mine = lease?.id === tabId();
  const stale = !lease || Date.now() - lease.ts > LEASE_TTL_MS;
  if (!mine && !stale && !force) return false;
  writeLease();
  return true;
};

/** Keeps the lease alive; returns a stop function. */
export const startLeaseRenewal = (): (() => void) => {
  writeLease();
  const timer = window.setInterval(() => {
    const lease = readLease();
    if (lease && lease.id !== tabId()) return; // someone else took over
    writeLease();
  }, RENEW_MS);
  return () => window.clearInterval(timer);
};

export const releaseTabLeadership = (): void => {
  const lease = readLease();
  if (lease?.id === tabId()) localStorage.removeItem(LEASE_KEY);
};

/** Asks the owning tab to drop its socket so this tab can connect. */
export const requestTabTakeover = (): void => {
  const bus = channel();
  if (!bus) return;
  bus.postMessage({ type: 'takeover', id: tabId() });
  bus.close();
};

/** Notifies this tab when another tab takes the socket over. */
export const onTabTakeover = (handler: () => void): (() => void) => {
  const bus = channel();
  if (!bus) return () => undefined;
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: string; id?: string } | null;
    if (data?.type === 'takeover' && data.id !== tabId()) handler();
  };
  bus.addEventListener('message', listener);
  return () => {
    bus.removeEventListener('message', listener);
    bus.close();
  };
};
