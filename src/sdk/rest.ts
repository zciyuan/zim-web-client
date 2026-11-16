// REST client for /v1 (ZIM-02 §3).
//
// Every call unwraps the {code, data, message, request_id} envelope and throws
// ImError on a non-zero code. Paths are relative by default so the dev proxy or
// the production gateway keeps the browser on one origin.

import { ImError, wrapError } from './errors';
import type {
  Conversation,
  Friend,
  Group,
  GroupMember,
  LoginSession,
  MessageItem,
  UserProfile,
} from './types';

interface Envelope<T> {
  code: number;
  data?: T;
  message?: string;
  request_id?: string;
}

export interface RestOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class IMHttp {
  private accessToken = '';
  private refreshToken = '';
  private refreshing: Promise<void> | null = null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RestOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  get token(): string {
    return this.accessToken;
  }

  tokens(): { accessToken: string; refreshToken: string } {
    return { accessToken: this.accessToken, refreshToken: this.refreshToken };
  }

  setTokens(tokens: { accessToken?: string; refreshToken?: string }): void {
    this.accessToken = tokens.accessToken ?? '';
    this.refreshToken = tokens.refreshToken ?? '';
  }

  clearTokens(): void {
    this.accessToken = '';
    this.refreshToken = '';
  }

  private url(path: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`, 'http://placeholder.local');
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return this.baseUrl ? url.toString() : `${url.pathname}${url.search}`;
  }

  private async send<T>(
    method: string,
    path: string,
    options: { params?: Record<string, string | number | undefined>; body?: unknown; retry?: boolean } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { 'X-Protocol': 'zim/1' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path, options.params), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw wrapError(new ImError(0, aborted ? '请求超时' : '网络异常，无法访问 zim-api', err));
    } finally {
      clearTimeout(timer);
    }

    let envelope: Envelope<T> | null = null;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      envelope = null;
    }

    if (response.status === 401 && options.retry !== false && this.refreshToken) {
      await this.refresh();
      return this.send<T>(method, path, { ...options, retry: false });
    }
    if (!envelope) throw new ImError(0, `HTTP ${response.status}：响应不是 JSON`);
    if (envelope.code !== 0) throw new ImError(envelope.code, envelope.message);
    return envelope.data as T;
  }

  private async refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      const data = await this.send<LoginSession>('POST', '/v1/auth/refresh', {
        body: { refresh_token: this.refreshToken },
        retry: false,
      });
      this.setTokens({ accessToken: data.access_token, refreshToken: data.refresh_token });
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  // ------------------------------------------------------------------ auth --

  async login(req: { username: string; password: string; platform?: number }): Promise<LoginSession> {
    const data = await this.send<LoginSession>('POST', '/v1/auth/token', {
      body: { username: req.username, password: req.password, platform: req.platform ?? 4 },
    });
    this.setTokens({ accessToken: data.access_token, refreshToken: data.refresh_token });
    return data;
  }

  /** POST /v1/auth/register — creates the account and returns a token pair. */
  async register(req: {
    username: string;
    password: string;
    nickname?: string;
    platform?: number;
  }): Promise<LoginSession> {
    const data = await this.send<LoginSession>('POST', '/v1/auth/register', {
      body: {
        username: req.username,
        password: req.password,
        nickname: req.nickname ?? '',
        platform: req.platform ?? 4,
      },
    });
    this.setTokens({ accessToken: data.access_token, refreshToken: data.refresh_token });
    return data;
  }

  // --------------------------------------------------------------- uploads --

  /** Resolves a server-relative path against the configured base. */
  absolute(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    if (!this.baseUrl) return pathOrUrl;
    return new URL(pathOrUrl, this.baseUrl).toString();
  }

  /** ZIM-02 §3.4: token -> presigned PUT -> immutable download URL. */
  async uploadFile(file: {
    blob: Blob;
    name: string;
    mime: string;
    kind?: 'image' | 'voice' | 'video' | 'file';
    /** progress callback (0-100); when present the PUT uses XHR. */
    onProgress?: (percent: number) => void;
  }): Promise<{ url: string; objectKey: string; size: number }> {
    const kind = file.kind
      ?? (file.mime.startsWith('image/') ? 'image' : file.mime.startsWith('audio/') ? 'voice' : 'file');
    const intent = await this.send<{
      object_key: string;
      upload_url: string;
      method: string;
      expires_in: number;
      download_url: string;
    }>('POST', '/v1/upload/token', {
      body: {
        file_type: kind,
        file_name: file.name,
        file_size: file.blob.size,
        mime: file.mime,
      },
    });

    const uploadUrl = this.absolute(intent.upload_url);
    const method = intent.method || 'PUT';
    if (file.onProgress && typeof XMLHttpRequest !== 'undefined') {
      await uploadWithProgress(uploadUrl, method, file.blob, file.mime, this.accessToken, file.onProgress);
    } else {
      const response = await this.fetchImpl(uploadUrl, {
        method,
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': file.mime },
        body: file.blob,
      });
      if (!response.ok) throw new ImError(0, `上传失败：HTTP ${response.status}`);
    }

    return { url: intent.download_url, objectKey: intent.object_key, size: file.blob.size };
  }

  // ----------------------------------------------------------------- users --

  me(): Promise<UserProfile> {
    return this.send<UserProfile>('GET', '/v1/users/me');
  }

  user(uid: string): Promise<UserProfile> {
    return this.send<UserProfile>('GET', `/v1/users/${encodeURIComponent(uid)}`);
  }

  searchUsers(keyword: string): Promise<UserProfile[]> {
    return this.send<{ users: UserProfile[] }>('GET', '/v1/users/search', { params: { q: keyword } })
      .then((data) => data.users ?? []);
  }

  users(uids: string[]): Promise<UserProfile[]> {
    if (uids.length === 0) return Promise.resolve([]);
    return this.send<{ users: UserProfile[] }>('GET', '/v1/users', { params: { uids: uids.join(',') } })
      .then((data) => data.users ?? []);
  }

  // -------------------------------------------------------------- relation --

  friends(): Promise<Friend[]> {
    return this.send<{ friends: Friend[] }>('GET', '/v1/friends').then((data) => data.friends ?? []);
  }

  addFriend(friendId: string, why = ''): Promise<void> {
    return this.send<{ ok: boolean }>('POST', '/v1/friends', { body: { friend_id: Number(friendId), why } })
      .then(() => undefined);
  }

  answerFriend(friendId: string, accept: boolean): Promise<void> {
    return this.send<{ ok: boolean }>('POST', '/v1/friend-requests/answer', {
      body: { friend_id: Number(friendId), accept },
    }).then(() => undefined);
  }

  deleteFriend(friendId: string): Promise<void> {
    return this.send<{ ok: boolean }>('DELETE', `/v1/friends/${encodeURIComponent(friendId)}`)
      .then(() => undefined);
  }

  updateRemark(friendId: string, remark: string): Promise<void> {
    return this.send<{ ok: boolean }>('PUT', `/v1/friends/${encodeURIComponent(friendId)}/remark`, {
      body: { remark },
    }).then(() => undefined);
  }

  pinFriend(friendId: string, pinned: boolean): Promise<void> {
    return this.send<{ ok: boolean }>('POST', `/v1/friends/${encodeURIComponent(friendId)}/pin`, {
      body: { pinned },
    }).then(() => undefined);
  }

  friendRequests(type: 'in' | 'out' = 'in'): Promise<unknown[]> {
    return this.send<{ requests: unknown[] }>('GET', '/v1/friend-requests', { params: { type } })
      .then((data) => data.requests ?? []);
  }

  blacklist(): Promise<UserProfile[]> {
    return this.send<{ users: UserProfile[] }>('GET', '/v1/blacklist').then((data) => data.users ?? []);
  }

  addBlack(uid: string): Promise<void> {
    return this.send<{ ok: boolean }>('POST', '/v1/blacklist', { body: { uid: Number(uid) } })
      .then(() => undefined);
  }

  removeBlack(uid: string): Promise<void> {
    return this.send<{ ok: boolean }>('DELETE', `/v1/blacklist/${encodeURIComponent(uid)}`)
      .then(() => undefined);
  }

  // --------------------------------------------------------- conversations --

  conversations(): Promise<Conversation[]> {
    return this.send<{ items: Conversation[] }>('GET', '/v1/conversations')
      .then((data) => data.items ?? []);
  }

  messages(
    conversationId: string,
    options: { beginSeq?: number; endSeq?: number; limit?: number } = {},
  ): Promise<{ messages: MessageItem[]; has_more: boolean }> {
    return this.send<{ messages: MessageItem[]; has_more: boolean }>(
      'GET',
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        params: {
          begin_seq: options.beginSeq ?? 0,
          end_seq: options.endSeq ?? 0,
          limit: options.limit ?? 30,
        },
      },
    );
  }

  unread(conversationId: string): Promise<number> {
    return this.send<{ unread: number }>(
      'GET',
      `/v1/conversations/${encodeURIComponent(conversationId)}/unread`,
    ).then((data) => data.unread);
  }

  markRead(conversationId: string, seq: number): Promise<number> {
    return this.send<{ read_seq: number }>(
      'POST',
      `/v1/conversations/${encodeURIComponent(conversationId)}/read`,
      { body: { seq } },
    ).then((data) => data.read_seq);
  }

  pinConversation(conversationId: string, pinned: boolean): Promise<void> {
    return this.send<{ ok: boolean }>(
      'POST',
      `/v1/conversations/${encodeURIComponent(conversationId)}/pin`,
      { body: { pinned } },
    ).then(() => undefined);
  }

  deleteConversation(conversationId: string): Promise<void> {
    return this.send<{ ok: boolean }>(
      'DELETE',
      `/v1/conversations/${encodeURIComponent(conversationId)}`,
    ).then(() => undefined);
  }

  // ---------------------------------------------------------------- groups --

  groups(): Promise<Group[]> {
    return this.send<{ groups: Group[] }>('GET', '/v1/groups').then((data) => data.groups ?? []);
  }

  group(gid: string): Promise<Group> {
    return this.send<Group>('GET', `/v1/groups/${encodeURIComponent(gid)}`);
  }

  groupMembers(gid: string): Promise<GroupMember[]> {
    return this.send<{ members: GroupMember[] }>('GET', `/v1/groups/${encodeURIComponent(gid)}/members`)
      .then((data) => data.members ?? []);
  }

  /** Pending join requests, for owners/admins. */
  groupApplies(gid: string, status = 0): Promise<unknown[]> {
    return this.send<{ applies: unknown[] }>('GET', `/v1/groups/${encodeURIComponent(gid)}/applies`, {
      params: { status },
    }).then((data) => data.applies ?? []);
  }
}

/** XHR-based upload so the UI can show a percentage. */
function uploadWithProgress(
  url: string,
  method: string,
  blob: Blob,
  mime: string,
  accessToken: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url, true);
    if (accessToken) request.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    request.setRequestHeader('Content-Type', mime);
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total === 0) return;
      onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      reject(new ImError(0, `上传失败：HTTP ${request.status}`));
    };
    request.onerror = () => reject(new ImError(0, '上传失败：网络错误'));
    request.ontimeout = () => reject(new ImError(0, '上传超时'));
    request.send(blob);
  });
}