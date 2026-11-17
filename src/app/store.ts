// Application store: owns the connection, the REST client and all UI state.
//
// Components subscribe through useIm(); every mutation replaces the state
// object so useSyncExternalStore sees a new snapshot.

import { useSyncExternalStore } from 'react';

import { IMClient, type ConnectionState, type PushEvent } from '../sdk/client';
import { ImError, wrapError } from '../sdk/errors';
import { directConversationId, groupConversationId, loadOlder, loadTail } from '../sdk/history';
import { messagePreview, messageText } from './format';
import { offerPasswordSave, saveLoginPrefs } from './loginPrefs';
import { captureVideoPoster, compressImage, measureImage, measureMedia } from './image';
import { randomId } from './id';
import { detectRtcSupport, explainRtcError } from './rtc-support';
import {
  OP,
  decodeMessageItem,
  decodeMyGroupsRes,
  decodeMergeRes,
  decodeQuoteRes,
  decodeReadSyncPush,
  decodeFriendEventPush,
  decodeTypingPush,
  encodeTypingReq,
  decodeOnlineChangePush,
  decodeSubscribeOnlineRes,
  encodeSubscribeOnlineReq,
  decodeSearchMessageRes,
  decodeOperationRes,
  decodeReadReceiptRes,
  decodeSendRes,
  encodeDeleteMessageReq,
  encodeEditMessageReq,
  encodeMyGroupsReq,
  encodeReactionReq,
  encodeRecallReq,
  encodeMergeReq,
  encodeQuoteReq,
  encodeSearchMessageReq,
  encodeReadReceiptReq,
  encodeSendGroupReq,
  encodeSendSingleReq,
} from '../sdk/messages';
import {
  decodeSyncCheckRes,
  decodeSyncMissingRes,
  encodeSyncCheckReq,
  encodeSyncMissingReq,
} from '../sdk/sync';
import {
  decodeCallAnswer,
  decodeCallHangupRes,
  decodeCallInviteRes,
  decodeCallStateRes,
  decodeRoomTokenRes,
  encodeCallAnswerReq,
  encodeCallCancelReq,
  encodeCallHangupReq,
  encodeCallInviteReq,
  encodeCallStateReq,
  encodeParticipantStateReq,
  encodeRoomTokenReq,
  type CallAnswerPush,
  type CallStateResult,
} from '../sdk/rtc';
import { GROUP_EVENT, decodeGroupEvent, type GroupEvent } from '../sdk/groups';
import { callSession } from './call';
import {
  decodeRelationOperationRes,
  encodeAddBlackReq,
  encodeAddFriendReq,
  encodeAnswerFriendReq,
  encodeDeleteFriendReq,
} from '../sdk/relation';
import { IMHttp } from '../sdk/rest';
import {
  GROUP_OP,
  decodeCreateGroupRes,
  decodeGroupMembersRes,
  decodeGroupOperationRes,
  decodeSearchGroupRes,
  decodeUpdateGroupRes,
  encodeAnswerJoinReq,
  encodeApplyJoinReq,
  encodeCreateGroupReq,
  encodeGroupIdReq,
  encodeGroupMembersReq,
  encodeGroupNotifyReq,
  encodeGroupUserReq,
  encodeInviteGroupMembersReq,
  encodeMuteAllReq,
  encodeMuteMemberReq,
  encodeSearchGroupReq,
  encodeSetGroupAdminReq,
  encodeUpdateGroupReq,
  type GroupMemberInfo,
  type GroupSummary,
} from '../sdk/groups';
import type {
  Conversation,
  Friend,
  FriendRequestItem,
  Group,
  GroupMember,
  LoginRes,
  MessageItem,
  UserProfile,
} from '../sdk/types';

/** True when the failure means the saved token is unusable (not a network blip). */
const isAuthFailure = (err: unknown): boolean => {
  const wrapped = wrapError(err);
  if (wrapped.code === 100001 || wrapped.code === 100002 || wrapped.code === 100003) return true;
  return /token|401|unauthorized|登录态/i.test(`${wrapped.detail} ${wrapped.message}`);
};

const SESSION_KEY = 'zim.session';
const SYNC_KEY = 'zim.sync';
const DEVICE_KEY = 'zim.device';
const ENDPOINT_KEY = 'zim.endpoint';

// A loopback endpoint saved on this machine is useless from another device:
// fall back to same-origin (the dev server proxies /v1 and /ws).
const savedEndpoint = (): string => {
  const saved = localStorage.getItem(ENDPOINT_KEY) ?? '';
  if (!saved) return '';
  const loopbackUrl = /(^|\/\/)(127\.0\.0\.1|localhost)(:|\/|$)/i.test(saved);
  const pageLoopback = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname);
  return loopbackUrl && !pageLoopback ? '' : saved;
};
const SDK_VERSION = 'web-2.0.0';

/**
 * Ringing timeout shared by both ends. The server's maintenance sweep expires
 * ringing calls older than 30s, so the client uses the same window and ends the
 * sheet itself — otherwise a callee that never answers leaves the caller stuck
 * on "正在呼叫…" forever.
 *
 * `localStorage.zim.callRingTimeout` (ms) overrides it for tests.
 */
export const CALL_RING_TIMEOUT_MS = (() => {
  if (typeof localStorage === 'undefined') return 30_000;
  const override = Number(localStorage.getItem('zim.callRingTimeout'));
  return Number.isFinite(override) && override >= 1000 ? override : 30_000;
})();

/** Joining the SFU (room token + connect) must not hang the sheet forever. */
const CALL_CONNECT_TIMEOUT_MS = 20_000;

export type Tab = 'conversations' | 'unread' | 'friends' | 'groups';
export type AppStatus = 'idle' | 'restoring' | 'authenticating' | 'ready';

export interface UiMessage extends MessageItem {
  localState?: 'sending' | 'sent' | 'failed';
  /** upload percentage (0-100) while an attachment is still uploading */
  progress?: number;
}

export interface Thread {
  items: UiMessage[];
  loading: boolean;
  loadingOlder: boolean;
  hasMoreOlder: boolean;
  error: string;
}

