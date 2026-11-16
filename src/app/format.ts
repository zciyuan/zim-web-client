import type { Conversation } from '../sdk/types';

const pad = (value: number): string => String(value).padStart(2, '0');

export const formatClock = (ms: string | number | undefined): string => {
  const date = new Date(Number(ms));
  if (!ms || Number.isNaN(date.getTime())) return '';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const formatListTime = (ms: number | undefined): string => {
  if (!ms) return '';
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return formatClock(ms);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const parseContent = (raw: string): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Exported for the renderer: image/file payloads are JSON objects. */
export const parseMessageContent = parseContent;

/** Image payload of a msg_type 2 message, if any. */
export const imageOf = (raw: string): { url: string; width: number; height: number } | null => {
  const parsed = parseContent(raw);
  if (!parsed || typeof parsed.url !== 'string' || parsed.url === '') return null;
  const width = typeof parsed.width === 'number' ? parsed.width : 0;
  const height = typeof parsed.height === 'number' ? parsed.height : 0;
  return { url: parsed.url, width, height };
};

/** Attachment payload of msg_type 3/4/5. */
export interface AttachmentInfo {
  url: string;
  name: string;
  size: number;
  mime: string;
  duration: number;
}

/** Reads the attachment of a voice/video/file message. */
export const attachmentOf = (raw: string): AttachmentInfo | null => {
  const parsed = parseContent(raw);
  if (!parsed || typeof parsed.url !== 'string' || parsed.url === '') return null;
  return {
    url: parsed.url,
    name: typeof parsed.name === 'string' ? parsed.name : '',
    size: typeof parsed.size === 'number' ? parsed.size : 0,
    mime: typeof parsed.mime === 'string' ? parsed.mime : '',
    duration: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : 0,
  };
};

/** Quote block embedded in a 1504 reply. */
export interface QuoteInfo {
  server_msg_id: string;
  send_id: string;
  text: string;
}

/** Reads the quote block of a reply, or null. */
export const quoteOf = (raw: string): QuoteInfo | null => {
  const parsed = parseContent(raw);
  const quote = parsed?.quote as Record<string, unknown> | undefined;
  if (!quote || typeof quote.text !== 'string') return null;
  return {
    server_msg_id: typeof quote.server_msg_id === 'string' ? quote.server_msg_id : '',
    send_id: quote.send_id === undefined ? '' : String(quote.send_id),
    text: quote.text,
  };
};

/** Merged chat-record card (op:1503). */
export interface MergeInfo {
  title: string;
  items: { server_msg_id: string; send_id: string; text: string }[];
}

/** One-line preview used by notifications and list subtitles. */
export const messagePreview = (raw: string, msgType: number): string => {
  const image = imageOf(raw);
  if (msgType === 2) return image ? '[图片]' : '[图片]';
  if (msgType === 3) return '[语音]';
  if (msgType === 4) return '[视频]';
  if (msgType === 5) return '[文件]';
  if (msgType === 20) return '[语音通话]';
  if (msgType === 21) return '[视频通话]';
  if (msgType === 22) return '[群通话]';
  const quote = quoteOf(raw);
  const body = quote ? quote.text : (() => {
    const { text } = messageText(raw, msgType);
    return text;
  })();
  return body.replace(/\s+/g, ' ').slice(0, 60);
};

/** Reads the merged card of a 1503 message, or null. */
export const mergeOf = (raw: string): MergeInfo | null => {
  const parsed = parseContent(raw);
  const merge = parsed?.merge as Record<string, unknown> | undefined;
  if (!merge || !Array.isArray(merge.items)) return null;
  const items = (merge.items as Record<string, unknown>[]).map((item) => ({
    server_msg_id: typeof item.server_msg_id === 'string' ? item.server_msg_id : '',
    send_id: item.send_id === undefined ? '' : String(item.send_id),
    text: typeof item.text === 'string' ? item.text : '',
  }));
  return { title: typeof merge.title === 'string' ? merge.title : '聊天记录', items };
};

/** Text to show inside a bubble. */
export const messageText = (raw: string, msgType: number): { text: string; system: boolean } => {
  if (msgType >= 20 && msgType <= 22) {
    const detail = parseContent(raw);
    const label = msgType === 20 ? '语音通话' : msgType === 21 ? '视频通话' : '群通话';
    const result = detail?.result === 'missed' ? '未接听' : detail?.duration ? `时长 ${String(detail.duration)}s` : '已结束';
    return { text: `${label} · ${result}`, system: true };
  }
  if (msgType === 1) {
    const parsed = parseContent(raw);
    if (parsed && typeof parsed.text === 'string') return { text: parsed.text, system: false };
    return { text: raw, system: false };
  }
  const labels: Record<number, string> = {
    2: '[图片]', 3: '[语音]', 4: '[视频]', 5: '[文件]', 6: '[位置]', 7: '[自定义消息]',
  };
  return { text: labels[msgType] ?? `[消息类型 ${msgType}]`, system: false };
};

export const previewConversation = (conversation: Conversation): string => {
  const brief = conversation.last_msg_brief ?? '';
  if (!brief) return '暂无消息';
  const parsed = parseContent(brief);
  if (parsed) {
    if (parsed.merge) return '[聊天记录]';
    if (parsed.call_id) return '[通话]';
    if (typeof parsed.width === 'number' && typeof parsed.url === 'string') return '[图片]';
    if (typeof parsed.url === 'string') return parsed.name ? `[文件] ${parsed.name}` : '[附件]';
    if (typeof parsed.text === 'string' && parsed.text) return parsed.text;
  }
  // The server may truncate the stored brief, leaving invalid JSON behind.
  const quoted = brief.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (quoted) return quoted[1].replace(/\\"/g, '"').replace(/\\n/g, ' ');
  if (brief.startsWith('{')) return '[消息]';
  return messageText(brief, 1).text || '[消息]';
};

const HUES = [232, 262, 198, 152, 24, 340, 288];

export const avatarHue = (seed: string | number): number => {
  let hash = 0;
  for (const char of String(seed)) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 997;
  return HUES[hash % HUES.length];
};

export const initialOf = (name: string): string => (name.trim().slice(0, 1) || '?').toUpperCase();

const ROLE_LABELS: Record<number, string> = { 0: '成员', 1: '管理员', 2: '群主', 3: '孩子', 4: '长辈' };

export const roleLabel = (role?: number): string =>
  role === undefined ? '' : ROLE_LABELS[role] ?? `角色 ${role}`;

/** Human-readable byte size (B/KB/MB). */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Media duration in mm:ss (0 -> 00:00). */
export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};
