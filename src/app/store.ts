// Application store: owns the connection, the REST client and all UI state.
//
// Components subscribe through useIm(); every mutation replaces the state
// object so useSyncExternalStore sees a new snapshot.

import { useSyncExternalStore } from 'react';

import { IMClient, type ConnectionState, type PushEvent } from '../sdk/client';
import { ImError, wrapError } from '../sdk/errors';
import { directConversationId, groupConversationId, loadOlder, loadTail } from '../sdk/history';
import { measureImage } from './image';
import {
  OP,
  decodeMessageItem,
  decodeMyGroupsRes,
  decodeOperationRes,
  decodeReadReceiptRes,
  decodeSendRes,
  encodeMyGroupsReq,
  encodeReadReceiptReq,
  encodeSendGroupReq,
  encodeSendSingleReq,
} from '../sdk/messages';
import { IMHttp } from '../sdk/rest';
import type { Conversation, Friend, Group, GroupMember, MessageItem, UserProfile } from '../sdk/types';

const SESSION_KEY = 'zim.session';
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

export interface ImState {
  status: AppStatus;
  authError: string;
  connection: ConnectionState;
  me: Me | null;
  endpoint: string;
  tab: Tab;
  conversations: Conversation[];
  friends: Friend[];
  groups: Group[];
  activeCid: string | null;
  threads: Record<string, Thread>;
  toast: Toast | null;
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
  me: null,
  endpoint: localStorage.getItem(ENDPOINT_KEY) ?? '',
  tab: 'conversations',
  conversations: [],
  friends: [],
  groups: [],
  activeCid: null,
  threads: {},
  toast: null,
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
  private toastSeq = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private restorePromise: Promise<void> | null = null;

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
      onState: (connection) => {
        this.set({ connection: connection === 'reconnected' ? 'open' : connection });
        if (connection === 'offline') this.notify('连接已断开，自动重连已放弃，请刷新页面', 'error');
      },
      onPush: (event) => void this.handlePush(event),
      onKick: (event) => this.handleKick(event.reason),
    });

    const login = await this.client.open(token);
    // The REST client owns both tokens (login or refresh may have rotated them).
    this.persistSession(endpoint, username);

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
  }

  private persistSession(endpoint: string, username: string): void {
    const tokens = this.rest.tokens();
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ endpoint, username, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
    );
  }

  logout(): void {
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
    ]);
    const [me, friends, conversations, groups] = results;

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

  async openConversation(cid: string): Promise<void> {
    this.set({ activeCid: cid, tab: this.state.tab === 'friends' || this.state.tab === 'groups' ? 'conversations' : this.state.tab });
    const conversation = this.conversation(cid);
    if (!conversation) return;

    const existing = this.state.threads[cid];
    if (existing && existing.items.length > 0) return;

    this.patchThread(cid, { loading: true, error: '' });
    try {
      const { messages, hasMoreOlder } = await loadTail(this.rest, conversation, 40);
      this.patchThread(cid, { items: messages, loading: false, hasMoreOlder, error: '' });
      await this.markRead(cid);
    } catch (err) {
      this.patchThread(cid, { loading: false, error: wrapError(err).message });
    }
  }

  /** Group members, with nicknames resolved through the batch profile endpoint. */
  async groupMembers(gid: string): Promise<GroupMember[]> {
    const members = await this.rest.groupMembers(gid);
    const uids = members.map((member) => String(member.user_id)).filter(Boolean);
    if (uids.length === 0) return members;
    let profiles: UserProfile[] = [];
    try {
      profiles = await this.rest.users(uids);
    } catch {
      profiles = [];
    }
    const byUid = new Map(profiles.map((profile) => [String(profile.uid), profile]));
    return members.map((member) => {
      const profile = byUid.get(String(member.user_id));
      return { ...member, nickname: profile?.nickname, username: profile?.username };
    });
  }

  openFriend(friend: Friend): void {    const selfUid = this.state.me?.uid ?? '';
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
    this.set({ threads: { ...this.state.threads, [cid]: { ...current, ...patch } } });
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
    await this.sendContent(1, JSON.stringify({ text: content }));
  }

  /** Uploads an image then sends it as msg_type 2. */
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

  // ------------------------------------------------------------------ push --

  private async handlePush(event: PushEvent): Promise<void> {
    if (event.opcode !== OP.PUSH_MSG) return;

    let item: MessageItem;
    try {
      item = decodeMessageItem(event.payload);
    } catch {
      return;
    }
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
    if (thread && !thread.items.some((entry) => entry.server_msg_id === item.server_msg_id)) {
      this.patchThread(cid, { items: [...thread.items, { ...item, localState: 'sent' }] });
    }

    const active = this.state.activeCid === cid && document.visibilityState === 'visible';
    if (active) {
      await this.markRead(cid);
    } else if (String(item.send_id) !== String(this.state.me?.uid ?? '')) {
      this.patchConversation(cid, { unread: Number(this.conversation(cid)?.unread ?? 0) + 1 });
    }
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