export interface Me {
  uid: string;
  name: string;
  avatar: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

export type ThemeMode = 'system' | 'light' | 'dark';

export interface ImState {
  status: AppStatus;
  authError: string;
  connection: ConnectionState;
  /** conversation id -> who is typing and until when (ms) */
  typing: Record<string, { uid: string; until: number }>;
  /** uid -> online flag (at least one device), refreshed by the presence poll */
  presence: Record<string, boolean>;
  /** desktop notifications enabled and permitted */
  notifications: boolean;
  /** color theme preference */
  theme: ThemeMode;
  /** conversation id -> read seq captured when it was opened (unread divider) */
  unreadAnchors: Record<string, number>;
  /** message to scroll to and flash (global search / quote jump) */
  focusMessageId: string | null;
  /** drafts whose upload failed and can be retried */
  uploadRetries: string[];
  /** keyword highlighted inside the focused message (search jumps) */
  searchHighlight: string;
  /** most recent search keywords (newest first) */
  searchHistory: string[];
  /** unsent text per conversation (drafts survive switching) */
  drafts: Record<string, string>;
  /** group announcements keyed by exact group id (banner source) */
  groupNotices: Record<string, string>;
  /** repeated abnormal closes: the account is live elsewhere, stop retrying */
  kickedLoop: boolean;
  /** direct chats: how far the peer has read (seq, from 1906) */
  peerReads: Record<string, number>;
  quoteTarget: UiMessage | null;
  call: CallStatus;
  /** group id -> the persistent voice/video room currently open for that group */
  groupCalls: Record<string, GroupCallRoom>;
  /** last RTC failure, kept for diagnostics */
  lastCallError: string;
  me: Me | null;
  endpoint: string;
  tab: Tab;
  conversations: Conversation[];
  friends: Friend[];
  friendRequests: FriendRequestItem[];
  /** profiles of request senders, for display names */
  requestProfiles: Record<string, UserProfile>;
  blacklist: UserProfile[];
  groups: Group[];
  activeCid: string | null;
  threads: Record<string, Thread>;
  toast: Toast | null;
  /** diagnostics: number of 1901 frames accepted */
  pushCount: number;
}

interface SavedSession {
  endpoint: string;
  username: string;
  accessToken: string;
  refreshToken: string;
}

const initialState: ImState = {
  status: 'idle',
  authError: '',
  connection: 'idle',
  typing: {},
  presence: {},
  peerReads: {},
  notifications: typeof localStorage !== 'undefined' && localStorage.getItem('zim.notifications') === '1',
  theme: (typeof localStorage !== 'undefined' ? (localStorage.getItem('zim.theme') as ThemeMode | null) : null) ?? 'system',
  unreadAnchors: {},
  focusMessageId: null,
  uploadRetries: [],
  searchHighlight: '',
  searchHistory: [],
  drafts: {},
  groupNotices: {},
  kickedLoop: false,
  quoteTarget: null,
  call: emptyCall(),
  groupCalls: {},
  lastCallError: '',
  me: null,
  endpoint: savedEndpoint(),
  tab: 'conversations',
  conversations: [],
  friends: [],
  friendRequests: [],
  requestProfiles: {},
  blacklist: [],
  groups: [],
  activeCid: null,
  threads: {},
  toast: null,
  pushCount: 0,
};

const normalizeHttpBase = (raw: string): string => {
  const value = raw.trim().replace(/\/+$/, '');
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
};

const wsBaseOf = (httpBase: string): string => (httpBase ? httpBase.replace(/^http/i, 'ws') : '');

// The SFU URL comes from the server. In dev it is a loopback address, which a
// phone on the LAN cannot reach, and an https page cannot open ws:// at all.
// Rewrite it to the page origin (/rtc is proxied by the dev server) so calls
// work from any device on the network with the certificate the page already has.
const sfuUrlFor = (raw: string): string => {
  if (typeof window === 'undefined') return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  const insecureOnHttps = window.location.protocol === 'https:' && url.protocol === 'ws:';
  if (!loopback && !insecureOnHttps) return raw;
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // The LiveKit SDK appends /rtc itself, so the base must stay at the origin.
  return `${scheme}//${window.location.host}`;
};

const deviceId = (): string => {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `web-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
};

/** REST serialises int64 as JSON numbers, so snowflake ids arrive rounded.
 *  Every id used in a request is taken from a string source instead:
 *  conversation_id ("g_<gid>" / "s_<uid>_<uid>") or the protobuf payload. */
const roundedKey = (value: string | number): string => String(Number(value));

const normalizeConversation = (item: Conversation, selfUid: string): Conversation => {
  const cid = String(item.conversation_id ?? '');
  if (cid.startsWith('g_')) {
    item.group_id = cid.slice(2);
    item.peer_id = '0';
  } else if (cid.startsWith('s_')) {
    const [, a, b] = cid.split('_');
    item.group_id = '0';
    item.peer_id = String(a) === String(selfUid) ? b : a;
  }
  return item;
};

/**
 * Collapses items that share a server_msg_id, keeping the last occurrence.
 *
 * The same message can reach a thread twice: once as the send response and once
 * as the 1901 push (or twice through a resend), and React keys must stay unique.
 */
const dedupeMessages = (items: UiMessage[]): UiMessage[] => {
  const seen = new Map<string, UiMessage>();
  const order: string[] = [];
  for (const item of items) {
    const key = item.server_msg_id || `local:${item.client_msg_id}`;
    if (!seen.has(key)) order.push(key);
    seen.set(key, item);
  }
  return order.map((key) => seen.get(key) as UiMessage);
};

/** RTC call phase shown by the call overlay. */
export type CallPhase = 'idle' | 'incoming' | 'outgoing' | 'connecting' | 'active';

/** 1 direct / 2 normal group / 3 family group. */
export type CallTargetType = 1 | 2 | 3;

/** Group-like calls live in a persistent room (join/leave at any time). */
const isRoomTarget = (target: number): boolean => target === 2 || target === 3;

export interface CallStatus {
  phase: CallPhase;
  callId: string;
  media: 1 | 2;
  /** 1 direct / 2 normal group / 3 family group */
  targetType: CallTargetType;
  /** group rooms: the group/family this call belongs to */
  groupId: string;
  /** group calls: another member already joined */
  joinedElsewhere: boolean;
  /** this client already attached its media session to the room */
  joined: boolean;
  /** group calls: identities currently in the SFU room */
  participants: string[];
  /** group calls: identities currently speaking */
  speaking: string[];
  peerId: string;
  peerName: string;
  room: string;
  startedAt: number;
  muted: boolean;
  videoOn: boolean;
  error: string;
}

function emptyCall(): CallStatus {
  return {
    phase: 'idle', callId: '', media: 1, targetType: 1, groupId: '', joinedElsewhere: false, joined: false, participants: [], speaking: [],
    peerId: '', peerName: '', room: '', startedAt: 0, muted: false, videoOn: true, error: '',
  };
}

/** A group-like persistent voice/video room (target_type=2 group, 3 family). */
export interface GroupCallRoom {
  callId: string;
  targetType: CallTargetType;
  media: 1 | 2;
  active: boolean;
  /** uids the server reports as participants (best effort). */
  participants: string[];
  room: string;
  startedAt: number;
}

const emptyThread = (): Thread => ({
  items: [],
  loading: false,
  loadingOlder: false,
  hasMoreOlder: false,
  error: '',
});

class ImStore {
  private state: ImState = initialState;
  private listeners = new Set<() => void>();
  private rest = new IMHttp({ baseUrl: initialState.endpoint });
  private client: IMClient | null = null;
  private seenPushes = new Set<string>();
  private pollTimer: number | null = null;
  private lastTypingSentAt = 0;
  /** Sends typing=false once the composer goes quiet (or the chat is left). */
  private typingStopTimer: number | null = null;
  /** uids explicitly requested by a view (e.g. group members dialog). */
  private presenceWatched = new Set<string>();
  /** Re-subscribe timer while the page is visible (WS subscription TTL is 2min). */
  private presenceTimer: number | null = null;
  /** Group rooms: 1807 heartbeat while the user stays in the SFU room. */
  private groupHeartbeatTimer: number | null = null;
  /** Group rooms: best-effort 1803 when the tab goes away. */
  private unloadLeaveHandler: (() => void) | null = null;
  private toastSeq = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private restorePromise: Promise<void> | null = null;
  /** Timestamps of recent abnormal closes (kick-loop detection). */
  private closeStamps: number[] = [];
  /** Ringing timeout for the current call (both ends). */
  private ringTimer: number | null = null;
  /** Join-the-SFU timeout for the current call. */
  private connectTimer: number | null = null;
  /** Pushes that arrived while a thread page was still loading, keyed by cid. */
  private pendingPushes = new Map<string, UiMessage[]>();
  /** Files kept for failed uploads so they can be retried. */
  private uploadJobs = new Map<string, { file: File; msgType: number; guard: number | null }>();

  constructor() {
    this.applyTheme();
    this.loadSearchHistory();
    this.loadDrafts();
    // "system" keeps following the OS while the app runs.
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (this.state.theme === 'system') this.applyTheme();
      });
    }
  }

  /** Applies the current theme preference to <html> (adds/removes .dark). */
  private applyTheme(): void {
    if (typeof document === 'undefined') return;
    const mode = this.state.theme;
    const dark = mode === 'dark'
      || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.dataset.theme = mode;
  }

  /** Sets and persists the theme ('system' | 'light' | 'dark'). */
  setTheme(mode: ThemeMode): void {
    this.set({ theme: mode });
    try {
      localStorage.setItem('zim.theme', mode);
    } catch {
      // private mode: in-memory only
    }
    this.applyTheme();
  }

  /** Cycles system -> light -> dark -> system. */
  cycleTheme(): void {
    const order: ThemeMode[] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(this.state.theme) + 1) % order.length];
    this.setTheme(next);
    this.notify(next === 'system' ? '跟随系统外观' : next === 'dark' ? '深色模式' : '浅色模式');
  }

  // ------------------------------------------------------------ plumbing --

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ImState => this.state;

  /** Current user (null before login). */
  get me(): Me | null {
    return this.state.me;
  }

  private set(patch: Partial<ImState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  notify(text: string, kind: Toast['kind'] = 'info'): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    const toast: Toast = { id: ++this.toastSeq, text, kind };
    this.set({ toast });
    this.toastTimer = setTimeout(() => {
      this.set({ toast: null });
      this.toastTimer = null;
    }, 2800);
  }

  // --------------------------------------------------------------- lookup --

  conversation(cid: string | null): Conversation | undefined {
    if (!cid) return undefined;
    return this.state.conversations.find((item) => item.conversation_id === cid);
  }

  friendName(uid: string | number): string {
    const friend = this.state.friends.find((item) => String(item.friend_id) === String(uid));
    return friend?.remark || friend?.profile?.nickname || friend?.profile?.username || '';
  }

  /** Group record for an exact or rounded group id. */
  groupOf(gid: string | number): Group | undefined {
    if (!gid) return undefined;
    const key = roundedKey(gid);
    return this.state.groups.find((item) => roundedKey(item.group_id) === key);
  }

  groupName(gid: string | number): string {
    const key = roundedKey(gid);
    return this.state.groups.find((item) => roundedKey(item.group_id) === key)?.name ?? '';
  }

  /** Group kind from the group list: 1 normal, 3 family (0 when unknown). */
  groupTypeOf(gid: string | number): number {
    const key = roundedKey(gid);
    const group = this.state.groups.find((item) => roundedKey(item.group_id) === key);
    return Number(group?.group_type ?? 0);
  }

  senderName(uid: string | number): string {
    if (String(uid) === String(this.state.me?.uid ?? '')) return this.state.me?.name ?? '我';
    return this.friendName(uid) || `用户 ${uid}`;
  }

  conversationTitle(conversation: Conversation | undefined): string {
    if (!conversation) return '';
    return conversation.type === 2
      ? this.groupName(conversation.group_id) || `群 ${conversation.group_id}`
      : this.friendName(conversation.peer_id) || `用户 ${conversation.peer_id}`;
  }

  thread(cid: string): Thread {
    return this.state.threads[cid] ?? emptyThread();
  }

  /** Resolves a server-relative attachment path against the configured API. */
  assetUrl(path: string): string {
    return this.rest.absolute(path);
  }

  totalUnread(): number {
    return this.state.conversations.reduce((sum, item) => sum + Number(item.unread ?? 0), 0);
  }

  // ----------------------------------------------------------------- auth --

  setTab(tab: Tab): void {
    this.set({ tab });
  }

  /** Clears the open conversation (used by the small-screen back button). */
  clearActive(): void {
    this.set({ activeCid: null });
  }

  /** Re-reads the list snapshots after a reconnect or a manual refresh. */
  /** WebRTC capability of the current browser (call UI degrades on it). */
  get rtcSupport(): ReturnType<typeof detectRtcSupport> {
    return detectRtcSupport();
  }

  /** Stops reconnecting after repeated abnormal closes (account live elsewhere). */
  private stopKickLoop(): void {
    this.closeStamps = [];
    this.client?.close();
    this.set({ kickedLoop: true, connection: 'closed' });
    this.notify('登录状态在别处被接管，已暂停自动重连', 'error');
  }


  /** Manual retry after a dropped connection: reopen the socket and refresh. */
  async retryConnection(): Promise<void> {
    if (this.state.kickedLoop) {
      this.set({ kickedLoop: false, connection: 'idle' });
      this.client?.close();
      this.client = null;
      this.restorePromise = null;
      this.closeStamps = [];
      await this.restore();
      return;
    }
    if (this.state.connection === 'open' || this.state.connection === 'connecting' || this.state.connection === 'reconnecting') {
      await this.refresh();
      return;
    }
    this.client?.close();
    this.client = null;
    this.restorePromise = null;
    await this.restore();
    if ((this.state.connection as string) === 'open') this.notify('已重新连接');
  }

  async refresh(): Promise<void> {
    try {
      await this.bootstrap();
      this.notify('已刷新');
    } catch (err) {
      this.notify(wrapError(err).message, 'error');
    }
  }

  async login(username: string, password: string, rawEndpoint: string): Promise<void> {
    const endpoint = normalizeHttpBase(rawEndpoint);
    localStorage.setItem(ENDPOINT_KEY, endpoint);
    this.set({ status: 'authenticating', authError: '', endpoint });
    this.rest = new IMHttp({ baseUrl: endpoint });

    try {
      const session = await this.rest.login({ username, password, platform: 4 });
      // Remember the account (never the password) before the workspace renders:
      // the login form re-reads this on its next mount.
      saveLoginPrefs({ username, endpoint });
      // Hand the secret to the browser's password manager instead of localStorage.
      offerPasswordSave(username, password);
      await this.enterWorkspace(session.access_token, endpoint, username);
    } catch (err) {
      const error = wrapError(err);
      this.rest.clearTokens();
      this.client?.close();
      this.client = null;
      this.set({ status: 'idle', authError: error.display, connection: 'closed' });
      throw error;
    }
  }

  /** Creates an account and enters the app in one round trip. */
  async register(username: string, password: string, nickname: string, rawEndpoint: string): Promise<void> {
    const endpoint = normalizeHttpBase(rawEndpoint);
    localStorage.setItem(ENDPOINT_KEY, endpoint);
    this.set({ status: 'authenticating', authError: '', endpoint });
    this.rest = new IMHttp({ baseUrl: endpoint });

    try {
      const session = await this.rest.register({ username, password, nickname, platform: 4 });
      saveLoginPrefs({ username, endpoint });
      offerPasswordSave(username, password, nickname || undefined);
      await this.enterWorkspace(session.access_token, endpoint, username);
    } catch (err) {
      const error = wrapError(err);
      this.rest.clearTokens();
      this.client?.close();
      this.client = null;
      this.set({ status: 'idle', authError: error.display, connection: 'closed' });
      throw error;
    }
  }

  /** Restores a saved session exactly once.
   *
   * React StrictMode mounts effects twice in development; two concurrent
   * connects would open two sockets for the same device, the gate would kick
   * one, and the kicked client would reconnect — an endless fight. Sharing one
   * promise makes the call idempotent. */
  restore(): Promise<void> {
    this.restorePromise ??= this.restoreSession();
    return this.restorePromise;
  }

  private async restoreSession(): Promise<void> {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) {
      this.set({ status: 'idle' });
      return;
    }
    let saved: SavedSession;
    try {
      saved = JSON.parse(raw) as SavedSession;
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
      this.set({ status: 'idle' });
      return;
    }
    if (!saved.accessToken) {
      this.set({ status: 'idle' });
      return;
    }

    this.set({ status: 'restoring', endpoint: saved.endpoint ?? '' });
    this.rest = new IMHttp({ baseUrl: saved.endpoint ?? '' });
    this.rest.setTokens({ accessToken: saved.accessToken, refreshToken: saved.refreshToken });
    try {
      await this.enterWorkspaceWithRetry(saved.accessToken, saved.endpoint ?? '', saved.username ?? '');
    } catch (err) {
      this.client?.close();
      this.client = null;
      if (isAuthFailure(err)) {
        // The token is gone or was kicked: the saved session is worthless.
        this.rest.clearTokens();
        sessionStorage.removeItem(SESSION_KEY);
        this.set({ status: 'idle', connection: 'closed' });
        return;
      }
      // A transient network failure must not destroy a valid session: keep the
      // saved tokens so a retry (button or reload) can resume it.
      this.set({ status: 'idle', connection: 'closed' });
      this.notify('网络异常，登录态已保留，请重试', 'error');
    }
  }

  /**
   * Runs the workspace bootstrap, retrying transient failures.
   *
   * Auth failures are final (the token is dead); everything else is retried a
   * few times so a flaky network does not send the user back to the login form.
   */
  private async enterWorkspaceWithRetry(token: string, endpoint: string, username: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.enterWorkspace(token, endpoint, username);
        return;
      } catch (err) {
        lastError = err;
        if (isAuthFailure(err)) throw err;
        if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 600 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async enterWorkspace(token: string, endpoint: string, username: string): Promise<void> {
    // Same-platform logins are single-session: the newest connection wins and the
    // server pushes 1902 to the old one, which then logs out (see handleKick).
    this.set({ kickedLoop: false });
    // One live socket per client: a re-login must not leave the previous one
    // reconnecting in the background (it would kick the new connection).
    this.client?.close();
    this.client = new IMClient({
      baseUrl: wsBaseOf(endpoint),
      sdk: SDK_VERSION,
      deviceId: deviceId(),
      deviceName: '浏览器',
      onState: (connection, detail) => {
        if (import.meta.env.DEV) console.debug(`[zim] conn ${connection} ${detail?.code ?? ''} ${detail?.reason ?? ''}`);
        this.set({ connection: connection === 'reconnected' ? 'open' : connection });
        if (connection === 'offline') this.notify('连接已断开，自动重连已放弃，请刷新页面', 'error');
        // Repeated abnormal closes mean another client owns the account: stop
        // the reconnect fight instead of showing "正在重连中" forever.
        if (connection === 'closed' && (detail?.code === 1006 || detail?.code === undefined)) {
          const now = Date.now();
          this.closeStamps = this.closeStamps.filter((stamp) => now - stamp < 25_000);
          this.closeStamps.push(now);
          if (this.closeStamps.length >= 4) this.stopKickLoop();
        }
        if (connection === 'open' || connection === 'reconnected') this.closeStamps = [];
        // A reconnect may have missed pushes: converge with 1601/1514 and
        // reconcile the call sheet through 1805.
        if (connection === 'reconnected') {
          void this.runSync();
          void this.reconcileCall();
        }
      },
      onPush: (event) => void this.handlePush(event),
      onKick: (event) => this.handleKick(event.reason),
    });

    // A second login can catch the server closing the previous binding: the
    // socket dies mid-handshake with "连接已关闭". One retry always wins.
    let login: LoginRes | null = null;
    for (let attempt = 0; attempt < 3 && !login; attempt += 1) {
      try {
        login = await this.client.open(token);
      } catch (err) {
        const text = wrapError(err).display;
        if (attempt < 2 && /连接已关闭|连接已断开|连接已关闭|已断开连接/.test(text)) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        throw err;
      }
    }
    if (!login) throw new ImError(0, '登录失败，请重试');
    // The REST client owns both tokens (login or refresh may have rotated them).
    this.persistSession(endpoint, username);
    this.rememberSyncBaseline(login.uid, login.sync);

    this.set({
      status: 'ready',
      authError: '',
      me: {
        uid: login.uid,
        name: login.nickname || username || login.uid,
        avatar: login.avatar,
      },
    });
    await this.bootstrap();
    // Catch up on anything that changed while this client was offline.
    void this.runSync();
    this.startPolling();
    void this.subscribePresence();
  }

  private persistSession(endpoint: string, username: string): void {
    const tokens = this.rest.tokens();
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ endpoint, username, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
    );
  }

  logout(kicked = false): void {
    this.stopPolling();
    this.stopPresence();
    // A kicked connection is already gone: skip the logout round-trip.
    if (!kicked) {
      void this.client?.request(OP.LOGOUT, new Uint8Array(0), decodeOperationRes).catch(() => undefined);
    }
    this.client?.close();
    this.client = null;
    this.rest.clearTokens();
    sessionStorage.removeItem(SESSION_KEY);
    this.seenPushes.clear();
    this.set({
      status: 'idle',
      connection: 'idle',
      me: null,
      tab: 'conversations',
      conversations: [],
      friends: [],
      groups: [],
      activeCid: null,
      threads: {},
      authError: '',
    });
  }

  // ------------------------------------------------------------- bootstrap --

  private async bootstrap(): Promise<void> {
    const results = await Promise.allSettled([
      this.rest.me(),
      this.rest.friends(),
      this.rest.conversations(),
      this.rest.groups(),
      this.rest.friendRequests('in'),
      this.rest.blacklist(),
    ]);
    const [me, friends, conversations, groups, requests, blacklist] = results;

    const patch: Partial<ImState> = {};
    if (me.status === 'fulfilled') {
      const self = me.value;
      patch.me = {
        uid: String(self.uid),
        name: self.nickname || self.username || String(self.uid),
        avatar: self.avatar ?? '',
      };
    }
    if (friends.status === 'fulfilled') patch.friends = friends.value;
    if (conversations.status === 'fulfilled') {
      const selfUid = patch.me?.uid ?? this.state.me?.uid ?? '';
      patch.conversations = conversations.value.map((item) => normalizeConversation(item, selfUid));
    }
    if (groups.status === 'fulfilled') patch.groups = groups.value;
    if (requests.status === 'fulfilled') patch.friendRequests = requests.value as FriendRequestItem[];
    if (blacklist.status === 'fulfilled') patch.blacklist = blacklist.value as UserProfile[];
    this.set(patch);

    // Exact snowflake group ids come from the wire protocol, not from REST JSON.
    let groupIds: string[] = [];
    try {
      const res = await this.client?.request(OP.MY_GROUPS, encodeMyGroupsReq(), decodeMyGroupsRes);
      groupIds = res?.payload.group_ids ?? [];
    } catch {
      groupIds = [];
    }
    this.set({
      groups: this.state.groups.map((group) => ({
        ...group,
        display_id:
          groupIds.find((gid) => roundedKey(gid) === roundedKey(group.group_id)) ?? String(group.group_id),
      })),
    });
    this.rekeyGroupConversations();

    const failed = results.find((item) => item.status === 'rejected');
    if (failed && failed.status === 'rejected') {
      this.notify(wrapError(failed.reason).message, 'error');
    }
  }

  private exactGroupId(value: string): string {
    const key = roundedKey(value);
    const group = this.state.groups.find((item) => roundedKey(item.group_id) === key);
    return group?.display_id ?? String(value);
  }

  // --------------------------------------------------------------- threads --

  /** Drops one cached thread and loads it again (pull-to-refresh). */
  async reloadThread(cid: string): Promise<void> {
    if (!cid) return;
    this.set({ threads: { ...this.state.threads, [cid]: emptyThread() } });
    await this.openConversation(cid);
  }

  async openConversation(cid: string): Promise<void> {
    // Leaving a chat must clear our own typing flag on the old conversation,
    // otherwise the peer keeps seeing "正在输入…" for up to 5 seconds.
    if (this.state.activeCid && this.state.activeCid !== cid) {
      if (this.typingStopTimer !== null) {
        window.clearTimeout(this.typingStopTimer);
        this.typingStopTimer = null;
      }
      if (this.lastTypingSentAt) this.sendTyping(this.state.activeCid, false);
      this.lastTypingSentAt = 0;
    }
    if (import.meta.env.DEV) {
      console.debug(`[zim] openConversation cid=${cid} items=${this.state.threads[cid]?.items.length ?? 0}`);
    }
    if (this.state.activeCid !== cid) this.set({ searchHighlight: '' });
    this.set({ activeCid: cid, tab: this.state.tab === 'friends' || this.state.tab === 'groups' ? 'conversations' : this.state.tab });
    const conversation = this.conversation(cid);
    if (!conversation) return;

    // Group rooms are persistent: opening the group asks the server whether a
    // call is running so the "join" entry appears without waiting for a push.
    if (conversation.type === 2) {
      const gid = cid.startsWith('g_') ? cid.slice(2) : String(conversation.group_id ?? '');
      if (gid && gid !== '0') void this.refreshGroupCall(gid);
    }

    // Remember where the unread block starts before markRead clears it.
    const anchor = Number(conversation.read_seq ?? 0);
    if (anchor > 0) {
      this.set({ unreadAnchors: { ...this.state.unreadAnchors, [cid]: anchor } });
    }

    const existing = this.state.threads[cid];
    if (existing && existing.items.length > 0) {
      // The thread is cached, but new messages may have arrived while it was
      // closed: opening it must still send the read receipt, otherwise the
      // sender's bubble stays on 未读.
      void this.markRead(cid);
      return;
    }

    this.patchThread(cid, { loading: true, error: '' });
    try {
      const { messages, hasMoreOlder } = await loadTail(this.rest, conversation, 40);
      // Merge anything that arrived over the socket while the page was loading.
      const pending = this.pendingPushes.get(cid) ?? [];
      this.pendingPushes.delete(cid);
      const seen = new Set(messages.map((message) => message.server_msg_id).filter(Boolean));
      const merged = [...messages, ...pending.filter((message) => message.server_msg_id && !seen.has(message.server_msg_id))];
      merged.sort((a, b) => Number(a.seq) - Number(b.seq));
      this.patchThread(cid, { items: merged, loading: false, hasMoreOlder, error: '' });
      await this.markRead(cid);
    } catch (err) {
      this.patchThread(cid, { loading: false, error: wrapError(err).message });
    }
  }

  /** Group members, with nicknames resolved through the batch profile endpoint. */
  /** Group members with roles (WS 1310) and nicknames (REST batch profiles). */
  async groupMembers(gid: string, offset = 0, limit = 200): Promise<GroupMember[]> {
    if (!this.client) throw new ImError(0, '连接未就绪');
    const res = await this.client.request(
      GROUP_OP.MEMBERS,
      encodeGroupMembersReq({ groupId: gid, offset, limit }),
      decodeGroupMembersRes,
    );
    const rows: GroupMemberInfo[] = res.payload;
    const uids = rows.map((row) => row.uid).filter(Boolean);
    let profiles: UserProfile[] = [];
    if (uids.length > 0) {
      try {
        profiles = await this.rest.users(uids);
      } catch {
        profiles = [];
      }
    }
    const byUid = new Map(profiles.map((profile) => [String(profile.uid), profile]));
    return rows.map((row) => {
      const profile = byUid.get(String(row.uid));
      return {
        user_id: row.uid,
        role: row.role,
        mute_until: row.mute_until,
        joined_at: row.joined_at,
        nickname: profile?.nickname,
        username: profile?.username,
      };
    });
  }

  /** Full group profile (name / notice / join policy) over REST. */
  async groupDetail(gid: string): Promise<Group | null> {
    try {
      const group = await this.rest.group(gid);
      if (group) {
        // Never let a stale/empty REST value clobber a just-saved announcement.
        const notice = typeof group.notification === 'string' ? group.notification : '';
        const known = this.state.groupNotices[gid];
        if (notice || known === undefined) {
          this.set({ groupNotices: { ...this.state.groupNotices, [gid]: notice } });
        }
        this.set({
          groups: this.state.groups.map((item) => (roundedKey(item.group_id) === roundedKey(gid)
            ? { ...item, display_id: item.display_id ?? gid }
            : item)),
        });
      }
      return group;
    } catch (err) {
      this.notify(wrapError(err).display, 'error');
      return null;
    }
  }

  /** Pending join requests (owner/admin only; empty for members). */
  groupApplies(gid: string): Promise<unknown[]> {
    return this.rest.groupApplies(gid);
  }

  // ------------------------------------------------------------ relation ----

  /** Runs a friend write over WS; false means "fall back to REST". */
  private async friendViaWs(opcode: number, payload: Uint8Array): Promise<boolean> {
    if (!this.client || this.state.connection !== 'open') return false;
    try {
      await this.client.request(opcode, payload, decodeRelationOperationRes);
      return true;
    } catch (err) {
      if (import.meta.env.DEV) console.debug('[zim] friend ws failed, falling back to REST', err);
      return false;
    }
  }

  /** Polls friend requests/friends so changes from other clients appear live. */
  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = window.setInterval(() => {
      void this.pollRelations();
    }, 20_000);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollRelations(): Promise<void> {
    if (this.state.status !== 'ready' || this.state.connection !== 'open') return;
    try {
      const [requests, friends] = await Promise.all([
        this.rest.friendRequests('in'),
        this.rest.friends(),
      ]);
      const before = this.state.friendRequests.length;
      this.set({
        friendRequests: requests as FriendRequestItem[],
        friends: friends as Friend[],
      });
      if (requests.length > before) this.notify('收到新的好友申请');
    } catch {
      // offline or transient: the next tick retries
    }
    // Presence is WS-driven (1106 snapshot + 1903 pushes); this poll only
    // re-subscribes, which also refreshes the 2 minute server-side TTL.
    void this.subscribePresence();
  }

  // ----------------------------------------------------------------- group --

  /** Server pushed a group change (1904): refresh the group view. */
  private handleGroupEvent(payload: Uint8Array): void {
    let event: GroupEvent;
    try {
      event = decodeGroupEvent(payload);
    } catch {
      return;
    }
    if (import.meta.env.DEV) console.debug(`[zim] group event kind=${event.kind} gid=${event.group_id} name=${event.name}`);
    const gid = String(event.group_id);
    const selfUid = String(this.state.me?.uid ?? '');
    const isActive = String(this.state.conversations.find((item) => item.conversation_id === this.state.activeCid)?.group_id ?? '') === gid;

    switch (event.kind) {
      case GROUP_EVENT.DISMISSED:
        this.notify('群聊已解散');
        if (isActive) this.set({ activeCid: null });
        break;
      case GROUP_EVENT.MEMBER_KICKED:
        if (String(event.target_id) === selfUid) {
          this.notify('你已被移出该群聊');
          if (isActive) this.set({ activeCid: null });
        } else {
          this.notify('群成员发生变化');
        }
        break;
      case GROUP_EVENT.MEMBER_JOINED:
      case GROUP_EVENT.MEMBER_LEFT:
        this.notify(event.kind === GROUP_EVENT.MEMBER_JOINED ? '有新成员加入群聊' : '有成员退出群聊');
        break;
      case GROUP_EVENT.UPDATED:
        this.notify('群资料已更新');
        break;
      case GROUP_EVENT.OWNER_TRANSFERRED:
        this.notify('群主已变更');
        break;
      default:
        break;
    }
    // Refresh groups and conversations so names/members match the server.
    void this.refreshGroups();
    void this.refreshConversations();
  }

  /** Reloads friends, pending requests and the blacklist together. */
  private async refreshRelations(): Promise<void> {
    const [friends, requests, blacklist] = await Promise.allSettled([
      this.rest.friends(),
      this.rest.friendRequests('in'),
      this.rest.blacklist(),
    ]);
    const patch: Partial<ImState> = {};
    if (friends.status === 'fulfilled') patch.friends = friends.value;
    if (requests.status === 'fulfilled') patch.friendRequests = requests.value as FriendRequestItem[];
    if (blacklist.status === 'fulfilled') patch.blacklist = blacklist.value as UserProfile[];
    this.set(patch);

    const incoming = (patch.friendRequests ?? this.state.friendRequests)
      .map((item) => String(item.from_id))
      .filter(Boolean);
    if (incoming.length > 0) {
      try {
        const profiles = await this.rest.users(incoming);
        this.set({
          requestProfiles: Object.fromEntries(profiles.map((profile) => [String(profile.uid), profile])),
        });
      } catch {
        // names fall back to the uid
      }
    }
  }

  searchUsers(keyword: string): Promise<UserProfile[]> {
    return this.rest.searchUsers(keyword);
  }

  async addFriend(uid: string, why = ''): Promise<void> {
    try {
      if (!(await this.friendViaWs(OP.ADD_FRIEND, encodeAddFriendReq({ friendId: uid, why })))) {
        await this.rest.addFriend(uid, why);
      }
      await this.refreshRelations();
      this.notify('好友申请已发送');
    } catch (err) {
      this.notify(`添加好友失败：${wrapError(err).display}`, 'error');
      throw err;
    }
  }

  async answerFriend(uid: string, accept: boolean): Promise<void> {
    try {
      if (!(await this.friendViaWs(OP.ANSWER_FRIEND, encodeAnswerFriendReq({ friendId: uid, accept })))) {
        await this.rest.answerFriend(uid, accept);
      }
      await this.refreshRelations();
      this.notify(accept ? '已添加好友' : '已拒绝');
    } catch (err) {
      this.notify(`处理申请失败：${wrapError(err).display}`, 'error');
      throw err;
    }
  }

  async deleteFriend(uid: string): Promise<void> {
    try {
      if (!(await this.friendViaWs(OP.DELETE_FRIEND, encodeDeleteFriendReq({ friendId: uid })))) {
        await this.rest.deleteFriend(uid);
      }
      await this.refreshRelations();
      await this.refreshConversations();
      this.notify('好友已删除');
    } catch (err) {
      this.notify(`删除好友失败：${wrapError(err).display}`, 'error');
      throw err;
    }
  }

  async setFriendRemark(uid: string, remark: string): Promise<void> {
    try {
      await this.rest.updateRemark(uid, remark);
      await this.refreshRelations();
      this.notify('备注已保存');
    } catch (err) {
      this.notify(`保存备注失败：${wrapError(err).display}`, 'error');
      throw err;
    }
  }

  async pinFriend(uid: string, pinned: boolean): Promise<void> {
    try {
      await this.rest.pinFriend(uid, pinned);
      await this.refreshRelations();
      this.notify(pinned ? '已置顶' : '已取消置顶');
    } catch (err) {
      this.notify(`操作失败：${wrapError(err).display}`, 'error');
      throw err;
    }
  }

  async blockUser(uid: string): Promise<void> {
    try {
      if (!(await this.friendViaWs(OP.ADD_BLACK, encodeAddBlackReq({ uid })))) {
        await this.rest.addBlack(uid);
      }
      await this.refreshRelations();
      this.notify('已加入黑名单');
    } catch (err) {
      this.notify(`拉黑失败：${wrapError(err).display}`, 'error');
      throw err;
    }
  }

  async unblockUser(uid: string): Promise<void> {
    try {
      if (!(await this.friendViaWs(OP.ADD_BLACK, encodeAddBlackReq({ uid, remove: true })))) {
        await this.rest.removeBlack(uid);
      }
      await this.refreshRelations();
      this.notify('已移出黑名单');
    } catch (err) {
      this.notify(`操作失败：${wrapError(err).display}`, 'error');
      throw err;
    }
  }

  // ------------------------------------------------------------- group ops --

  /** Runs a group action, then refreshes the group snapshots. */
  private async groupAction<T>(
    label: string,
    run: (client: IMClient) => Promise<T>,
  ): Promise<T> {
    if (!this.client) throw new ImError(0, '连接未就绪');
    try {
      const result = await run(this.client);
      await this.refreshGroups();
      return result;
    } catch (err) {
      this.notify(`${label}失败：${wrapError(err).display}`, 'error');
      throw err;
    }
  }

  private async refreshGroups(): Promise<void> {
    try {
      const groups = await this.rest.groups();
      const exact = new Map(
        this.state.groups.map((group) => [roundedKey(group.group_id), group.display_id ?? String(group.group_id)]),
      );
      this.set({
        groups: groups.map((group) => ({
          ...group,
          display_id: exact.get(roundedKey(group.group_id)) ?? String(group.group_id),
        })),
      });
      await this.refreshConversations();
    } catch {
      // A stale list is better than a failed action; the next refresh fixes it.
    }
  }

  /** Re-keys group conversations with the exact snowflake id (REST rounds them). */
  private rekeyGroupConversations(): void {
    const next = this.state.conversations.map((item) => {
      if (item.type !== 2 || !item.conversation_id.startsWith('g_')) return item;
      const exact = this.exactGroupId(item.conversation_id.slice(2));
      const exactCid = groupConversationId(exact);
      if (exactCid === item.conversation_id) return item;
      return { ...item, group_id: exact, conversation_id: exactCid };
    });
    const changed = next.some((item, index) => item.conversation_id !== this.state.conversations[index].conversation_id);
    if (!changed) return;
    const activeCid = this.state.activeCid
      ? next.find((item) => item.conversation_id === this.state.activeCid)?.conversation_id
        ?? this.rekeyCid(this.state.activeCid, next)
      : null;
    this.set({ conversations: next, activeCid });
  }

  /** Maps an old conversation id onto its re-keyed replacement. */
  private rekeyCid(cid: string, list: Conversation[]): string | null {
    if (!cid.startsWith('g_')) return this.state.activeCid;
    const exact = this.exactGroupId(cid.slice(2));
    const target = groupConversationId(exact);
    return list.some((item) => item.conversation_id === target) ? target : this.state.activeCid;
  }

  private async refreshConversations(): Promise<void> {
    try {
      const items = await this.rest.conversations();
      const selfUid = this.state.me?.uid ?? '';
      const fresh = items.map((item) => normalizeConversation(item, selfUid));
      // A group opened before its first message has no REST row yet: keep the
      // local conversation so the open chat does not collapse to empty.
      const activeLocal = this.state.activeCid
        ? this.state.conversations.find((item) => item.conversation_id === this.state.activeCid)
        : undefined;
      const keepLocal = activeLocal && !fresh.some((item) => item.conversation_id === activeLocal.conversation_id);
      this.set({ conversations: keepLocal ? [...fresh, activeLocal] : fresh });
      this.rekeyGroupConversations();
    } catch {
      // ignore
    }
  }

  async createGroup(name: string, memberIds: string[]): Promise<string> {
    const res = await this.groupAction('创建群', (client) =>
      client.request(GROUP_OP.CREATE, encodeCreateGroupReq({ name, memberIds, groupType: 1 }), decodeCreateGroupRes));
    const gid = res.payload.group_id;
    // Register the exact snowflake id before REST (which rounds int64 JSON) wins.
    this.set({
      groups: [
        {
          group_id: gid,
          display_id: gid,
          name: res.payload.name || name,
          member_count: memberIds.length + 1,
        },
        ...this.state.groups.filter((item) => roundedKey(item.group_id) !== roundedKey(gid)),
      ],
    });
    this.notify(`群「${res.payload.name || name}」已创建`);
    return gid;
  }

  async inviteGroupMembers(gid: string, userIds: string[]): Promise<void> {
    await this.groupAction('邀请成员', (client) =>
      client.request(GROUP_OP.INVITE, encodeInviteGroupMembersReq(gid, userIds), decodeGroupOperationRes));
    this.notify('邀请已发送');
  }

  async kickGroupMember(gid: string, uid: string): Promise<void> {
    await this.groupAction('移除成员', (client) =>
      client.request(GROUP_OP.KICK, encodeGroupUserReq(gid, uid), decodeGroupOperationRes));
    this.notify('成员已移除');
  }

  async quitGroup(gid: string): Promise<void> {
    await this.groupAction('退群', (client) =>
      client.request(GROUP_OP.QUIT, encodeGroupIdReq(gid), decodeGroupOperationRes));
    this.set({ activeCid: null });
    this.notify('已退出群');
  }

  async dismissGroup(gid: string): Promise<void> {
    await this.groupAction('解散群', (client) =>
      client.request(GROUP_OP.DISMISS, encodeGroupIdReq(gid), decodeGroupOperationRes));
    this.set({ activeCid: null });
    this.notify('群已解散');
  }

  async transferGroup(gid: string, newOwnerUid: string): Promise<void> {
    await this.groupAction('转让群主', (client) =>
      client.request(GROUP_OP.TRANSFER, encodeGroupUserReq(gid, newOwnerUid), decodeGroupOperationRes));
    this.notify('已转让群主');
  }

  async updateGroupInfo(
    gid: string,
    patch: { name?: string; notification?: string; needVerification?: number; lookMemberInfo?: number; applyMemberFriend?: number },
  ): Promise<void> {
    await this.groupAction('更新群资料', (client) =>
      client.request(GROUP_OP.UPDATE_INFO, encodeUpdateGroupReq({ groupId: gid, ...patch }), decodeUpdateGroupRes));
    if (patch.notification !== undefined) {
      this.set({ groupNotices: { ...this.state.groupNotices, [gid]: patch.notification } });
    }
    // Keep the local cache in sync so the chat banner updates immediately.
    this.set({
      groups: this.state.groups.map((group) => {
        const same = roundedKey(group.group_id) === roundedKey(gid);
        if (!same) return group;
        return {
          ...group,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.notification !== undefined ? { notification: patch.notification } : {}),
          ...(patch.needVerification !== undefined ? { need_verification: patch.needVerification } : {}),
          ...(patch.lookMemberInfo !== undefined ? { look_member_info: patch.lookMemberInfo } : {}),
          ...(patch.applyMemberFriend !== undefined ? { apply_member_friend: patch.applyMemberFriend } : {}),
        };
      }),
    });
    this.notify('群资料已更新');
  }

  async setGroupAdmin(gid: string, uid: string, admin: boolean): Promise<void> {
    await this.groupAction(admin ? '设置管理员' : '取消管理员', (client) =>
      client.request(GROUP_OP.SET_ADMIN, encodeSetGroupAdminReq({ groupId: gid, userId: uid, admin }), decodeGroupOperationRes));
    this.notify(admin ? '已设为管理员' : '已取消管理员');
  }

  async muteGroupMember(gid: string, uid: string, minutes: number): Promise<void> {
    const until = minutes > 0 ? Date.now() + minutes * 60_000 : 0;
    await this.groupAction(minutes > 0 ? '禁言' : '解除禁言', (client) =>
      client.request(GROUP_OP.MUTE_MEMBER, encodeMuteMemberReq({ groupId: gid, userId: uid, until }), decodeGroupOperationRes));
    this.notify(minutes > 0 ? `已禁言 ${minutes} 分钟` : '已解除禁言');
  }

  async muteAllGroup(gid: string, minutes: number): Promise<void> {
    const until = minutes > 0 ? Date.now() + minutes * 60_000 : 0;
    await this.groupAction(minutes > 0 ? '全员禁言' : '取消全员禁言', (client) =>
      client.request(GROUP_OP.MUTE_ALL, encodeMuteAllReq(gid, until), decodeGroupOperationRes));
    this.notify(minutes > 0 ? '已开启全员禁言' : '已取消全员禁言');
  }

  async setGroupNotify(gid: string, recvOpt: number): Promise<void> {
    await this.groupAction('设置消息提醒', (client) =>
      client.request(GROUP_OP.NOTIFY, encodeGroupNotifyReq(gid, recvOpt), decodeGroupOperationRes));
    this.notify(recvOpt === 0 ? '已开启消息提醒' : '已关闭消息提醒');
  }

  async searchGroups(keyword: string): Promise<GroupSummary[]> {
    if (!this.client) return [];
    const res = await this.client.request(GROUP_OP.SEARCH, encodeSearchGroupReq(keyword), decodeSearchGroupRes);
    return res.payload;
  }

  async applyJoinGroup(gid: string, why: string): Promise<void> {
    await this.groupAction('申请入群', (client) =>
      client.request(GROUP_OP.APPLY_JOIN, encodeApplyJoinReq(gid, why), decodeGroupOperationRes));
    this.notify('入群申请已提交');
  }

  async answerJoinGroup(gid: string, uid: string, accept: boolean): Promise<void> {
    await this.groupAction(accept ? '同意入群' : '拒绝入群', (client) =>
      client.request(GROUP_OP.ANSWER_JOIN, encodeAnswerJoinReq({ groupId: gid, userId: uid, accept }), decodeGroupOperationRes));
    this.notify(accept ? '已同意' : '已拒绝');
  }

  openFriend(friend: Friend): void {
    const selfUid = this.state.me?.uid ?? '';
    const cid = directConversationId(selfUid, String(friend.friend_id));
    if (!this.conversation(cid)) {
      this.set({
        conversations: [
          ...this.state.conversations,
          normalizeConversation(
            {
              conversation_id: cid,
              type: 1,
              peer_id: String(friend.friend_id),
              group_id: '0',
              recv_opt: 0,
              is_pinned: 0,
              unread: 0,
              read_seq: 0,
              max_seq: 0,
            },
            selfUid,
          ),
        ],
      });
    }
    void this.openConversation(cid);
  }

  /** Learns exact group ids from the wire protocol (REST rounds int64). */
  private async resolveGroupId(rounded: string): Promise<void> {
    try {
      const res = await this.client?.request(OP.MY_GROUPS, encodeMyGroupsReq(), decodeMyGroupsRes);
      const ids = res?.payload.group_ids ?? [];
      const exact = ids.find((id) => roundedKey(id) === roundedKey(rounded));
      if (!exact) return;
      this.set({
        groups: this.state.groups.map((item) => (
          roundedKey(item.group_id) === roundedKey(rounded)
            ? { ...item, display_id: exact }
            : item
        )),
      });
    } catch {
      // keep the rounded id; admin actions will report the server error
    }
  }

  openGroup(group: Group): void {
    const gid = this.exactGroupId(String(group.group_id));
    // A rounded id cannot pass server-side member checks: resolve it first, then
    // reopen so admin actions (settings, announcement) work.
    if (!group.display_id) {
      void this.resolveGroupId(String(group.group_id)).then(() => {
        const exact = this.exactGroupId(String(group.group_id));
        if (exact !== group.display_id) this.openGroup({ ...group, display_id: exact });
      });
    }
    const cid = groupConversationId(gid);
    // Keep the snapshot complete: a freshly created group may not be back from
    // REST yet, and the header title resolves through state.groups.
    if (!this.state.groups.some((item) => roundedKey(item.group_id) === roundedKey(gid))) {
      this.set({
        groups: [...this.state.groups, { ...group, group_id: gid, display_id: gid }],
      });
    }
    if (!this.conversation(cid)) {
      this.set({
        conversations: [
          ...this.state.conversations,
          normalizeConversation(
            {
              conversation_id: cid,
              type: 2,
              peer_id: '0',
              group_id: gid,
              recv_opt: 0,
              is_pinned: 0,
              unread: 0,
              read_seq: 0,
              max_seq: 0,
            },
            this.state.me?.uid ?? '',
          ),
        ],
      });
    }
    void this.openConversation(cid);
  }

  private patchThread(cid: string, patch: Partial<Thread>): void {
    const current = this.state.threads[cid] ?? emptyThread();
    const next: Thread = { ...current, ...patch };
    if (patch.items) next.items = dedupeMessages(patch.items);
    this.set({ threads: { ...this.state.threads, [cid]: next } });
  }

  /** Appends one message, de-duplicated against the *current* thread state.
   *
   * Pushes can arrive back-to-back while a history page is in flight; reading
   * state at append time (instead of a stale closure copy) keeps React keys
   * unique.
   */
  private appendToThread(cid: string, message: UiMessage): void {
    const current = this.state.threads[cid] ?? emptyThread();
    if (message.server_msg_id && current.items.some((item) => item.server_msg_id === message.server_msg_id)) {
      return;
    }
    this.patchThread(cid, { items: [...current.items, message] });
  }

  async loadOlderMessages(cid: string): Promise<void> {
    const conversation = this.conversation(cid);
    const thread = this.state.threads[cid];
    if (!conversation || !thread || thread.items.length === 0 || thread.loadingOlder) return;

    this.patchThread(cid, { loadingOlder: true });
    try {
      const { messages, hasMoreOlder } = await loadOlder(this.rest, conversation, thread.items[0].seq, 30);
      this.patchThread(cid, {
        items: [...messages, ...this.state.threads[cid].items],
        hasMoreOlder,
        loadingOlder: false,
      });
    } catch (err) {
      this.notify(wrapError(err).message, 'error');
      this.patchThread(cid, { loadingOlder: false });
    }
  }

  // ------------------------------------------------------------------ read --

  /** Marks a message for scroll-into-view and a short highlight flash. */
  focusMessage(messageId: string): void {
    if (!messageId) return;
    this.set({ focusMessageId: null });
    // A timer (not rAF) so the highlight also works in background tabs.
    window.setTimeout(() => this.set({ focusMessageId: messageId }), 0);
  }

  /** Opens the conversation holding a message and highlights that message. */
  async jumpToMessage(cid: string, messageId: string, keyword = ''): Promise<void> {
    if (!cid) return;
    const switching = this.state.activeCid !== cid;
    if (switching) this.set({ searchHighlight: '' });
    try {
      await this.openConversation(cid);
    } catch {
      // The conversation may fail to load; still mark the target message.
    }
    // Set the keyword after the switch so openConversation cannot clear it.
    this.set({ searchHighlight: keyword.trim() });
    this.focusMessage(messageId);
  }

  /** Local search: conversation titles plus the threads already in memory. */
  searchAll(keyword: string): {
    conversations: Conversation[];
    messages: { cid: string; item: UiMessage }[];
  } {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return { conversations: [], messages: [] };
    const conversations = this.state.conversations
      .filter((item) => this.conversationTitle(item).toLowerCase().includes(needle))
      .slice(0, 6);
    const messages: { cid: string; item: UiMessage }[] = [];
    for (const [cid, thread] of Object.entries(this.state.threads)) {
      for (const item of thread.items) {
        if (messages.length >= 30) break;
        const text = messageText(item.content, item.msg_type).text;
        if (text && text.toLowerCase().includes(needle)) messages.push({ cid, item });
      }
      if (messages.length >= 30) break;
    }
    return { conversations, messages };
  }

  /** Exports the loaded thread as a plain-text transcript download. */
  exportConversation(cid: string): void {
    const conversation = this.conversation(cid);
    const thread = this.state.threads[cid];
    if (!conversation || !thread || thread.items.length === 0) {
      this.notify('当前会话没有可导出的消息', 'error');
      return;
    }
    const lines = thread.items.map((item) => {
      const at = new Date(Number(item.send_time)).toLocaleString();
      const who = String(item.send_id) === String(this.state.me?.uid ?? '')
        ? this.senderName(item.send_id)
        : this.senderName(item.send_id);
      const body = messagePreview(item.content, item.msg_type);
      return `[${at}] ${who}: ${body}`;
    });
    const header = `# ${this.conversationTitle(conversation)} (${cid})\n`;
    const blob = new Blob([header + lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `zim-${cid}-${Date.now()}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    this.notify(`已导出 ${thread.items.length} 条消息`);
  }

  /** Remembers a search keyword (max 8, newest first, persisted). */
  rememberSearch(keyword: string): void {
    const value = keyword.trim();
    if (!value) return;
    const next = [value, ...this.state.searchHistory.filter((item) => item !== value)].slice(0, 8);
    this.set({ searchHistory: next });
    try {
      localStorage.setItem('zim.searchHistory', JSON.stringify(next));
    } catch {
      // private mode: keep it in memory only
    }
  }

  /** Loads the persisted search history once at startup. */
  private loadSearchHistory(): void {
    try {
      const raw = localStorage.getItem('zim.searchHistory');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.set({ searchHistory: parsed.filter((item) => typeof item === 'string').slice(0, 8) });
      }
    } catch {
      // corrupt entry: ignore
    }
  }

  /** Stores one conversation's unsent draft (empty clears it). */
  setDraft(cid: string, text: string): void {
    if (!cid) return;
    const current = this.state.drafts[cid] ?? '';
    if (current === text) return;
    const next = { ...this.state.drafts };
    if (text.trim() === '') delete next[cid];
    else next[cid] = text;
    this.set({ drafts: next });
    this.scheduleDraftFlush();
  }

  /** Draft text for a conversation ('' when none). */
  draftOf(cid: string | null): string {
    return cid ? this.state.drafts[cid] ?? '' : '';
  }

  private draftFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleDraftFlush(): void {
    if (this.draftFlushTimer) return;
    this.draftFlushTimer = setTimeout(() => {
      this.draftFlushTimer = null;
      try {
        localStorage.setItem('zim.drafts', JSON.stringify(this.state.drafts));
      } catch {
        // private mode: keep drafts in memory only
      }
    }, 400);
  }

  private loadDrafts(): void {
    try {
      const raw = localStorage.getItem('zim.drafts');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string' && value.trim() !== '') next[key] = value;
        }
        this.set({ drafts: next });
      }
    } catch {
      // corrupt entry: ignore
    }
  }

  /** Updates the signed-in user's nickname / avatar. */
  async updateProfile(patch: { nickname?: string; avatar?: string }): Promise<void> {
    const nickname = patch.nickname?.trim();
    const avatar = patch.avatar?.trim();
    if (nickname !== undefined && !nickname) {
      this.notify('昵称不能为空', 'error');
      return;
    }
    try {
      const profile = await this.rest.updateMe({ nickname, avatar });
      this.set({
        me: {
          uid: profile.uid,
          name: profile.nickname || nickname || this.state.me?.name || profile.uid,
          avatar: profile.avatar ?? avatar ?? this.state.me?.avatar ?? '',
        },
      });
      this.notify('资料已更新');
    } catch (err) {
      this.notify(`更新失败：${wrapError(err).display}`, 'error');
    }
  }

  /** Pins/unpins a conversation (server sorts pinned chats first). */
  async pinConversation(cid: string, pinned: boolean): Promise<void> {
    try {
      await this.rest.pinConversation(cid, pinned);
      await this.refreshConversations();
      this.notify(pinned ? '已置顶会话' : '已取消置顶');
    } catch (err) {
      this.notify(`置顶失败：${wrapError(err).display}`, 'error');
    }
  }

  /** Removes a conversation from this account's list (history stays on the server). */
  async deleteConversation(cid: string): Promise<void> {
    try {
      await this.rest.deleteConversation(cid);
      const threads = { ...this.state.threads };
      delete threads[cid];
      this.set({
        conversations: this.state.conversations.filter((item) => item.conversation_id !== cid),
        threads,
        activeCid: this.state.activeCid === cid ? null : this.state.activeCid,
      });
      this.notify('会话已删除');
    } catch (err) {
      this.notify(`删除失败：${wrapError(err).display}`, 'error');
    }
  }

  async markRead(cid: string): Promise<void> {
    const conversation = this.conversation(cid);
    const thread = this.state.threads[cid];
    if (!conversation || !thread || thread.items.length === 0) return;

    const latest = thread.items.reduce((max, item) => Math.max(max, Number(item.seq)), 0);
    if (latest <= Number(conversation.read_seq ?? 0)) {
      if (Number(conversation.unread ?? 0) > 0) this.patchConversation(cid, { unread: 0 });
      return;
    }

    try {
      let readSeq = latest;
      if (this.client && this.client.state === 'open') {
        const res = await this.client.request(
          OP.READ_RECEIPT,
          encodeReadReceiptReq({ conversationId: cid, seq: latest }),
          decodeReadReceiptRes,
        );
        readSeq = Number(res.payload.read_seq || latest);
      } else {
        readSeq = await this.rest.markRead(cid, latest);
      }
      this.patchConversation(cid, { read_seq: readSeq, unread: 0 });
    } catch (err) {
      this.notify(wrapError(err).message, 'error');
    }
  }

  private patchConversation(cid: string, patch: Partial<Conversation>): void {
    this.set({
      conversations: this.state.conversations.map((item) =>
        item.conversation_id === cid ? { ...item, ...patch } : item,
      ),
    });
  }

  // ------------------------------------------------------------------ send --

  /** Sends a text message (msg_type 1). */
  async sendMessage(text: string, atUids: string[] = []): Promise<void> {
    const content = text.trim();
    if (!content) return;
    // Sending ends the "typing" state for the peer immediately.
    this.stopTyping();
    // A pending quote target turns the next text into a 1504 reply.
    if (this.state.quoteTarget) {
      await this.sendQuote(content);
      return;
    }
    const clean = atUids.filter(Boolean);
    await this.sendContent(
      1,
      JSON.stringify(clean.length > 0 ? { text: content, at: clean } : { text: content }),
      clean,
    );
  }

  /** Uploads an image then sends it as msg_type 2. */
  /** Uploads one attachment and sends it as msg_type 3/4/5. */
  async sendAttachment(file: File): Promise<void> {
    const conversation = this.conversation(this.state.activeCid);
    if (!conversation || !this.client) return;
    const mime = file.type || 'application/octet-stream';
    const kind: 'image' | 'voice' | 'video' | 'file' = mime.startsWith('image/')
      ? 'image'
      : mime.startsWith('audio/')
        ? 'voice'
        : mime.startsWith('video/')
          ? 'video'
          : 'file';
    const caps = { image: 5, voice: 10, video: 50, file: 20 } as const;
    if (file.size > caps[kind] * 1024 * 1024) {
      this.notify(`附件不能超过 ${caps[kind]} MB`, 'error');
      return;
    }

    if (kind === 'image') {
      await this.sendImage(file);
      return;
    }
    const msgType = kind === 'voice' ? 3 : kind === 'video' ? 4 : 5;
    const started = this.appendDraft(
      msgType,
      JSON.stringify({ uploading: true, name: file.name, size: file.size }),
      { progress: 0 },
    );
    if (!started) return;
    const { draft } = started;
    const cid = started.conversation.conversation_id;
    this.trackUpload(draft.client_msg_id, file, msgType);
    try {
      const duration = await measureMedia(file, kind === 'voice' ? 'audio' : 'video');
      const poster = kind === 'video' ? await captureVideoPoster(file) : null;
      const uploaded = await this.rest.uploadFile({
        blob: file,
        name: file.name || 'attachment',
        mime,
        kind,
        onProgress: (percent) => this.updateMessage(cid, draft.client_msg_id, { progress: percent }),
      });
      const content = JSON.stringify(kind === 'voice' || kind === 'video'
        ? {
          url: uploaded.url,
          duration_ms: poster?.duration || duration,
          size: uploaded.size,
          mime,
          name: file.name,
          ...(poster?.poster ? { poster: poster.poster } : {}),
        }
        : { url: uploaded.url, name: file.name, size: uploaded.size, mime });
      this.updateMessage(cid, draft.client_msg_id, { content, progress: undefined });
      await this.deliver({ ...draft, content }, started.conversation);
      this.notify(kind === 'voice' ? '语音已发送' : kind === 'video' ? '视频已发送' : '文件已发送');
    } catch (err) {
      this.updateMessage(cid, draft.client_msg_id, { localState: 'failed', progress: undefined });
      this.notify(`附件发送失败：${wrapError(err).display}`, 'error');
    }
  }

  async sendImage(file: File): Promise<void> {
    const conversation = this.conversation(this.state.activeCid);
    if (!conversation || !this.client) return;
    if (!file.type.startsWith('image/')) {
      this.notify('只支持图片', 'error');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      this.notify('图片不能超过 5 MB', 'error');
      return;
    }

    // Large photos are downscaled first: faster uploads and smaller history.
    const compressed = await compressImage(file);
    const payload = compressed.file;

    const started = this.appendDraft(
      2,
      JSON.stringify({ uploading: true, name: payload.name, size: payload.size }),
      { progress: 0 },
    );
    if (!started) return;
    const { draft } = started;
    const cid = started.conversation.conversation_id;
    this.trackUpload(draft.client_msg_id, payload, 2);
    try {
      const dimensions = await measureImage(payload);
      const uploaded = await this.rest.uploadFile({
        blob: payload,
        name: payload.name || 'image.png',
        mime: payload.type || 'image/png',
        onProgress: (percent) => this.updateMessage(cid, draft.client_msg_id, { progress: percent }),
      });
      const content = JSON.stringify({
        url: uploaded.url,
        width: dimensions.width,
        height: dimensions.height,
        size: uploaded.size,
        name: payload.name,
      });
      this.updateMessage(cid, draft.client_msg_id, { content, progress: undefined });
      await this.deliver({ ...draft, content }, started.conversation);
    } catch (err) {
      this.updateMessage(cid, draft.client_msg_id, { localState: 'failed', progress: undefined });
      this.notify(wrapError(err).display, 'error');
    }
  }

  /** Shared send path: optimistic draft, 1501/1502, then server truth. */
  /** Appends an optimistic draft bubble and returns it with its conversation. */
  private appendDraft(
    msgType: number,
    content: string,
    extra: Partial<UiMessage> = {},
  ): { draft: UiMessage; conversation: Conversation } | null {
    const cid = this.state.activeCid;
    const conversation = this.conversation(cid);
    if (!conversation || !this.client) return null;
    const draft: UiMessage = {
      server_msg_id: '',
      client_msg_id: randomId(),
      conversation_id: conversation.conversation_id,
      seq: '0',
      send_id: this.state.me?.uid ?? '',
      recv_id: conversation.type === 1 ? conversation.peer_id : '0',
      group_id: conversation.type === 2 ? conversation.group_id : '0',
      msg_type: msgType,
      content,
      at_user_ids: [],
      send_time: String(Date.now()),
      status: 0,
      localState: 'sending',
      ...extra,
    };
    const thread = this.state.threads[conversation.conversation_id] ?? emptyThread();
    this.patchThread(conversation.conversation_id, { items: [...thread.items, draft] });
    return { draft, conversation };
  }

  /** Shared send path: optimistic draft, 1501/1502, then server truth. */
  private async sendContent(msgType: number, content: string, atUserIds: string[] = []): Promise<void> {
    const started = this.appendDraft(msgType, content, atUserIds.length > 0 ? { at_user_ids: atUserIds } : {});
    if (!started) return;
    await this.deliver(started.draft, started.conversation);
  }

  /** Keeps a failed upload's file so the bubble can offer a retry. */
  private trackUpload(clientMsgId: string, file: File, msgType: number): void {
    this.uploadJobs.set(clientMsgId, { file, msgType, guard: null });
    this.set({ uploadRetries: [...this.state.uploadRetries, clientMsgId] });
    this.armUploadGuard(clientMsgId);
  }

  /** An upload that stalls (no error, no completion) must not stay "上传中"
   * forever: fail it after the guard window so the retry button appears. */
  private armUploadGuard(clientMsgId: string): void {
    const job = this.uploadJobs.get(clientMsgId);
    if (!job) return;
    if (job.guard) window.clearTimeout(job.guard);
    job.guard = window.setTimeout(() => {
      const current = this.uploadJobs.get(clientMsgId);
      if (!current) return;
      current.guard = null;
      this.markUploadFailed(clientMsgId);
      this.notify('上传超时，可点击重试', 'error');
    }, 90_000);
  }

  /** Marks the draft message of a stalled upload as failed (keeps the retry). */
  private markUploadFailed(clientMsgId: string): void {
    for (const [cid, thread] of Object.entries(this.state.threads)) {
      if (!thread.items.some((item) => item.client_msg_id === clientMsgId)) continue;
      this.updateMessage(cid, clientMsgId, { localState: 'failed', progress: undefined });
      return;
    }
  }

  private clearUpload(clientMsgId: string): void {
    const job = this.uploadJobs.get(clientMsgId);
    if (job?.guard) window.clearTimeout(job.guard);
    this.uploadJobs.delete(clientMsgId);
    if (this.state.uploadRetries.includes(clientMsgId)) {
      this.set({ uploadRetries: this.state.uploadRetries.filter((id) => id !== clientMsgId) });
    }
  }

  /** Re-uploads a failed attachment draft and sends it when the bytes land. */
  async retryUpload(clientMsgId: string): Promise<void> {
    const job = this.uploadJobs.get(clientMsgId);
    const conversation = this.conversation(this.state.activeCid);
    const draft = conversation
      ? this.state.threads[conversation.conversation_id]?.items.find((item) => item.client_msg_id === clientMsgId)
      : undefined;
    if (!job || !conversation || !draft) {
      this.notify('无法重试上传，请重新选择文件', 'error');
      return;
    }
    const cid = conversation.conversation_id;
    const progress = (percent: number) => this.updateMessage(cid, clientMsgId, { progress: percent });
    this.updateMessage(cid, clientMsgId, { localState: 'sending', progress: 0 });
    // Re-arm the stall guard for the retry attempt.
    this.armUploadGuard(clientMsgId);
    try {
      if (job.msgType === 2) {
        const dimensions = await measureImage(job.file);
        const uploaded = await this.rest.uploadFile({
          blob: job.file,
          name: job.file.name || 'image.png',
          mime: job.file.type || 'image/png',
          onProgress: progress,
        });
        const content = JSON.stringify({
          url: uploaded.url,
          width: dimensions.width,
          height: dimensions.height,
          size: uploaded.size,
          name: job.file.name,
        });
        this.updateMessage(cid, clientMsgId, { content, progress: undefined });
        this.clearUpload(clientMsgId);
        await this.deliver({ ...draft, content }, conversation);
        return;
      }
      const mime = job.file.type || 'application/octet-stream';
      const kind: 'voice' | 'video' | 'file' = mime.startsWith('audio/')
        ? 'voice'
        : mime.startsWith('video/') ? 'video' : 'file';
      const duration = await measureMedia(job.file, kind === 'voice' ? 'audio' : 'video');
      const uploaded = await this.rest.uploadFile({
        blob: job.file,
        name: job.file.name || 'attachment',
        mime,
        kind,
        onProgress: progress,
      });
      const content = JSON.stringify(kind === 'voice' || kind === 'video'
        ? { url: uploaded.url, duration_ms: duration, size: uploaded.size, mime, name: job.file.name }
        : { url: uploaded.url, name: job.file.name, size: uploaded.size, mime });
      this.updateMessage(cid, clientMsgId, { content, progress: undefined });
      this.clearUpload(clientMsgId);
      await this.deliver({ ...draft, content }, conversation);
    } catch (err) {
      this.updateMessage(cid, clientMsgId, { localState: 'failed', progress: undefined });
      this.notify(`上传重试失败：${wrapError(err).display}`, 'error');
    }
  }

  async retryMessage(message: UiMessage): Promise<void> {
    const conversation = this.conversation(message.conversation_id);
    if (!conversation) return;
    await this.deliver({ ...message, localState: 'sending' }, conversation);
  }

  // ------------------------------------------------------------- quote/forward --

  /** Marks a message as the quote target for the next send. */
  setQuoteTarget(message: UiMessage | null): void {
    this.set({ quoteTarget: message });
  }

  /** 1517: tells the other side that this user is typing (throttled to 2s). */
  notifyTyping(): void {
    const cid = this.state.activeCid;
    if (!cid || !this.client || this.state.connection !== 'open') return;
    const now = Date.now();
    if (!this.lastTypingSentAt || now - this.lastTypingSentAt >= 2000) {
      this.lastTypingSentAt = now;
      this.sendTyping(cid, true);
    }
    // 3s without a keystroke means "stopped typing".
    if (this.typingStopTimer !== null) window.clearTimeout(this.typingStopTimer);
    this.typingStopTimer = window.setTimeout(() => this.stopTyping(), 3000);
  }

  /** Sends typing=false for the current conversation and resets the throttle. */
  stopTyping(): void {
    if (this.typingStopTimer !== null) {
      window.clearTimeout(this.typingStopTimer);
      this.typingStopTimer = null;
    }
    const cid = this.state.activeCid;
    this.lastTypingSentAt = 0;
    if (cid) this.sendTyping(cid, false);
  }

  /** Fire-and-forget 1517 for one conversation. */
  private sendTyping(cid: string, typing: boolean): void {
    if (!this.client || this.state.connection !== 'open') return;
    void this.client
      .request(OP.TYPING, encodeTypingReq({ conversationId: cid, typing }), decodeOperationRes)
      .catch(() => undefined);
  }

  /** Online flag for a uid (undefined until the first presence answer). */
  presenceOf(uid: string | number): boolean | undefined {
    return this.state.presence[String(uid)];
  }

  /**
   * Refreshes presence for the given uids (default: friends + direct peers).
   * The API returns at most 200 uids per call, so the list is capped.
   */
  async refreshPresence(uids?: string[], force = true): Promise<void> {
    if (this.state.status !== 'ready') return;
    // Polling passes force=false so a hidden tab stays quiet; explicit calls
    // (tab visible again, tests, dialogs) always refresh.
    if (!force && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const targets = uids ?? this.presenceTargets();
    const unique = Array.from(new Set(targets.filter(Boolean))).slice(0, 200);
    if (unique.length === 0) return;
    try {
      const online = await this.rest.presence(unique);
      this.set({ presence: { ...this.state.presence, ...online } });
    } catch {
      // offline/transient: the next poll retries
    }
  }

  /**
   * 1106: subscribes to the online state of the visible users. The server
   * answers with a snapshot and then pushes 1903 changes; the subscription
   * expires after 2 minutes, so it is refreshed while the tab is visible.
   * Falls back to the HTTP endpoint when the subscription fails.
   */
  async subscribePresence(): Promise<void> {
    if (this.state.status !== 'ready' || !this.client || this.state.connection !== 'open') return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.stopPresence();
      return;
    }
    const uids = Array.from(new Set(this.presenceTargets().filter(Boolean))).slice(0, 200);
    if (uids.length === 0) return;
    try {
      const res = await this.client.request(
        OP.SUBSCRIBE_ONLINE,
        encodeSubscribeOnlineReq(uids),
        decodeSubscribeOnlineRes,
      );
      this.set({ presence: { ...this.state.presence, ...res.payload } });
    } catch {
      // WS subscription unavailable (old node, transient error): HTTP fallback.
      await this.refreshPresence(uids, true);
    }
    this.armPresenceRefresh();
  }

  /** Re-subscribes before the 2 minute server-side subscription expires. */
  private armPresenceRefresh(): void {
    if (this.presenceTimer !== null) window.clearTimeout(this.presenceTimer);
    this.presenceTimer = window.setTimeout(() => void this.subscribePresence(), 90_000);
  }

  /** Drops the subscription refresh loop (tab hidden or logged out). */
  private stopPresence(): void {
    if (this.presenceTimer !== null) {
      window.clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
  }

  /** Adds uids a view cares about (group members) to the presence poll. */
  watchPresence(uids: string[]): void {
    let added = false;
    for (const uid of uids) {
      if (!uid || this.presenceWatched.has(uid)) continue;
      this.presenceWatched.add(uid);
      added = true;
    }
    if (added) void this.subscribePresence();
  }

  /** uids shown with a green dot: friends, direct peers and watched members. */
  private presenceTargets(): string[] {
    const uids = new Set<string>(this.presenceWatched);
    for (const friend of this.state.friends) uids.add(String(friend.friend_id));
    for (const conversation of this.state.conversations) {
      if (conversation.type === 1 && conversation.peer_id && conversation.peer_id !== '0') {
        uids.add(String(conversation.peer_id));
      }
    }
    return [...uids];
  }

  /** 1504: sends a reply that quotes the target message. */
  async sendQuote(text: string): Promise<void> {
    const target = this.state.quoteTarget;
    const conversation = this.conversation(this.state.activeCid);
    if (!target || !target.server_msg_id || !conversation || !this.client) return;
    const clientMsgId = randomId();
    const preview = messageText(target.content, target.msg_type).text.slice(0, 120);
    // Quote replies mention the original author so they get the "@me" badge.
    const selfUid = String(this.state.me?.uid ?? '');
    const author = String(target.send_id);
    const authorName = this.senderName(author);
    const mention = author && author !== selfUid && !text.includes(`@${authorName}`)
      ? `@${authorName} `
      : '';
    const replyText = `${mention}${text}`;
    const content = JSON.stringify({
      text: replyText,
      quote: { server_msg_id: target.server_msg_id, send_id: target.send_id, msg_type: target.msg_type, text: preview },
    });
    const draft: UiMessage = {
      server_msg_id: '',
      client_msg_id: clientMsgId,
      conversation_id: conversation.conversation_id,
      seq: '0',
      send_id: this.state.me?.uid ?? '',
      recv_id: conversation.type === 1 ? conversation.peer_id : '0',
      group_id: conversation.type === 2 ? conversation.group_id : '0',
      msg_type: 1,
      content,
      at_user_ids: [],
      send_time: String(Date.now()),
      status: 0,
      localState: 'sending',
    };
    const thread = this.state.threads[conversation.conversation_id] ?? emptyThread();
    this.patchThread(conversation.conversation_id, { items: [...thread.items, draft] });
    this.set({ quoteTarget: null });

    try {
      const res = await this.client.request(
        OP.QUOTE,
        encodeQuoteReq({
          clientMsgId,
          recvId: conversation.type === 1 ? conversation.peer_id : undefined,
          groupId: conversation.type === 2 ? conversation.group_id : undefined,
          serverMsgId: target.server_msg_id,
          content: JSON.stringify({ text: replyText }),
        }),
        decodeQuoteRes,
      );
      this.updateMessage(conversation.conversation_id, clientMsgId, {
        server_msg_id: res.payload.server_msg_id,
        seq: res.payload.seq,
        send_time: res.payload.send_time,
        localState: 'sent',
      });
    } catch (err) {
      this.updateMessage(conversation.conversation_id, clientMsgId, { localState: 'failed' });
      this.notify(`引用回复失败：${wrapError(err).display}`, 'error');
    }
  }

  /** Splits a conversation id into exact send targets (REST group ids lose precision). */
  private targetOf(cid: string): { groupId?: string; recvId?: string } | null {
    const [kind, first, second] = cid.split('_');
    const selfUid = String(this.state.me?.uid ?? '');
    if (kind === 'g' && first) return { groupId: first };
    if (kind === 's' && first && second) {
      return { recvId: first === selfUid ? second : first };
    }
    return null;
  }

  /** 1503: forwards several messages as one chat-record card. */
  async mergeForward(serverMsgIds: string[], targetCids: string | string[]): Promise<void> {
    if (!this.client || serverMsgIds.length === 0) return;
    const targets = (Array.isArray(targetCids) ? targetCids : [targetCids]).filter(Boolean);
    if (targets.length === 0) {
      this.notify('转发目标无效', 'error');
      return;
    }
    let sent = 0;
    for (const cid of targets) {
      const target = this.targetOf(cid);
      if (!target) continue;
      try {
        await this.client.request(
          OP.MERGE,
          encodeMergeReq({
            clientMsgId: randomId(),
            recvId: target.recvId,
            groupId: target.groupId,
            serverMsgIds,
            title: '聊天记录',
          }),
          decodeMergeRes,
        );
        sent += 1;
      } catch (err) {
        this.notify(`合并转发失败：${wrapError(err).display}`, 'error');
      }
    }
    if (sent === 0) return;
    await this.refreshConversations();
    this.notify(`已合并转发 ${serverMsgIds.length} 条消息${sent > 1 ? ` 到 ${sent} 个会话` : ''}`);
  }

  /** Forwards one message into other conversations (text or attachment). */
  async forwardMessage(message: UiMessage, targetCids: string | string[]): Promise<void> {
    if (!this.client) return;
    if (!message.server_msg_id) {
      this.notify('消息尚未发送完成，无法转发', 'error');
      return;
    }
    const targets = (Array.isArray(targetCids) ? targetCids : [targetCids]).filter(Boolean);
    if (targets.length === 0) return;
    let sent = 0;
    for (const cid of targets) {
      const target = this.targetOf(cid);
      if (!target) continue;
      try {
        const payload = target.groupId
          ? encodeSendGroupReq({
            clientMsgId: randomId(),
            groupId: target.groupId,
            msgType: message.msg_type,
            content: message.content,
          })
          : encodeSendSingleReq({
            clientMsgId: randomId(),
            recvId: target.recvId as string,
            msgType: message.msg_type,
            content: message.content,
          });
        await this.client.request(target.groupId ? OP.SEND_GROUP : OP.SEND_SINGLE, payload, decodeSendRes);
        sent += 1;
      } catch (err) {
        this.notify(`转发失败：${wrapError(err).display}`, 'error');
      }
    }
    if (sent === 0) return;
    await this.refreshConversations();
    this.notify(sent > 1 ? `已转发到 ${sent} 个会话` : '已转发');
  }

  private async deliver(draft: UiMessage, conversation: Conversation): Promise<void> {
    const cid = conversation.conversation_id;
    this.updateMessage(cid, draft.client_msg_id, { localState: 'sending' });

    try {
      const payload = conversation.type === 2
        ? encodeSendGroupReq({
          clientMsgId: draft.client_msg_id,
          groupId: conversation.group_id,
          msgType: draft.msg_type,
          content: draft.content,
        })
        : encodeSendSingleReq({
          clientMsgId: draft.client_msg_id,
          recvId: conversation.peer_id,
          msgType: draft.msg_type,
          content: draft.content,
        });

      const opcode = conversation.type === 2 ? OP.SEND_GROUP : OP.SEND_SINGLE;
      const res = await this.client!.request(opcode, payload, decodeSendRes);
      const sent = res.payload;

      this.updateMessage(cid, draft.client_msg_id, {
        server_msg_id: sent.server_msg_id,
        seq: sent.seq,
        send_time: sent.send_time,
        localState: 'sent',
      });
      this.patchConversation(cid, {
        last_msg_seq: Number(sent.seq),
        last_msg_at: Number(sent.send_time),
        last_msg_brief: draft.content,
        read_seq: Number(sent.seq),
        unread: 0,
        max_seq: Math.max(Number(conversation.max_seq ?? 0), Number(sent.seq)),
      });
    } catch (err) {
      this.updateMessage(cid, draft.client_msg_id, { localState: 'failed' });
      this.notify(wrapError(err).display, 'error');
    }
  }

  private updateMessage(cid: string, clientMsgId: string, patch: Partial<UiMessage>): void {
    const thread = this.state.threads[cid];
    if (!thread) return;
    this.patchThread(cid, {
      items: thread.items.map((item) =>
        item.client_msg_id === clientMsgId ? { ...item, ...patch } : item,
      ),
    });
  }

  // -------------------------------------------------------- message ops ----

  /** Resolves the conversation that owns a message.
   *
   * Pushed items may carry an empty conversation_id (the 1901 event is keyed by
   * conversation but the client stores what arrived), so fall back to the thread
   * that already holds the message.
   */
  private conversationOf(message: UiMessage): Conversation | undefined {
    const own = message.conversation_id || this.state.activeCid || '';
    if (own) {
      const direct = this.conversation(own);
      if (direct) return direct;
      // The thread is open but the list has not caught up yet: a minimal shell
      // is enough for send-like ops that only need conversation_id.
      if (this.state.threads[own]) return { conversation_id: own, type: own.startsWith('g_') ? 2 : 1 } as Conversation;
    }
    for (const [cid, thread] of Object.entries(this.state.threads)) {
      if (thread.items.some((item) => item.server_msg_id && item.server_msg_id === message.server_msg_id)) {
        return this.conversation(cid) ?? ({ conversation_id: cid, type: cid.startsWith('g_') ? 2 : 1 } as Conversation);
      }
    }
    return undefined;
  }

  /** 1506: recall one of my messages (server enforces the window). */
  async recallMessage(message: UiMessage): Promise<void> {
    const conversation = this.conversationOf(message);
    if (!conversation || !this.client) return;
    try {
      await this.client.request(OP.RECALL, encodeRecallReq({
        conversationId: conversation.conversation_id,
        serverMsgId: message.server_msg_id,
      }), decodeOperationRes);
      this.updateMessage(conversation.conversation_id, message.client_msg_id, { status: 1 });
      this.notify('已撤回');
    } catch (err) {
      this.notify(`撤回失败：${wrapError(err).display}`, 'error');
    }
  }

  /** 1507: edit my own message; content is the JSON text payload. */
  async editMessage(message: UiMessage, content: string): Promise<void> {
    const conversation = this.conversationOf(message);
    if (!conversation || !this.client) return;
    try {
      await this.client.request(OP.EDIT, encodeEditMessageReq({
        conversationId: conversation.conversation_id,
        serverMsgId: message.server_msg_id,
        content,
      }), decodeOperationRes);
      this.updateMessage(conversation.conversation_id, message.client_msg_id, { content });
      this.notify('已保存');
    } catch (err) {
      this.notify(`编辑失败：${wrapError(err).display}`, 'error');
    }
  }

  /** 1508: delete my own message for both sides. */
  async deleteMessage(message: UiMessage): Promise<void> {
    const conversation = this.conversationOf(message);
    if (!conversation || !this.client) return;
    try {
      await this.client.request(OP.DELETE, encodeDeleteMessageReq({
        conversationId: conversation.conversation_id,
        serverMsgId: message.server_msg_id,
      }), decodeOperationRes);
      this.updateMessage(conversation.conversation_id, message.client_msg_id, { status: 2 });
      this.notify('已删除');
    } catch (err) {
      this.notify(`删除失败：${wrapError(err).display}`, 'error');
    }
  }

  /** 1515/1516: toggle one emoji reaction on my side (optimistic). */
  async toggleReaction(message: UiMessage, emoji: string): Promise<void> {
    const conversation = this.conversationOf(message);
    if (!conversation || !this.client || !message.server_msg_id) return;
    const existing = (message.reactions ?? []).find((item) => item.emoji === emoji);
    const mine = existing?.mine ?? false;
    this.applyReaction(conversation.conversation_id, message.server_msg_id, emoji, !mine);
    try {
      await this.client.request(
        mine ? OP.REMOVE_REACTION : OP.ADD_REACTION,
        encodeReactionReq({
          conversationId: conversation.conversation_id,
          serverMsgId: message.server_msg_id,
          emoji,
        }),
        decodeOperationRes,
      );
    } catch (err) {
      this.applyReaction(conversation.conversation_id, message.server_msg_id, emoji, mine);
      this.notify(`表情回应失败：${wrapError(err).display}`, 'error');
    }
  }

  /** Applies a reaction delta to the local thread (used by the optimistic path). */
  private applyReaction(cid: string, serverMsgId: string, emoji: string, add: boolean): void {
    const thread = this.state.threads[cid];
    if (!thread) return;
    const items = thread.items.map((item) => {
      if (item.server_msg_id !== serverMsgId) return item;
      const list = [...(item.reactions ?? [])];
      const index = list.findIndex((entry) => entry.emoji === emoji);
      if (add) {
        if (index >= 0) list[index] = { ...list[index], count: list[index].count + 1, mine: true };
        else list.push({ emoji, count: 1, mine: true });
      } else if (index >= 0) {
        const next = { ...list[index], count: list[index].count - 1, mine: false };
        if (next.count <= 0) list.splice(index, 1);
        else list[index] = next;
      }
      return { ...item, reactions: list };
    });
    this.patchThread(cid, { items });
  }

  /** 1512: keyword search inside one conversation (newest first). */
  async searchMessages(cid: string, keyword: string): Promise<UiMessage[]> {
    if (!this.client) return [];
    const res = await this.client.request(
      OP.SEARCH,
      encodeSearchMessageReq({ conversationId: cid, keyword, limit: 30 }),
      decodeSearchMessageRes,
    );
    return res.payload.map((item) => ({ ...item, localState: 'sent' as const }));
  }

  // ------------------------------------------------------------------ sync --

  /** Records the login watermarks as the next 1601 baseline. */
  private rememberSyncBaseline(uid: string, sync: LoginRes['sync']): void {
    if (!sync || !uid) return;
    const baseline = {
      conversationVersion: Number(sync.conversation_version ?? 0),
      friendVersion: Number(sync.friend_version ?? 0),
      maxSeqs: Object.fromEntries(
        Object.entries(sync.max_seqs ?? {}).map(([key, value]) => [key, Number(value)]),
      ),
    };
    localStorage.setItem(`${SYNC_KEY}.${uid}`, JSON.stringify(baseline));
  }

  private loadSyncBaseline(): { conversationVersion: number; friendVersion: number; maxSeqs: Record<string, number> } | null {
    const uid = this.state.me?.uid;
    if (!uid) return null;
    const raw = localStorage.getItem(`${SYNC_KEY}.${uid}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { conversationVersion: number; friendVersion: number; maxSeqs: Record<string, number> };
    } catch {
      return null;
    }
  }

  /**
   * Converges with the server after a reconnect: 1601 tells us which
   * conversations moved, 1514 fills the gaps we missed.
   */
  async runSync(): Promise<{ full: boolean; gaps: number }> {
    if (!this.client || this.state.status !== 'ready') return { full: false, gaps: 0 };
    const baseline = this.loadSyncBaseline();
    if (!baseline) {
      await this.refresh();
      return { full: true, gaps: 0 };
    }
    try {
      const check = await this.client.request(
        OP.SYNC_CHECK,
        encodeSyncCheckReq({
          conversationVersion: baseline.conversationVersion,
          friendVersion: baseline.friendVersion,
          maxSeqs: baseline.maxSeqs,
        }),
        decodeSyncCheckRes,
      );
      const result = check.payload;
      if (result.full_sync_required) {
        await this.refresh();
        this.saveSyncState(result.conversation_version, result.friend_version, this.currentMaxSeqs());
        return { full: true, gaps: 0 };
      }

      let gaps = 0;
      for (const range of result.conversation_diff) {
        const thread = this.state.threads[range.conv_id];
        // Only loaded threads are patched; the rest re-read on open.
        if (!thread) continue;
        const from = Number(range.from_seq);
        const to = Number(range.to_seq);
        if (to < from) continue;
        const seqs: number[] = [];
        for (let seq = from; seq <= to && seqs.length < 200; seq += 1) seqs.push(seq);
        if (seqs.length === 0) continue;
        const missingRes = await this.client.request(
          OP.SYNC_MISSING,
          encodeSyncMissingReq({ conversationId: range.conv_id, seqs, limit: 200 }),
          decodeSyncMissingRes,
        );
        for (const item of missingRes.payload.messages) {
          this.appendToThread(range.conv_id, { ...item, conversation_id: range.conv_id, localState: 'sent' });
          gaps += 1;
        }
      }
      if (result.friend_changed) await this.refreshRelations();
      await this.refreshConversations();
      this.saveSyncState(result.conversation_version, result.friend_version, this.currentMaxSeqs());
      return { full: false, gaps };
    } catch (err) {
      if (import.meta.env.DEV) console.debug('[zim] sync failed', err);
      return { full: false, gaps: 0 };
    }
  }

  private currentMaxSeqs(): Record<string, number> {
    const maxSeqs: Record<string, number> = {};
    for (const conversation of this.state.conversations) {
      const seq = Number(conversation.max_seq ?? conversation.last_msg_seq ?? 0);
      if (seq > 0) maxSeqs[conversation.conversation_id] = seq;
    }
    return maxSeqs;
  }

  private saveSyncState(conversationVersion: string, friendVersion: string, maxSeqs: Record<string, number>): void {
    const uid = this.state.me?.uid;
    if (!uid) return;
    localStorage.setItem(`${SYNC_KEY}.${uid}`, JSON.stringify({
      conversationVersion: Number(conversationVersion),
      friendVersion: Number(friendVersion),
      maxSeqs,
    }));
  }

  // ------------------------------------------------------------------ push --

  private async handlePush(event: PushEvent): Promise<void> {
    if (import.meta.env.DEV && event.opcode !== OP.PUSH_MSG) console.debug(`[zim] push opcode=${event.opcode} len=${event.payload.length}`);
    if (event.opcode === OP.CALL_ANSWER) {
      this.handleCallPush(event.payload);
      return;
    }
    if (event.opcode === OP.CALL_STATE) {
      // 1805: a normal group's persistent room started or ended.
      this.handleGroupCallState(event.payload);
      return;
    }
    if (event.opcode === OP.PUSH_FRIEND) {
      const update = decodeFriendEventPush(event.payload);
      if (update.kind === 1 && String(update.to_uid) === String(this.state.me?.uid ?? '')) {
        this.notify('收到新的好友申请');
      }
      void this.refreshRelations();
      return;
    }
    if (event.opcode === OP.PUSH_ONLINE) {
      // 1903: one user's online flag changed (only sent on change).
      const update = decodeOnlineChangePush(event.payload);
      if (update.uid) {
        this.set({ presence: { ...this.state.presence, [update.uid]: update.online } });
      }
      return;
    }
    if (event.opcode === OP.PUSH_TYPING) {
      const update = decodeTypingPush(event.payload);
      if (update.conversation_id) {
        const next = { ...this.state.typing };
        if (update.typing) {
          // One entry per conversation: the latest sender wins (group chats).
          next[update.conversation_id] = { uid: update.uid, until: Date.now() + 5000 };
          window.setTimeout(() => {
            const current = this.state.typing[update.conversation_id];
            if (current && current.until <= Date.now()) {
              const cleared = { ...this.state.typing };
              delete cleared[update.conversation_id];
              this.set({ typing: cleared });
            }
          }, 5200);
        } else {
          delete next[update.conversation_id];
        }
        this.set({ typing: next });
      }
      return;
    }
    if (event.opcode === OP.PUSH_READ_SYNC) {
      const update = decodeReadSyncPush(event.payload);
      if (update.conversation_id) {
        this.set({
          peerReads: { ...this.state.peerReads, [update.conversation_id]: Number(update.read_seq) },
        });
      }
      return;
    }
    if (event.opcode === OP.PUSH_GROUP_EVENT) {
      this.handleGroupEvent(event.payload);
      return;
    }
    if (event.opcode === OP.CALL_HANGUP || event.opcode === OP.CALL_CANCEL) {
      if (import.meta.env.DEV) console.debug(`[zim] remote end opcode=${event.opcode}`);
      // A group call is a conference: one member hanging up only removes that
      // member from the roster (the SFU tells us who left), and the cancel push
      // is the initiator aborting the whole ring.
      const groupHangup = event.opcode === OP.CALL_HANGUP && this.state.call.targetType === 2;
      if (groupHangup) return;
      // The peer hung up or cancelled: close the sheet on this side too.
      if (this.state.call.phase !== 'idle') {
        this.notify(event.opcode === OP.CALL_CANCEL ? '对方已取消' : '对方已挂断');
        void this.endCall('remote');
      }
      return;
    }
    if (event.opcode !== OP.PUSH_MSG) return;

    let item: MessageItem;
    try {
      item = decodeMessageItem(event.payload);
    } catch {
      return;
    }
    this.set({ pushCount: this.state.pushCount + 1 });
    if (item.server_msg_id) {
      if (this.seenPushes.has(item.server_msg_id)) return;
      this.seenPushes.add(item.server_msg_id);
    }

    const cid = item.conversation_id;
    let conversation = this.conversation(cid);
    if (!conversation) {
      const selfUid = this.state.me?.uid ?? '';
      conversation = normalizeConversation(
        {
          conversation_id: cid,
          type: cid.startsWith('g_') || Number(item.group_id) > 0 ? 2 : 1,
          peer_id: String(item.send_id) === selfUid ? item.recv_id : item.send_id,
          group_id: item.group_id,
          recv_opt: 0,
          is_pinned: 0,
          unread: 0,
          read_seq: 0,
          max_seq: Number(item.seq),
          last_msg_seq: Number(item.seq),
          last_msg_at: Number(item.send_time),
          last_msg_brief: item.content,
        },
        selfUid,
      );
      this.set({ conversations: [conversation, ...this.state.conversations] });
    } else {
      this.patchConversation(cid, {
        last_msg_seq: Number(item.seq),
        last_msg_at: Number(item.send_time),
        last_msg_brief: item.content,
        max_seq: Math.max(Number(conversation.max_seq ?? 0), Number(item.seq)),
      });
    }

    const thread = this.state.threads[cid];
    // An edit/delete push reuses 1901 with an existing server_msg_id: replace
    // the bubble in place instead of appending a duplicate.
    if (item.server_msg_id && thread) {
      const existing = thread.items.find((entry) => entry.server_msg_id === item.server_msg_id);
      if (existing) {
        this.updateMessage(cid, existing.client_msg_id, {
          content: item.content,
          status: item.status,
          send_time: item.send_time,
        });
        this.patchConversation(cid, { last_msg_brief: item.content });
        return;
      }
    }
    if (thread && !thread.loading) {
      this.appendToThread(cid, { ...item, localState: 'sent' });
    } else if (!thread || thread.loading) {
      // A push can beat the history request. Buffer it and let openConversation
      // merge after the page lands; otherwise the message is lost until reload.
      const pending = this.pendingPushes.get(cid) ?? [];
      if (!pending.some((entry) => entry.server_msg_id === item.server_msg_id)) {
        pending.push({ ...item, localState: 'sent' });
        this.pendingPushes.set(cid, pending);
      }
    }

    const active = this.state.activeCid === cid && document.visibilityState === 'visible';
    if (active) {
      await this.markRead(cid);
    } else if (String(item.send_id) !== String(this.state.me?.uid ?? '')) {
      this.patchConversation(cid, { unread: Number(this.conversation(cid)?.unread ?? 0) + 1 });
      this.showDesktopNotification(cid, item);
    }
  }

  /** True when the browser granted desktop notifications. */
  get canNotify(): boolean {
    return typeof Notification !== 'undefined' && Notification.permission === 'granted';
  }

  /** Asks for notification permission (must be called from a user gesture). */
  async enableNotifications(): Promise<void> {
    if (typeof Notification === 'undefined') {
      this.notify('当前浏览器不支持桌面通知', 'error');
      return;
    }
    if (Notification.permission === 'granted') {
      this.set({ notifications: true });
      this.persistNotifications(true);
      this.notify('桌面通知已开启');
      return;
    }
    const permission = await Notification.requestPermission();
    this.set({ notifications: permission === 'granted' });
    this.notify(permission === 'granted' ? '桌面通知已开启' : '桌面通知被拒绝，可在浏览器设置中放开');
  }

  /** Turns desktop notifications off again (permission stays granted). */
  disableNotifications(): void {
    this.set({ notifications: false });
    this.persistNotifications(false);
    this.notify('桌面通知已关闭');
  }

  private persistNotifications(enabled: boolean): void {
    try {
      localStorage.setItem('zim.notifications', enabled ? '1' : '0');
    } catch {
      // private mode: keep the in-memory flag only
    }
  }

  /** Shows a system notification for a background message. */
  private showDesktopNotification(cid: string, item: MessageItem): void {
    if (!this.state.notifications || !this.canNotify) return;
    if (document.visibilityState === 'visible') return;
    const conversation = this.conversation(cid);
    const title = conversation?.type === 2 ? this.groupName(String(conversation.group_id)) : this.senderName(item.send_id);
    const body = messagePreview(item.content, item.msg_type);
    try {
      const notification = new Notification(title, { body, tag: cid, silent: false });
      notification.onclick = () => {
        window.focus();
        void this.openConversation(cid);
        notification.close();
      };
    } catch {
      // Notification construction can throw when the page is not focused.
    }
  }

  // ------------------------------------------------------------------ call --

  /** Cancels the ring/connect timers of the current call. */
  private clearCallTimers(): void {
    if (this.ringTimer !== null) {
      window.clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  /** Requests the mic before joining (mobile audio sessions need it early). */
  private async prepareMicrophone(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      this.notify('无法访问麦克风，对方将听不到你的声音', 'error');
    }
  }

  /**
   * Media attach with the two recoveries the SFU needs:
   * - a stale tab still holding the same identity is dropped and retried;
   * - 180009 (expired/invalid token) refetches a token through 1806.
   */
  private async connectMedia(callId: string, video: boolean, token: string, sfuUrl: string): Promise<void> {
    const attempt = (nextToken: string, nextUrl: string) => callSession.connect(sfuUrlFor(nextUrl), nextToken, video);
    try {
      await attempt(token, sfuUrl);
    } catch (err) {
      const text = String(err);
      if (/Client initiated disconnect|duplicate identity/i.test(text)) {
        await new Promise((resolve) => window.setTimeout(resolve, 1800));
        await attempt(token, sfuUrl);
        return;
      }
      if (/token|expired|unauthorized|permission|forbidden/i.test(text) && this.client) {
        const fresh = await this.client
          .request(OP.ROOM_TOKEN, encodeRoomTokenReq({ callId }), decodeRoomTokenRes)
          .catch(() => undefined);
        if (fresh?.payload.token && fresh.payload.sfu_url) {
          await attempt(fresh.payload.token, fresh.payload.sfu_url);
          return;
        }
      }
      throw err;
    }
  }

  /** Attaches media after an answer, preferring the token carried by phase=2. */
  private async attachAnswered(callId: string, video: boolean, token: string, sfuUrl: string): Promise<void> {
    try {
      if (this.state.call.callId !== callId) return;
      if (token && sfuUrl) {
        await this.connectRoom({ callId, token, sfuUrl, video });
      } else {
        await this.joinCallRoom(callId, video);
      }
      if (this.state.call.callId !== callId) return;
      if (this.state.call.participants.length > 1) this.markConnected(callId);
    } catch (err) {
      this.notify(`加入通话失败：${wrapError(err).display}`, 'error');
      await this.endCall('error');
    }
  }

  /**
   * Marks the call connected only when the media session is up and a remote
   * participant is already present (the LiveKit snapshot or a join event).
   */
  private markConnected(callId: string): void {
    const call = this.state.call;
    if (call.callId !== callId || call.phase === 'active') return;
    this.clearCallTimers();
    this.notify('通话已接通');
    this.set({ call: { ...call, phase: 'active', joined: true, startedAt: call.startedAt || Date.now() } });
  }

  /** Arms the shared ring timeout for the phase that is being entered. */
  private armRingTimer(expireAt = 0): void {
    this.clearCallTimers();
    // Iteration 1 returns expire_at with the invite: honour it (clamped) so the
    // server and the client give up at the same moment.
    const remaining = expireAt > 0
      ? Math.min(Math.max(expireAt - Date.now(), 5_000), 60_000)
      : CALL_RING_TIMEOUT_MS;
    this.ringTimer = window.setTimeout(() => {
      this.ringTimer = null;
      void this.onRingTimeout();
    }, remaining);
  }

  /** Ring timeout: the caller gives up, the callee dismisses the sheet. */
  private async onRingTimeout(): Promise<void> {
    const call = this.state.call;
    if (call.phase === 'outgoing') {
      this.notify('对方长时间无应答，已结束呼叫', 'error');
      await this.cancelCall();
      return;
    }
    if (call.phase !== 'incoming') return;
    // The caller cancels at the same deadline and that push closes this sheet
    // with the right wording. Wait briefly for it, then dismiss locally: a
    // local reject would reach the caller as "对方忙线中".
    const callId = call.callId;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const current = this.state.call;
    if (current.callId !== callId || current.phase !== 'incoming') return;
    this.notify('未接听的呼叫已结束');
    await this.endCall('timeout');
  }

  /** Cancels the SFU-join timer only (the ring timer keeps running). */
  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  /** Arms the SFU-join timeout (callee side and caller side alike). */
  private armConnectTimer(): void {
    if (this.connectTimer !== null) window.clearTimeout(this.connectTimer);
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      const call = this.state.call;
      if (!call.callId) return;
      if (call.phase !== 'connecting' && call.phase !== 'outgoing') return;
      this.notify('接入通话超时，请重试', 'error');
      void this.endCall('timeout');
    }, CALL_CONNECT_TIMEOUT_MS);
  }

