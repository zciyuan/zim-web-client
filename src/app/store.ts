// Application store: owns the connection, the REST client and all UI state.
//
// Components subscribe through useIm(); every mutation replaces the state
// object so useSyncExternalStore sees a new snapshot.

import { useSyncExternalStore } from 'react';

import { IMClient, type ConnectionState, type PushEvent } from '../sdk/client';
import { ImError, wrapError } from '../sdk/errors';
import { directConversationId, groupConversationId, loadOlder, loadTail } from '../sdk/history';
import { messagePreview, messageText } from './format';
import { measureImage, measureMedia } from './image';
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
  decodeCallInviteRes,
  decodeRoomTokenRes,
  encodeCallAnswerReq,
  encodeCallCancelReq,
  encodeCallHangupReq,
  encodeCallInviteReq,
  encodeParticipantStateReq,
  encodeRoomTokenReq,
  type CallAnswerPush,
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

const SESSION_KEY = 'zim.session';
const SYNC_KEY = 'zim.sync';
const DEVICE_KEY = 'zim.device';
const ENDPOINT_KEY = 'zim.endpoint';
const SDK_VERSION = 'web-2.0.0';

export type Tab = 'conversations' | 'friends' | 'groups';
export type AppStatus = 'idle' | 'restoring' | 'authenticating' | 'ready';

export interface UiMessage extends MessageItem {
  localState?: 'sending' | 'sent' | 'failed';
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
  /** desktop notifications enabled and permitted */
  notifications: boolean;
  /** color theme preference */
  theme: ThemeMode;
  /** conversation id -> read seq captured when it was opened (unread divider) */
  unreadAnchors: Record<string, number>;
  /** direct chats: how far the peer has read (seq, from 1906) */
  peerReads: Record<string, number>;
  quoteTarget: UiMessage | null;
  call: CallStatus;
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
  peerReads: {},
  notifications: typeof localStorage !== 'undefined' && localStorage.getItem('zim.notifications') === '1',
  theme: (typeof localStorage !== 'undefined' ? (localStorage.getItem('zim.theme') as ThemeMode | null) : null) ?? 'system',
  unreadAnchors: {},
  quoteTarget: null,
  call: emptyCall(),
  lastCallError: '',
  me: null,
  endpoint: localStorage.getItem(ENDPOINT_KEY) ?? '',
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

export interface CallStatus {
  phase: CallPhase;
  callId: string;
  media: 1 | 2;
  /** 1 direct / 2 group */
  targetType: 1 | 2;
  /** group calls: another member already joined */
  joinedElsewhere: boolean;
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
    phase: 'idle', callId: '', media: 1, targetType: 1, joinedElsewhere: false, participants: [], speaking: [],
    peerId: '', peerName: '', room: '', startedAt: 0, muted: false, videoOn: true, error: '',
  };
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
  private toastSeq = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private restorePromise: Promise<void> | null = null;
  /** Pushes that arrived while a thread page was still loading, keyed by cid. */
  private pendingPushes = new Map<string, UiMessage[]>();

  constructor() {
    this.applyTheme();
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

  groupName(gid: string | number): string {
    const key = roundedKey(gid);
    return this.state.groups.find((item) => roundedKey(item.group_id) === key)?.name ?? '';
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
      await this.enterWorkspace(saved.accessToken, saved.endpoint ?? '', saved.username ?? '');
    } catch {
      this.rest.clearTokens();
      sessionStorage.removeItem(SESSION_KEY);
      this.client?.close();
      this.client = null;
      this.set({ status: 'idle', connection: 'closed' });
    }
  }

