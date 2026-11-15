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