  /** Server pushed an RTC state change (1802 with seq=0). */
  private handleCallPush(payload: Uint8Array): void {
    let update: CallAnswerPush;
    try {
      update = decodeCallAnswer(payload);
    } catch {
      return;
    }
    if (!update.call_id) return;
    if (import.meta.env.DEV) console.debug(`[zim] call push phase=${update.phase} target=${update.target_type} media=${update.media}`);
    switch (update.phase) {
      case 1:
        // Normal groups are persistent rooms: 1805 carries their state and no
        // member ever gets a ringing sheet, so ignore a stray group phase=1.
        if (update.target_type === 2) return;
        // Our own outgoing call can echo phase=1 back to the caller (family
        // ringing is fanned out to every member): never ring for our own call.
        if (this.state.call.callId === update.call_id) return;
        // Ringing: the callee shows the incoming call sheet. A second call while
        // one is already live must not hijack the sheet: reject it right away.
        if (this.state.call.phase !== 'idle') {
          this.notify(`有人来电，但你正在${this.state.call.phase === 'incoming' ? '接听另一通电话' : '通话中'}`);
          void this.client?.request(
            OP.CALL_ANSWER,
            encodeCallAnswerReq({ callId: update.call_id, accept: false }),
            decodeCallAnswer,
          ).catch(() => undefined);
          return;
        }
        this.set({
          call: {
            phase: 'incoming',
            callId: update.call_id,
            media: update.media === 2 ? 2 : 1,
            targetType: update.target_type === 2 ? 2 : update.target_type === 3 ? 3 : 1,
            // The family id is not part of CallAnswerRes; the 1805 push/card
            // carries it once a member answers, so the room can be joined later.
            groupId: '',
            joinedElsewhere: false,
            joined: false,
            participants: [],
            speaking: [],
            peerId: update.from_uid,
            peerName: update.from_nickname || `用户 ${update.from_uid}`,
            room: update.room,
            startedAt: 0,
            muted: false,
            videoOn: update.media === 2,
            error: '',
          },
        });
        this.armRingTimer();
        break;
      case 2:
        // Answered by the peer (caller side) or auto-answered (family).
        if (this.state.call.callId !== update.call_id) return;
        this.clearCallTimers();
        if (this.state.call.phase === 'incoming') {
          if (this.state.call.targetType === 3) {
            // Another family member answered: stop ringing here, but stay open
            // for a late join from the family room bar / call card.
            this.notify('其他家庭成员已接听');
            void this.endCall('answered-elsewhere');
            return;
          }
          this.set({ call: { ...this.state.call, joinedElsewhere: true } });
          return;
        }
        {
          const selfUid = String(this.state.me?.uid ?? '');
          const participants = Array.from(new Set([
            ...this.state.call.participants,
            selfUid,
            ...(update.from_uid ? [String(update.from_uid)] : []),
          ].filter(Boolean)));
          // Answered: "已接通" waits for the SFU connection plus a remote
          // participant, so the sheet shows "正在接通…" until media is live.
          this.set({
            call: {
              ...this.state.call,
              // Answered but no remote media yet: "正在接通…" until the SFU
              // reports the peer (rooms that are already live stay active).
              phase: this.state.call.phase === 'active' ? 'active' : 'connecting',
              participants,
              room: update.room || this.state.call.room,
            },
          });
          if (!this.state.call.joined) {
            // The phase=2 frame carries a token now (iteration 1); fall back to
            // 1806 for older servers.
            void this.attachAnswered(update.call_id, update.media === 2, update.token ?? '', update.sfu_url ?? '');
          } else if (participants.length > 1) {
            this.markConnected(update.call_id);
          }
        }
        break;
      case 3:
        // Rejected by the callee (180002 family: phase=3 means "declined").
        // Ignore it when this side already ended the call: both ends run the
        // same ring timeout.
        if (this.state.call.callId !== update.call_id || this.state.call.phase === 'idle') return;
        this.clearCallTimers();
        this.notify('对方已拒绝', 'error');
        void this.endCall('rejected');
        break;
      case 4:
        // Another device of the callee answered: stop ringing here.
        if (this.state.call.callId !== update.call_id) return;
        if (this.state.call.phase !== 'incoming' && this.state.call.phase !== 'connecting') return;
        this.clearCallTimers();
        this.notify('已在其他设备接听');
        void this.endCall('answered-elsewhere');
        break;
      default:
        break;
    }
  }