  private async enterWorkspace(token: string, endpoint: string, username: string): Promise<void> {
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
        // A reconnect may have missed pushes: converge with 1601/1514.
        if (connection === 'reconnected') void this.runSync();
      },
      onPush: (event) => void this.handlePush(event),
      onKick: (event) => this.handleKick(event.reason),
    });

    const login = await this.client.open(token);
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
  }

  private persistSession(endpoint: string, username: string): void {
    const tokens = this.rest.tokens();
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ endpoint, username, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
    );
  }

  logout(): void {
    this.stopPolling();
    void this.client?.request(OP.LOGOUT, new Uint8Array(0), decodeOperationRes).catch(() => undefined);
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
    this.set({ activeCid: cid, tab: this.state.tab === 'friends' || this.state.tab === 'groups' ? 'conversations' : this.state.tab });
    const conversation = this.conversation(cid);
    if (!conversation) return;

    // Remember where the unread block starts before markRead clears it.
    const anchor = Number(conversation.read_seq ?? 0);
    if (anchor > 0) {
      this.set({ unreadAnchors: { ...this.state.unreadAnchors, [cid]: anchor } });
    }

    const existing = this.state.threads[cid];
    if (existing && existing.items.length > 0) return;

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
  async groupMembers(gid: string): Promise<GroupMember[]> {
    if (!this.client) throw new ImError(0, '连接未就绪');
    const res = await this.client.request(
      GROUP_OP.MEMBERS,
      encodeGroupMembersReq({ groupId: gid, limit: 200 }),
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
      return await this.rest.group(gid);
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

  private async refreshConversations(): Promise<void> {
    try {
      const items = await this.rest.conversations();
      const selfUid = this.state.me?.uid ?? '';
      this.set({ conversations: items.map((item) => normalizeConversation(item, selfUid)) });
    } catch {
      // ignore
    }
  }

  async createGroup(name: string, memberIds: string[]): Promise<string> {
    const res = await this.groupAction('创建群', (client) =>
      client.request(GROUP_OP.CREATE, encodeCreateGroupReq({ name, memberIds, groupType: 1 }), decodeCreateGroupRes));
    this.notify(`群「${res.payload.name || name}」已创建`);
    return res.payload.group_id;
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

  openGroup(group: Group): void {
    const gid = this.exactGroupId(String(group.group_id));
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
  async sendMessage(text: string): Promise<void> {
    const content = text.trim();
    if (!content) return;
    // A pending quote target turns the next text into a 1504 reply.
    if (this.state.quoteTarget) {
      await this.sendQuote(content);
      return;
    }
    await this.sendContent(1, JSON.stringify({ text: content }));
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

    this.notify(kind === 'image' ? '图片上传中…' : '附件上传中…');
    try {
      const uploaded = await this.rest.uploadFile({
        blob: file,
        name: file.name || 'attachment',
        mime,
        kind,
      });
      if (kind === 'image') {
        await this.sendImage(file);
        return;
      }
      const duration = await measureMedia(file, kind === 'voice' ? 'audio' : 'video');
      const msgType = kind === 'voice' ? 3 : kind === 'video' ? 4 : 5;
      const content = kind === 'voice'
        ? { url: uploaded.url, duration_ms: duration, size: uploaded.size, mime, name: file.name }
        : kind === 'video'
          ? { url: uploaded.url, duration_ms: duration, size: uploaded.size, mime, name: file.name }
          : { url: uploaded.url, name: file.name, size: uploaded.size, mime };
      await this.sendContent(msgType, JSON.stringify(content));
      this.notify(kind === 'voice' ? '语音已发送' : kind === 'video' ? '视频已发送' : '文件已发送');
    } catch (err) {
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

    this.notify('图片上传中…');
    try {
      const dimensions = await measureImage(file);
      const uploaded = await this.rest.uploadFile({
        blob: file,
        name: file.name || 'image.png',
        mime: file.type || 'image/png',
      });
      await this.sendContent(2, JSON.stringify({
        url: uploaded.url,
        width: dimensions.width,
        height: dimensions.height,
        size: uploaded.size,
        name: file.name,
      }));
    } catch (err) {
      this.notify(wrapError(err).display, 'error');
    }
  }

  /** Shared send path: optimistic draft, 1501/1502, then server truth. */
  private async sendContent(msgType: number, content: string): Promise<void> {
    const cid = this.state.activeCid;
    const conversation = this.conversation(cid);
    if (!conversation || !this.client) return;

    const draft: UiMessage = {
      server_msg_id: '',
      client_msg_id: crypto.randomUUID(),
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
    };

    const thread = this.state.threads[conversation.conversation_id] ?? emptyThread();
    this.patchThread(conversation.conversation_id, { items: [...thread.items, draft] });
    await this.deliver(draft, conversation);
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

  /** 1517: tells the other side that this user is typing (throttled to 3s). */
  notifyTyping(): void {
    const cid = this.state.activeCid;
    if (!cid || !this.client || this.state.connection !== 'open') return;
    const now = Date.now();
    if (this.lastTypingSentAt && now - this.lastTypingSentAt < 3000) return;
    this.lastTypingSentAt = now;
    void this.client
      .request(OP.TYPING, encodeTypingReq({ conversationId: cid, typing: true }), decodeOperationRes)
      .catch(() => undefined);
  }

  /** 1504: sends a reply that quotes the target message. */
  async sendQuote(text: string): Promise<void> {
    const target = this.state.quoteTarget;
    const conversation = this.conversation(this.state.activeCid);
    if (!target || !target.server_msg_id || !conversation || !this.client) return;
    const clientMsgId = crypto.randomUUID();
    const preview = messageText(target.content, target.msg_type).text.slice(0, 120);
    const content = JSON.stringify({
      text,
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
          content: JSON.stringify({ text }),
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

  /** 1503: forwards several messages as one chat-record card. */
  async mergeForward(serverMsgIds: string[], targetCid: string): Promise<void> {
    if (!this.client || serverMsgIds.length === 0) return;
    // Derive ids from the conversation id: REST group ids lose precision.
    const [kind, first, second] = targetCid.split('_');
    const selfUid = String(this.state.me?.uid ?? '');
    const groupId = kind === 'g' ? first : undefined;
    const recvId = kind === 's' ? (first === selfUid ? second : first) : undefined;
    if (!groupId && !recvId) {
      this.notify('转发目标无效', 'error');
      return;
    }
    try {
      await this.client.request(
        OP.MERGE,
        encodeMergeReq({
          clientMsgId: crypto.randomUUID(),
          recvId,
          groupId,
          serverMsgIds,
          title: '聊天记录',
        }),
        decodeMergeRes,
      );
      await this.refreshConversations();
      this.notify(`已合并转发 ${serverMsgIds.length} 条消息`);
    } catch (err) {
      this.notify(`合并转发失败：${wrapError(err).display}`, 'error');
    }
  }

  /** Forwards one message into another conversation (text or attachment). */
  async forwardMessage(message: UiMessage, targetCid: string): Promise<void> {
    const conversation = this.conversation(targetCid);
    if (!conversation || !this.client) return;
    if (!message.server_msg_id) {
      this.notify('消息尚未发送完成，无法转发', 'error');
      return;
    }
    try {
      const payload = conversation.type === 2
        ? encodeSendGroupReq({
          clientMsgId: crypto.randomUUID(),
          groupId: conversation.group_id,
          msgType: message.msg_type,
          content: message.content,
        })
        : encodeSendSingleReq({
          clientMsgId: crypto.randomUUID(),
          recvId: conversation.peer_id,
          msgType: message.msg_type,
          content: message.content,
        });
      await this.client.request(conversation.type === 2 ? OP.SEND_GROUP : OP.SEND_SINGLE, payload, decodeSendRes);
      await this.refreshConversations();
      this.notify('已转发');
    } catch (err) {
      this.notify(`转发失败：${wrapError(err).display}`, 'error');
    }
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
    if (event.opcode === OP.PUSH_FRIEND) {
      const update = decodeFriendEventPush(event.payload);
      if (update.kind === 1 && String(update.to_uid) === String(this.state.me?.uid ?? '')) {
        this.notify('收到新的好友申请');
      }
      void this.refreshRelations();
      return;
    }
    if (event.opcode === OP.PUSH_TYPING) {
      const update = decodeTypingPush(event.payload);
      if (update.conversation_id) {
        const next = { ...this.state.typing };
        if (update.typing) {
          next[update.conversation_id] = { uid: update.uid, until: Date.now() + 4000 };
          window.setTimeout(() => {
            const current = this.state.typing[update.conversation_id];
            if (current && current.until <= Date.now()) {
              const cleared = { ...this.state.typing };
              delete cleared[update.conversation_id];
              this.set({ typing: cleared });
            }
          }, 4200);
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
      // The peer hung up or cancelled: close the sheet on this side too.
      if (import.meta.env.DEV) console.debug(`[zim] remote end opcode=${event.opcode}`);
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
        // Ringing: the callee shows the incoming call sheet.
        this.set({
          call: {
            phase: 'incoming',
            callId: update.call_id,
            media: update.media === 2 ? 2 : 1,
            targetType: update.target_type === 2 ? 2 : 1,
            joinedElsewhere: false,
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
        break;
      case 2:
        // Answered by the peer (caller side) or auto-answered (family).
        if (this.state.call.callId !== update.call_id) return;
        if (this.state.call.phase === 'incoming') {
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
          this.set({
            call: {
              ...this.state.call,
              phase: 'active',
              participants,
              room: update.room || this.state.call.room,
              startedAt: this.state.call.startedAt || Date.now(),
            },
          });
        }
        break;
      case 3:
        this.notify('对方忙线中', 'error');
        void this.endCall('busy');
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
    const callId = crypto.randomUUID();
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
    this.set({
      call: {
        phase: 'outgoing',
        callId,
        media,
        targetType,
        joinedElsewhere: false,
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

    try {
      const res = await this.client.request(
        OP.CALL_INVITE,
        encodeCallInviteReq({ callId, targetType, targetId: peerId, media }),
        decodeCallInviteRes,
      );
      this.set({ call: { ...this.state.call, room: res.payload.room } });
      await this.joinCallRoom(callId, media === 2);
    } catch (err) {
      this.notify(`呼叫失败：${wrapError(err).display}`, 'error');
      await this.endCall('error');
    }
  }

  /** Accepts the ringing call and joins the SFU room. */
  async acceptCall(): Promise<void> {
    const call = this.state.call;
    if (call.phase !== 'incoming' || !this.client) return;
    this.set({ call: { ...call, phase: 'connecting' } });
    try {
      await this.client.request(OP.CALL_ANSWER, encodeCallAnswerReq({ callId: call.callId, accept: true }), decodeCallAnswer);
      if (import.meta.env.DEV) console.debug('[zim] call answered, fetching room token');
      await this.joinCallRoom(call.callId, call.media === 2);
      this.set({ call: { ...this.state.call, phase: 'active', startedAt: Date.now() } });
    } catch (err) {
      this.notify(`接听失败：${wrapError(err).display}`, 'error');
      await this.endCall('error');
    }
  }

  /** Rejects the ringing call. */
  async rejectCall(): Promise<void> {
    const call = this.state.call;
    if (call.phase !== 'incoming' || !this.client) return;
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

  /** Hangs up an active call (or cancels a ringing one). */
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
        OP.CALL_STATE,
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
    if (!token || !sfuUrl) throw new Error('SFU 未就绪');
    callSession.onTrack({
      onSpeakers: (uids) => {
        if (this.state.call.callId !== callId) return;
        this.set({ call: { ...this.state.call, speaking: uids } });
      },
    });
    await callSession.connect(sfuUrl, token, video);
    if (import.meta.env.DEV) console.debug('[zim] call media connected');
  }

  private async endCall(_reason: string): Promise<void> {
    await callSession.end().catch(() => undefined);
    this.set({
      call: {
        phase: 'idle', callId: '', media: 1, targetType: 1, joinedElsewhere: false, participants: [], speaking: [],
        peerId: '', peerName: '', room: '', startedAt: 0, muted: false, videoOn: true, error: '',
      },
    });
  }

  private friendProfile(uid: string): string {
    const friend = this.state.friends.find((item) => String(item.friend_id) === uid);
    return friend?.remark || friend?.profile?.nickname || friend?.profile?.username || `用户 ${uid}`;
  }

  private handleKick(reason: number): void {
    const reasons: Record<number, string> = {
      1: '账号在另一台设备登录',
      2: '管理员强制下线',
      3: '登录态已失效',
      4: '账号已被禁用',
    };
    this.notify(reasons[reason] ?? '已被强制下线', 'error');
    this.logout();
  }

  /** Re-marks the open conversation when the tab becomes visible again. */
  onVisible(): void {
    if (document.visibilityState !== 'visible') return;
    if (this.state.activeCid) void this.markRead(this.state.activeCid);
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
