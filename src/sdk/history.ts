// History paging on top of GET /v1/conversations/{cid}/messages.
//
// The cursor is forward-only (ZIM-02 §1.4): begin_seq/end_seq/limit always walk
// ascending and has_more means "there is something after this page". There is
// no desc/before_seq, so the tail is reached by opening a window near max_seq
// and walking forward inside it. Exact for dense conversations, and it skips
// nothing for sparse ones (a gap just yields fewer rows per page).

import type { IMHttp } from './rest';
import type { Conversation, MessageItem } from './types';

const PAGE = 100;
const MAX_PAGES = 6;

/** conversation_id convention: s_<minUid>_<maxUid> for direct, g_<gid> for group. */
export const directConversationId = (uid: string, peerId: string): string => {
  return `s_${uid < peerId ? uid : peerId}_${uid < peerId ? peerId : uid}`;
};

export const groupConversationId = (gid: string): string => `g_${gid}`;

const walk = async (
  http: IMHttp,
  conversationId: string,
  begin: number,
  stopAt: number,
  want: number,
): Promise<MessageItem[]> => {
  const collected: MessageItem[] = [];
  let cursor = begin;
  for (let page = 0; page < MAX_PAGES && collected.length < want; page += 1) {
    if (stopAt && cursor > stopAt) break;
    const res = await http.messages(conversationId, {
      beginSeq: cursor,
      endSeq: stopAt,
      limit: PAGE,
    });
    if (res.messages.length === 0) break;
    collected.push(...res.messages);
    cursor = Number(res.messages[res.messages.length - 1].seq) + 1;
    if (!res.has_more) break;
  }
  return collected;
};

/** Loads the newest `want` messages of a conversation. */
export const loadTail = async (
  http: IMHttp,
  conversation: Conversation,
  want = 40,
): Promise<{ messages: MessageItem[]; hasMoreOlder: boolean }> => {
  const maxSeq = Number(conversation.max_seq ?? 0);
  if (maxSeq <= 0) return { messages: [], hasMoreOlder: false };

  const windowStart = Math.max(1, maxSeq - want * 8);
  const messages = await walk(http, conversation.conversation_id, windowStart, maxSeq, want);
  const tail = messages.slice(-want);
  return { messages: tail, hasMoreOlder: tail.length > 0 && Number(tail[0].seq) > 1 };
};

/** Loads up to `want` messages older than oldestSeq. */
export const loadOlder = async (
  http: IMHttp,
  conversation: Conversation,
  oldestSeq: string,
  want = 30,
): Promise<{ messages: MessageItem[]; hasMoreOlder: boolean }> => {
  const oldest = Number(oldestSeq || 0);
  if (oldest <= 1) return { messages: [], hasMoreOlder: false };

  const stopAt = oldest - 1;
  const windowStart = Math.max(1, stopAt - want * 20);
  const scanned = await walk(http, conversation.conversation_id, windowStart, stopAt, want);
  const older = scanned.filter((item) => Number(item.seq) < oldest).slice(-want);
  return { messages: older, hasMoreOlder: older.length > 0 && Number(older[0].seq) > 1 };
};