  /** Starts an outgoing call in the active conversation (direct or group). */
  async startCall(media: 1 | 2): Promise<void> {
    const conversation = this.conversation(this.state.activeCid);
    if (!conversation || !this.client) {
      this.notify('请先打开一个会话', 'error');
      return;
    }
    if (this.state.call.phase !== 'idle') return;
    const support = detectRtcSupport();
    if (!support.supported) {
      this.notify(`无法呼叫：${support.detail}`, 'error');
      return;
    }
    const callId = randomId();
    const isGroup = conversation.type === 2;
    const targetType: 1 | 2 = isGroup ? 2 : 1;
    // Derive the target from the conversation id: REST group ids are JSON
    // numbers and lose 64-bit precision in the browser.
    const cidParts = conversation.conversation_id.split('_');
    const peerId = String(
      isGroup
        ? (conversation.conversation_id.startsWith('g_') ? conversation.conversation_id.slice(2) : conversation.group_id)
        : conversation.peer_id,
    );
    if (isGroup && cidParts.length < 2) {
      this.notify('群会话标识无效', 'error');
      return;
    }
    const peer = isGroup ? this.groupName(peerId) : this.friendProfile(peerId);
    if (isGroup) {
      // Family groups keep the ringing model but add the join/leave room API.
      if (this.groupTypeOf(peerId) === 3) {
        await this.startFamilyCall(media, peerId, peer);
        return;
      }
      // Normal groups are persistent rooms: create and join in one step.
      await this.startGroupCall(media, peerId, peer);
      return;
    }
    this.set({
      call: {
        phase: 'outgoing',
        callId,
        media,
        targetType,
        groupId: '',
        joinedElsewhere: false,
        joined: false,
        participants: this.state.me ? [String(this.state.me.uid)] : [],
        speaking: [],
        peerId,
        peerName: peer,
        room: '',
        startedAt: 0,
        muted: false,
        videoOn: media === 2,
        error: '',
      },
    });
    // The callee may never answer: give up after the shared ring timeout.
    this.armRingTimer();
    this.armConnectTimer();

    try {
      const res = await this.client.request(
        OP.CALL_INVITE,
        encodeCallInviteReq({ callId, targetType, targetId: peerId, media }),
        decodeCallInviteRes,
      );
      this.set({ call: { ...this.state.call, room: res.payload.room } });
      // Iteration 1: the invite response carries a token for every target type,
      // so the caller joins the SFU right away and waits as "calling" instead of
      // waiting for phase=2 to open the media session.
      this.armRingTimer(Number(res.payload.expire_at) || 0);
      if (res.payload.token && res.payload.sfu_url) {
        try {
          await this.connectRoom({
            callId: res.payload.call_id || callId,
            token: res.payload.token,
            sfuUrl: res.payload.sfu_url,
            video: media === 2,
          });
          this.clearConnectTimer();
        } catch (err) {
          // The invite is already out: keep ringing and retry from phase=2.
          this.notify(`媒体连接失败：${wrapError(err).display}`, 'error');
        }
      }
    } catch (err) {
      const wrapped = wrapError(err);
      // 180001: the callee has no online device, the room was never joined.
      this.notify(
        wrapped.code === 180001 ? '对方不在线，无法呼叫' : `呼叫失败：${explainRtcError(wrapped.display)}`,
        'error',
      );
      await this.endCall('error');
    }
  }

  /** Accepts the ringing call and joins the SFU room. */
  async acceptCall(): Promise<void> {
    const call = this.state.call;
    if (call.phase !== 'incoming' || !this.client) return;
    const support = detectRtcSupport();
    if (!support.supported) {
      this.notify(`无法接听：${support.detail}`, 'error');
      return;
    }
    this.set({ call: { ...call, phase: 'connecting' } });
    this.clearCallTimers();
    this.armConnectTimer();
    try {
      const answer = await this.client.request(
        OP.CALL_ANSWER,
        encodeCallAnswerReq({ callId: call.callId, accept: true }),
        decodeCallAnswer,
      );
      if (import.meta.env.DEV) console.debug('[zim] call answered, attaching media');
      // Ask for the microphone before joining so the first frames are not silent
      // and the user sees the permission prompt while the call is still ringing.
      await this.prepareMicrophone();
      if (answer.payload.token && answer.payload.sfu_url) {
        await this.connectRoom({
          callId: call.callId,
          token: answer.payload.token,
          sfuUrl: answer.payload.sfu_url,
          video: call.media === 2,
        });
      } else {
        await this.joinCallRoom(call.callId, call.media === 2);
      }
      this.clearCallTimers();
      // The SFU snapshot may arrive after this transition: seed the roster with
      // our own uid so the caller and callee agree on the head count at once.
      const selfUid = String(this.state.me?.uid ?? '');
      const participants = Array.from(new Set([selfUid, ...this.state.call.participants].filter(Boolean)));
      this.set({ call: { ...this.state.call, participants } });
      if (participants.length > 1) this.markConnected(call.callId);
      else this.armConnectTimer();
    } catch (err) {
      this.notify(`接听失败：${wrapError(err).display}`, 'error');
      await this.endCall('error');
    }
  }

  /** Rejects the ringing call. */
  async rejectCall(): Promise<void> {
    const call = this.state.call;
    if (call.phase !== 'incoming' || !this.client) return;
    const support = detectRtcSupport();
    if (!support.supported) {
      this.notify(`无法接听：${support.detail}`, 'error');
      return;
    }
    try {
      await this.client.request(OP.CALL_ANSWER, encodeCallAnswerReq({ callId: call.callId, accept: false }), decodeCallAnswer);
    } catch {
      // the sheet closes either way
    }
    await this.endCall('rejected');
  }

  /** Caller cancels while ringing. */
  async cancelCall(): Promise<void> {
    const call = this.state.call;
    if (import.meta.env.DEV) console.debug(`[zim] call cancel requested phase=${call.phase}`);
    if (!this.client || call.phase !== 'outgoing') return;
    try {
      await this.client.request(OP.CALL_CANCEL, encodeCallCancelReq({ callId: call.callId, reason: 6 }), decodeOperationRes);
    } catch {
      // ignore
    }
    await this.endCall('cancelled');
  }

  /** Hangs up an active call (or leaves a group room / cancels a ringing one). */
  async hangupCall(): Promise<void> {
    const call = this.state.call;
    if (import.meta.env.DEV) console.debug(`[zim] call hangup requested phase=${call.phase}`);
    if (call.phase === 'incoming') {
      await this.rejectCall();
      return;
    }
    if (call.phase === 'outgoing') {
      await this.cancelCall();
      return;
    }
    // Group rooms: leaving only removes this member; the last leaver ends it.
    if (isRoomTarget(call.targetType) && this.client && (call.phase === 'active' || call.phase === 'connecting')) {
      await this.leaveGroupCall();
      return;
    }
    if (!this.client || (call.phase !== 'active' && call.phase !== 'connecting')) return;
    const duration = call.startedAt > 0 ? Math.round((Date.now() - call.startedAt) / 1000) : 0;
    try {
      await this.client.request(
        OP.CALL_HANGUP,
        encodeCallHangupReq({ callId: call.callId, reason: 1, duration }),
        decodeOperationRes,
      );
    } catch {
      // local teardown still runs
    }
    await this.endCall('hangup');
  }

  // ------------------------------------------------------------ group rooms --

  /**
   * Starts a family call (target.type=3).
   *
   * Family keeps the ringing model: members still receive 1802 phase=1 and the
   * caller gets no token in CallInviteRes, so the room token comes from 1806.
   * The caller joins right away while the others ring.
   */
  private async startFamilyCall(media: 1 | 2, familyId: string, familyName: string): Promise<void> {
    if (!this.client) return;
    const callId = randomId();
    const selfUid = String(this.state.me?.uid ?? '');
    this.set({
      call: {
        ...emptyCall(),
        phase: 'outgoing',
        callId,
        media,
        targetType: 3,
        groupId: familyId,
        participants: selfUid ? [selfUid] : [],
        peerId: familyId,
        peerName: familyName,
        videoOn: media === 2,
      },
    });
    this.armRingTimer();
    this.armConnectTimer();
    try {
      const invite = await this.client.request(
        OP.CALL_INVITE,
        encodeCallInviteReq({ callId, targetType: 3, targetId: familyId, media }),
        decodeCallInviteRes,
      );
      // The caller waits for a member to answer (the family still rings). The
      // backend treats any 1806 join during ringing as "answered", so joining
      // before phase=2 would stop everyone's ringing before anybody accepted.
      this.setGroupRoom(familyId, {
        callId: invite.payload.call_id,
        targetType: 3,
        media,
        active: true,
        participants: selfUid ? [selfUid] : [],
        room: invite.payload.room,
        startedAt: Date.now(),
      });
      this.set({
        call: { ...this.state.call, callId: invite.payload.call_id, room: invite.payload.room },
      });
      this.clearConnectTimer();
    } catch (err) {
      const wrapped = wrapError(err);
      if (wrapped.code === 180011) {
        this.notify('家庭组正在通话中，正在加入');
        await this.endCall('error');
        await this.refreshGroupCall(familyId);
        await this.joinGroupCall(familyId);
        return;
      }
      this.notify(
        wrapped.code === 130002 ? '你不是该家庭成员' : `发起失败：${explainRtcError(wrapped.display)}`,
        'error',
      );
      await this.endCall('error');
    }
  }

  /**
   * Starts a normal group's persistent room (1801, target.type=2).
   *
   * The invite response already carries a join token: there is no ringing phase
   * and no callee to wait for, so the caller enters the SFU immediately.
   */
  private async startGroupCall(media: 1 | 2, groupId: string, groupName: string): Promise<void> {
    if (!this.client) return;
    const callId = randomId();
    const selfUid = String(this.state.me?.uid ?? '');
    this.set({
      call: {
        ...emptyCall(),
        phase: 'connecting',
        callId,
        media,
        targetType: 2,
        groupId,
        participants: selfUid ? [selfUid] : [],
        peerId: groupId,
        peerName: groupName,
        videoOn: media === 2,
      },
    });
    try {
      const res = await this.client.request(
        OP.CALL_INVITE,
        encodeCallInviteReq({ callId, targetType: 2, targetId: groupId, media }),
        decodeCallInviteRes,
      );
      const payload = res.payload;
      this.setGroupRoom(groupId, {
        callId: payload.call_id,
        targetType: 2,
        media: payload.media === 2 ? 2 : media,
        active: true,
        participants: payload.participants,
        room: payload.room,
        startedAt: Date.now(),
      });
      this.set({
        call: {
          ...this.state.call,
          callId: payload.call_id,
          room: payload.room,
          participants: Array.from(new Set([selfUid, ...payload.participants].filter(Boolean))),
        },
      });
      await this.connectRoom({
        callId: payload.call_id,
        token: payload.token,
        sfuUrl: payload.sfu_url,
        video: (payload.media === 2 || media === 2),
      });
    } catch (err) {
      const wrapped = wrapError(err);
      if (wrapped.code === 180011) {
        // The group already has a room: query it and join instead of retrying.
        this.notify('该群正在通话中，正在加入');
        await this.endCall('error');
        await this.refreshGroupCall(groupId);
        await this.joinGroupCall(groupId);
        return;
      }
      this.notify(
        wrapped.code === 130002 ? '你不是该群成员' : `发起失败：${explainRtcError(wrapped.display)}`,
        'error',
      );
      await this.endCall('error');
    }
  }

  /** Joins the active room of a group or family (1806 with the group id). */
  async joinGroupCall(groupId: string, callId = ''): Promise<void> {
    if (!groupId) return;
    if (this.state.call.phase !== 'idle') {
      if (isRoomTarget(this.state.call.targetType) && this.state.call.groupId === groupId) return;
      this.notify('你正在通话中', 'error');
      return;
    }
    const support = detectRtcSupport();
    if (!support.supported) {
      this.notify(`无法加入：${support.detail}`, 'error');
      return;
    }
    const room = this.state.groupCalls[groupId];
    const targetType: CallTargetType = room?.targetType ?? (this.groupTypeOf(groupId) === 3 ? 3 : 2);
    const selfUid = String(this.state.me?.uid ?? '');
    this.set({
      call: {
        ...emptyCall(),
        phase: 'connecting',
        callId,
        targetType,
        groupId,
        participants: selfUid ? [selfUid] : [],
        peerId: groupId,
        peerName: this.groupName(groupId),
      },
    });
    try {
      const res = await this.client!.request(
        OP.ROOM_TOKEN,
        encodeRoomTokenReq({ callId, groupId }),
        decodeRoomTokenRes,
      );
      const payload = res.payload;
      const media: 1 | 2 = payload.media === 2 ? 2 : 1;
      this.setGroupRoom(groupId, {
        callId: payload.call_id,
        targetType: this.state.call.targetType === 3 ? 3 : 2,
        media,
        active: true,
        participants: payload.participants,
        room: payload.room,
        startedAt: Date.now(),
      });
      this.set({
        call: {
          ...this.state.call,
          callId: payload.call_id,
          media,
          room: payload.room,
          videoOn: media === 2,
          participants: Array.from(new Set([selfUid, ...payload.participants].filter(Boolean))),
        },
      });
      await this.connectRoom({
        callId: payload.call_id,
        token: payload.token,
        sfuUrl: payload.sfu_url,
        video: media === 2,
      });
    } catch (err) {
      const wrapped = wrapError(err);
      if (wrapped.code === 180003 || wrapped.code === 180004) {
        this.notify('通话已结束');
        this.clearGroupRoom(groupId);
      } else if (wrapped.code === 180008) {
        this.notify('通话人数已满', 'error');
      } else if (wrapped.code === 130002) {
        this.notify(targetType === 3 ? '你不是该家庭成员' : '你不是该群成员', 'error');
        this.clearGroupRoom(groupId);
      } else {
        this.notify(`加入失败：${explainRtcError(wrapped.display)}`, 'error');
      }
      await this.endCall('error');
    }
  }

  /** Leaves the current group room (1803): only the last participant ends it. */
  private async leaveGroupCall(): Promise<void> {
    const call = this.state.call;
    const duration = call.startedAt > 0 ? Math.round((Date.now() - call.startedAt) / 1000) : 0;
    let ended = false;
    try {
      const res = await this.client?.request(
        OP.CALL_HANGUP,
        encodeCallHangupReq({ callId: call.callId, reason: 1, duration }),
        decodeCallHangupRes,
      );
      ended = Boolean(res?.payload.ended);
    } catch (err) {
      // 180003 means the room is already gone: treat it as ended.
      ended = wrapError(err).code === 180003;
    }
    await this.endCall('hangup');
    if (ended) {
      this.clearGroupRoom(call.groupId);
      return;
    }
    // The room stays open: drop ourselves from the cached roster so the banner
    // count does not keep counting a member who just left.
    const room = this.state.groupCalls[call.groupId];
    if (room) {
      const selfUid = String(this.state.me?.uid ?? '');
      this.setGroupRoom(call.groupId, {
        ...room,
        participants: room.participants.filter((uid) => uid !== selfUid),
      });
    }
  }

  /**
   * Drops a stale room mark: sends 1803 for the recorded call (best effort) and
   * clears the local entry. Used when a previous tab died without leaving.
   */
  async clearGroupCall(groupId: string): Promise<void> {
    const room = this.state.groupCalls[groupId];
    if (!room) return;
    if (this.client) {
      try {
        await this.client.request(
          OP.CALL_HANGUP,
          encodeCallHangupReq({ callId: room.callId, reason: 1, duration: 0 }),
          decodeCallHangupRes,
        );
      } catch {
        // already ended
      }
    }
    this.clearGroupRoom(groupId);
  }

  /** Queries a group's active room (1805 by group id). */
  async refreshGroupCall(groupId: string): Promise<void> {
    if (!this.client || !groupId) return;
    try {
      const res = await this.client.request(
        OP.CALL_STATE,
        encodeCallStateReq({ groupId }),
        decodeCallStateRes,
      );
      this.applyGroupCallState(res.payload);
    } catch {
      // transient: the next visit or push retries
    }
  }

  /** Applies a 1805 push (state changes of a group room). */
  private handleGroupCallState(payload: Uint8Array): void {
    try {
      this.applyGroupCallState(decodeCallStateRes(payload));
    } catch {
      // malformed frame: ignore
    }
  }

  private applyGroupCallState(state: CallStateResult): void {
    const groupId = state.group_id && state.group_id !== '0' ? state.group_id : '';
    if (!groupId || state.target_type === 1) return;
    const active = Boolean(state.active) && state.call_id !== '';
    if (!active) {
      this.clearGroupRoom(groupId);
      const call = this.state.call;
      if (call.phase !== 'idle' && isRoomTarget(call.targetType) && call.groupId === groupId) {
        this.notify('通话已结束');
        void this.endCall('remote');
      }
      return;
    }
    const media: 1 | 2 = state.media === 2 ? 2 : 1;
    this.setGroupRoom(groupId, {
      callId: state.call_id,
      targetType: state.target_type === 3 ? 3 : 2,
      media,
      active: true,
      participants: state.participants,
      room: state.room,
      startedAt: Number(state.started_at) || Date.now(),
    });
  }

  private setGroupRoom(groupId: string, room: GroupCallRoom): void {
    if (!groupId || !room.callId) return;
    this.set({ groupCalls: { ...this.state.groupCalls, [groupId]: room } });
  }

  private clearGroupRoom(groupId: string): void {
    if (!groupId || !this.state.groupCalls[groupId]) return;
    const next = { ...this.state.groupCalls };
    delete next[groupId];
    this.set({ groupCalls: next });
  }

  private startGroupHeartbeat(): void {
    this.stopGroupHeartbeat();
    void this.reportParticipantState();
    this.groupHeartbeatTimer = window.setInterval(() => void this.reportParticipantState(), 30_000);
  }

  private stopGroupHeartbeat(): void {
    if (this.groupHeartbeatTimer !== null) {
      window.clearInterval(this.groupHeartbeatTimer);
      this.groupHeartbeatTimer = null;
    }
  }

  /** Best-effort leave when the page is closed (the socket may die first). */
  private armUnloadLeave(): void {
    this.disarmUnloadLeave();
    const handler = () => {
      const call = this.state.call;
      if (call.phase === 'idle' || call.targetType !== 2 || !call.callId) return;
      void this.client
        ?.request(OP.CALL_HANGUP, encodeCallHangupReq({ callId: call.callId, reason: 1, duration: 0 }), decodeCallHangupRes)
        .catch(() => undefined);
    };
    this.unloadLeaveHandler = handler;
    window.addEventListener('pagehide', handler);
  }

  private disarmUnloadLeave(): void {
    if (!this.unloadLeaveHandler) return;
    window.removeEventListener('pagehide', this.unloadLeaveHandler);
    this.unloadLeaveHandler = null;
  }

  /** Toggles the microphone and reports participant state (1807). */
  async toggleMute(): Promise<void> {
    const call = this.state.call;
    if (!call.callId) return;
    const muted = !call.muted;
    this.set({ call: { ...call, muted } });
    await callSession.setMicrophone(!muted).catch(() => undefined);
    void this.reportParticipantState();
  }

  /** Toggles the camera for video calls. */
  async toggleCamera(): Promise<void> {
    const call = this.state.call;
    if (!call.callId) return;
    const videoOn = !call.videoOn;
    this.set({ call: { ...call, videoOn } });
    await callSession.setCamera(videoOn).catch(() => undefined);
    void this.reportParticipantState();
  }

  private async reportParticipantState(): Promise<void> {
    const call = this.state.call;
    if (!this.client || !call.callId || !this.state.me) return;
    await this.client
      .request(
        OP.CALL_PARTICIPANT,
        encodeParticipantStateReq({
          callId: call.callId,
          uid: this.state.me.uid,
          muted: call.muted,
          videoOn: call.videoOn,
        }),
        decodeOperationRes,
      )
      .catch(() => undefined);
  }

  /** Fetches a room token and connects the media session. */
  private async joinCallRoom(callId: string, video: boolean): Promise<void> {
    if (!this.client) return;
    const res = await this.client.request(
      OP.ROOM_TOKEN,
      encodeRoomTokenReq({ callId }),
      decodeRoomTokenRes,
    );
    const { token, sfu_url: sfuUrl } = res.payload;
    if (import.meta.env.DEV) console.debug(`[zim] call room token ok sfu=${sfuUrl} token=${token ? 'yes' : 'no'}`);
    await this.connectRoom({ callId, token, sfuUrl, video });
  }

  /** Attaches the media session with a ready token (1:1 answers and group rooms). */
  private async connectRoom(opts: { callId: string; token: string; sfuUrl: string; video: boolean }): Promise<void> {
    const { callId, token, sfuUrl, video } = opts;
    if (!token || !sfuUrl) throw new Error('SFU 未就绪');
    callSession.onTrack({
      onSpeakers: (uids) => {
        if (this.state.call.callId !== callId) return;
        this.set({ call: { ...this.state.call, speaking: uids } });
      },
      onParticipantJoined: (identity) => {
        const call = this.state.call;
        if (call.callId !== callId) return;
        const selfUid = String(this.state.me?.uid ?? '');
        const participants = Array.from(new Set([...call.participants, identity]));
        this.set({ call: { ...call, participants } });
        // A remote identity in the room means the call is live, regardless of
        // whether the phase=2 push arrived first (it can be lost).
        if (identity !== selfUid) {
          this.markConnected(callId);
        }
      },
      // Authoritative snapshot from the SFU: it also contains the participants
      // that were already in the room before this client joined, which is why a
      // late joiner used to show "0 人".
      onParticipants: (identities) => {
        const call = this.state.call;
        if (call.callId !== callId) return;
        const selfUid = String(this.state.me?.uid ?? '');
        const next = Array.from(new Set([selfUid, ...identities].filter(Boolean)));
        const same = next.length === call.participants.length
          && next.every((uid, index) => uid === call.participants[index]);
        if (!same) this.set({ call: { ...call, participants: next } });
        // Connected + a remote identity present is the "已接通" signal.
        if (next.some((uid) => uid !== selfUid)) this.markConnected(callId);
      },
      onParticipantLeft: (identity) => {
        const call = this.state.call;
        if (call.callId !== callId) return;
        // In a 1:1 call the other side leaving means the call is over; in a
        // group call the member is simply removed from the roster.
        if (call.targetType === 1) {
          if (call.phase !== 'active' && call.phase !== 'connecting') return;
          this.notify('对方已离开，通话结束');
          void this.endCall('remote');
          return;
        }
        if (!identity) return;
        const remaining = call.participants.filter((uid) => uid !== identity);
        this.set({ call: { ...call, participants: remaining } });
        const selfUid = String(this.state.me?.uid ?? '');
        if (remaining.length <= 1 && remaining.every((uid) => uid === selfUid)) {
          this.notify('其他成员已离开');
        }
      },
      onDisconnected: () => {
        const call = this.state.call;
        if (call.callId !== callId || call.phase === 'idle') return;
        this.notify('通话连接已断开', 'error');
        void this.endCall('error');
      },
    });
    await this.connectMedia(callId, video, token, sfuUrl);
    if (import.meta.env.DEV) console.debug('[zim] call media connected');
    if (this.state.call.callId === callId && this.state.call.phase === 'idle') return;
    // Media is attached: flag it for every target type so a later phase=2 does
    // not connect a second time.
    if (this.state.call.callId === callId && !this.state.call.joined) {
      this.set({ call: { ...this.state.call, joined: true } });
    }
    // Group rooms are persistent: the call is active as soon as media is up and
    // keeps its heartbeat. A 1:1 call stays "outgoing"/"connecting" until the
    // peer answers (phase=2 push or the peer's participant-joined event).
    if (this.state.call.callId === callId && isRoomTarget(this.state.call.targetType)) {
      this.set({
        call: {
          ...this.state.call,
          phase: 'active',
          joined: true,
          startedAt: this.state.call.startedAt || Date.now(),
          participants: Array.from(new Set([
            String(this.state.me?.uid ?? ''),
            ...this.state.call.participants,
          ].filter(Boolean))),
        },
      });
      if (isRoomTarget(this.state.call.targetType)) {
        this.startGroupHeartbeat();
        this.armUnloadLeave();
      }
    }
  }

  private async endCall(_reason: string): Promise<void> {
    this.clearCallTimers();
    this.stopGroupHeartbeat();
    this.disarmUnloadLeave();
    await callSession.end().catch(() => undefined);
    this.set({ call: emptyCall() });
  }

  private friendProfile(uid: string): string {
    const friend = this.state.friends.find((item) => String(item.friend_id) === uid);
    return friend?.remark || friend?.profile?.nickname || friend?.profile?.username || `用户 ${uid}`;
  }

  private handleKick(reason: number): void {
    const reasons: Record<number, string> = {
      1: '账号已在另一处登录，本端已退出',
      2: '管理员强制下线',
      3: '登录态已失效，请重新登录',
      4: '账号已被禁用',
    };
    const message = reasons[reason] ?? '已被强制下线';
    if (import.meta.env.DEV) {
      (window as unknown as { __zimKick?: unknown }).__zimKick = { reason, at: Date.now() };
      console.debug(`[zim] kicked reason=${reason}`);
    }
    // Leave a persistent note on the login screen: the toast disappears with the
    // workspace. logout() closes the socket so no reconnect fight follows.
    this.notify(message, 'error');
    this.logout(true);
    this.set({ authError: message });
  }

  /** Re-marks the open conversation when the tab becomes visible again. */
  /**
   * Dev-only push injection: lets the automation harness exercise server
   * pushes that need a second device (e.g. phase=4 answered elsewhere).
   */
  devPush(opcode: number, payload: Uint8Array): void {
    if (!import.meta.env.DEV) return;
    void this.handlePush({ opcode, payload, code: 0, message: '' });
  }

  onVisible(): void {
    if (document.visibilityState !== 'visible') {
      // Hidden tab: stop refreshing the subscription until it comes back.
      this.stopPresence();
      return;
    }
    if (this.state.activeCid) void this.markRead(this.state.activeCid);
    // Re-subscribe on return: the previous subscription may have expired.
    void this.subscribePresence();
    // The tab may have missed pushes while hidden: reconcile the call sheet.
    void this.reconcileCall();
  }

  /**
   * Compares the local call sheet with the server (1805) after a reconnect or a
   * return to the foreground, then either re-attaches the SFU or closes a stale
   * sheet. This is the client-side stand-in for the missing event versioning.
   */
  async reconcileCall(): Promise<void> {
    const call = this.state.call;
    if (!this.client || call.phase === 'idle' || !call.callId) return;
    if (isRoomTarget(call.targetType) && call.groupId) {
      await this.refreshGroupCall(call.groupId);
      const room = this.state.groupCalls[call.groupId];
      if (!room || room.callId !== call.callId) {
        this.notify('通话已结束');
        await this.endCall('hangup');
        return;
      }
      if (call.phase === 'active' && !callSession.isConnected()) {
        await this.reconnectMedia(call.callId, call.media === 2);
      }
      return;
    }
    try {
      const res = await this.client.request(
        OP.CALL_STATE,
        encodeCallStateReq({ callId: call.callId }),
        decodeCallStateRes,
      );
      const state = res.payload;
      if (!state.active) {
        this.notify('通话已结束');
        await this.endCall('hangup');
        return;
      }
      if (Number(state.state) === 2) {
        if (!callSession.isConnected()) {
          await this.reconnectMedia(call.callId, call.media === 2);
        }
        if (call.participants.length > 1) this.markConnected(call.callId);
      }
    } catch (err) {
      const code = wrapError(err).code;
      if (code === 180003 || code === 180004) {
        this.notify('通话已结束');
        await this.endCall('hangup');
      }
    }
  }

  /** Fetches a fresh token for an answered call and re-attaches the SFU. */
  private async reconnectMedia(callId: string, video: boolean): Promise<void> {
    if (!this.client) return;
    try {
      const room = await this.client.request(
        OP.ROOM_TOKEN,
        encodeRoomTokenReq({ callId }),
        decodeRoomTokenRes,
      );
      if (this.state.call.callId !== callId) return;
      await this.connectRoom({ callId, token: room.payload.token, sfuUrl: room.payload.sfu_url, video });
    } catch (err) {
      const code = wrapError(err).code;
      if (code === 180003 || code === 180004) {
        this.notify('通话已结束');
        await this.endCall('hangup');
      }
    }
  }

  // ------------------------------------------------------------- reconnect --

  retryConnect(): void {
    this.rest.clearTokens();
    this.client?.close();
    this.client = null;
    sessionStorage.removeItem(SESSION_KEY);
    this.set({ status: 'idle', connection: 'closed', me: null });
  }
}

export const imStore = new ImStore();

export const useIm = (): ImState => useSyncExternalStore(imStore.subscribe, imStore.getSnapshot, imStore.getSnapshot);

export const errorText = (err: unknown): string => (err instanceof ImError ? err.display : wrapError(err).message);
