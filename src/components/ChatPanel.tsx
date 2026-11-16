import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';

import { Avatar } from './Avatar';
import { EmojiPicker } from './EmojiPicker';
import { GroupSettingsDialog } from './GroupSettingsDialog';
import { errorText, imStore, useIm, type UiMessage } from '../app/store';
import { atOf, attachmentOf, formatBytes, formatDuration, mentionsUser, mergeOf, quoteOf, uploadOf } from '../app/format';
import { daySeparator, formatClock, imageOf, messageText } from '../app/format';

const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '😮', '🙏'];

/** Renders "@name" tokens as mentions and one search keyword as <mark>. */
/** Splits message text into plain runs, links, emails and mentions. */
const TOKEN_PATTERN = /(https?:\/\/[^\s<>"']+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|@[^\s@]+)/g;

/** Renders links, emails and "@name" tokens, plus one search keyword as <mark>. */
function MentionText({ text, highlight }: { text: string; highlight?: string }) {
  const parts = text.split(TOKEN_PATTERN).filter((part) => part !== '');
  const marked = (chunk: string, key: number) => {
    if (!highlight || !chunk.toLowerCase().includes(highlight.toLowerCase())) {
      return <span key={key}>{chunk}</span>;
    }
    const index = chunk.toLowerCase().indexOf(highlight.toLowerCase());
    return (
      <span key={key}>
        {chunk.slice(0, index)}
        <mark data-highlight className="rounded bg-amber-200 px-0.5 text-slate-900 dark:bg-amber-500/50 dark:text-slate-100">
          {chunk.slice(index, index + highlight.length)}
        </mark>
        {chunk.slice(index + highlight.length)}
      </span>
    );
  };
  return (
    <>
      {parts.map((part, index) => {
        if (/^https?:\/\//i.test(part)) {
          // Sentence punctuation belongs to the text, not to the URL.
          const trailing = part.match(/[.,;:!?)\]}]+$/)?.[0] ?? '';
          const url = trailing ? part.slice(0, -trailing.length) : part;
          return (
            <span key={index}>
              <a
                href={url}
                data-link
                target="_blank"
                rel="noreferrer noopener"
                className="text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-500 dark:text-indigo-400"
                onClick={(event) => event.stopPropagation()}
              >
                {url}
              </a>
              {trailing}
            </span>
          );
        }
        if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(part)) {
          return (
            <a
              key={index}
              href={`mailto:${part}`}
              data-mail
              className="text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-500 dark:text-indigo-400"
              onClick={(event) => event.stopPropagation()}
            >
              {part}
            </a>
          );
        }
        if (part.startsWith('@') && part.length > 1) {
          return <span key={index} data-mention className="font-medium text-indigo-600 dark:text-indigo-400">{part}</span>;
        }
        return marked(part, index);
      })}
    </>
  );
}

function Bubble({
  message,
  mine,
  showSender,
  senderName,
  onForward,
  selectable,
  selected,
  onSelect,
  onPreviewImage,
  onMenu,
  autoEdit,
  canRetryUpload,
  onRetryUpload,
  highlight,
}: {
  message: UiMessage;
  mine: boolean;
  showSender: boolean;
  senderName: string;
  onForward?: (message: UiMessage) => void;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onPreviewImage?: (url: string) => void;
  onMenu?: (message: UiMessage, x: number, y: number) => void;
  autoEdit?: boolean;
  canRetryUpload?: boolean;
  onRetryUpload?: () => void;
  highlight?: string;
}) {
  const image = message.msg_type === 2 ? imageOf(message.content) : null;
  const attachment = message.msg_type >= 3 && message.msg_type <= 5 ? attachmentOf(message.content) : null;
  const { text, system } = messageText(message.content, message.msg_type);
  const quote = quoteOf(message.content);
  const merge = mergeOf(message.content);
  const state = message.localState ?? 'sent';
  // Long-press opens the same menu as right-click on touch devices.
  const pressTimer = useRef<number | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  const cancelPress = () => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressOrigin.current = null;
  };
  const canManage = mine && state === 'sent' && Boolean(message.server_msg_id)
    && message.status !== 1 && message.status !== 2;
  const atUids = message.at_user_ids?.length ? message.at_user_ids.map(String) : atOf(message.content);
  const atMe = !mine && mentionsUser(message.content, String(imStore.me?.uid ?? ''), imStore.me?.name, atUids);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageKey, setImageKey] = useState(0);

  // The context menu's 「编辑」 opens this bubble's inline editor.
  useEffect(() => {
    if (!autoEdit) return;
    setDraft(text);
    setEditing(true);
  }, [autoEdit, text]);

  const openImage = () => {
    if (!image) return;
    const url = imStore.assetUrl(image.url);
    // Prefer the in-app lightbox; fall back to a new tab when unavailable.
    if (onPreviewImage) onPreviewImage(url);
    else window.open(url, '_blank', 'noopener');
  };

  // Inline editor: native window.prompt is unreliable in embedded/headless
  // browsers and blocks the page, so editing happens inside the bubble.
  const startEdit = () => {
    setDraft(text);
    setEditing(true);
  };

  const commitEdit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next !== '' && next !== text) {
      void imStore.editMessage(message, JSON.stringify({ text: next }));
    }
  };

  const startDelete = () => {
    if (window.confirm('删除这条消息？双方都会看到「已删除」')) void imStore.deleteMessage(message);
  };

  const startRecall = () => {
    if (window.confirm('撤回这条消息？')) void imStore.recallMessage(message);
  };

  return (
    <div
      className={`message-enter group flex max-w-[82%] gap-2 ${mine ? 'flex-row-reverse self-end' : 'self-start'}`}
      data-state={state}
      data-mine={mine ? 'true' : 'false'}
      data-msg-type={message.msg_type}
      data-msg-id={message.server_msg_id}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu?.(message, event.clientX, event.clientY);
      }}
      onTouchStart={(event) => {
        const touch = event.touches[0];
        if (!touch || !onMenu) return;
        pressOrigin.current = { x: touch.clientX, y: touch.clientY };
        pressTimer.current = window.setTimeout(() => {
          onMenu(message, touch.clientX, touch.clientY);
          pressTimer.current = null;
        }, 500);
      }}
      onTouchMove={(event) => {
        const origin = pressOrigin.current;
        const touch = event.touches[0];
        if (!origin || !touch) return;
        if (Math.abs(touch.clientX - origin.x) > 12 || Math.abs(touch.clientY - origin.y) > 12) {
          cancelPress();
        }
      }}
      onTouchEnd={cancelPress}
      onTouchCancel={cancelPress}
    >
      <Avatar name={senderName} seed={message.send_id} size={30} />
      <div className="min-w-0">
        <div className={`mb-0.5 flex items-baseline gap-1.5 text-[11px] text-slate-400 ${mine ? 'justify-end' : ''}`}>
          {showSender && !mine ? <span>{senderName}</span> : null}
          <span>{formatClock(message.send_time)}</span>
          {atMe ? (
            <span data-at-me-badge className="rounded bg-rose-100 px-1 text-[10px] font-medium text-rose-600 dark:bg-rose-950 dark:text-rose-300">
              有人@我
            </span>
          ) : null}
        </div>
        {typeof message.progress === 'number' ? (
          <div
            data-upload-progress={message.progress}
            className={`w-56 rounded-2xl border px-3 py-2 ${
              mine ? 'border-indigo-500 bg-indigo-600/10' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'
            }`}
          >
            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
              <span className="truncate">{uploadOf(message.content)?.name ?? '上传中'}</span>
              <span>{message.progress}%</span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
              <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${message.progress}%` }} />
            </div>
          </div>
        ) : image ? (
          <button
            type="button"
            data-image-bubble="true"
            onClick={openImage}
            className={`block overflow-hidden rounded-2xl border p-1 transition hover:opacity-90 ${
              mine ? 'border-indigo-500 bg-indigo-600/10' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'
            } ${state === 'sending' ? 'opacity-60' : ''} ${
              state === 'failed' ? 'border-rose-400 bg-transparent' : ''
            }`}
          >
            {imageFailed ? (
              <span data-image-error className="flex h-24 w-56 flex-col items-center justify-center gap-1 text-[11px] text-slate-500">
                图片加载失败
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    setImageFailed(false);
                    setImageKey((current) => current + 1);
                  }}
                  onKeyDown={() => undefined}
                  className="cursor-pointer text-indigo-600 underline"
                >
                  重试
                </span>
              </span>
            ) : (
              <img
                key={imageKey}
                src={imStore.assetUrl(image.url)}
                alt="图片消息"
                loading="lazy"
                onError={() => setImageFailed(true)}
                className="max-h-[240px] max-w-[280px] rounded-xl object-cover"
              />
            )}
            {image.width > 0 && image.height > 0 ? (
              <span className="mt-1 block text-[10px] text-slate-400">
                {image.width}×{image.height}
              </span>
            ) : null}
          </button>
        ) : attachment ? (
          <div
            className={`overflow-hidden rounded-2xl border ${
              mine ? 'border-indigo-500 bg-indigo-600/10' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'
            } ${state === 'sending' ? 'opacity-60' : ''}`}
          >
            {message.msg_type === 3 ? (
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="text-lg">🎤</span>
                <audio controls preload="metadata" src={imStore.assetUrl(attachment.url)} className="h-8 max-w-[220px]" />
                <span className="text-[11px] text-slate-400">{formatDuration(attachment.duration)}</span>
              </div>
            ) : message.msg_type === 4 ? (
              <video
                controls
                preload="metadata"
                poster={attachment.poster || undefined}
                src={imStore.assetUrl(attachment.url)}
                className="max-h-[260px] max-w-[320px] rounded-xl"
              />
            ) : (
              <a
                href={imStore.assetUrl(attachment.url)}
                download={attachment.name || undefined}
                target="_blank"
                rel="noreferrer"
                className="flex max-w-[280px] items-center gap-2 px-3 py-2 hover:opacity-90"
              >
                <span className="text-xl">📎</span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{attachment.name || '附件'}</span>
                  <span className="block text-[11px] text-slate-400">{formatBytes(attachment.size)}</span>
                </span>
              </a>
            )}
          </div>
        ) : (
          <div
            className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
              system
                ? 'border border-dashed border-slate-300 bg-transparent text-xs text-slate-500 dark:border-slate-700'
                : mine
                  ? 'bg-indigo-600 text-white'
                  : 'border border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
            } ${state === 'sending' ? 'opacity-60' : ''} ${
              state === 'failed' ? 'border-rose-400 bg-transparent text-rose-600' : ''
            }`}
          >
            {editing ? (
              <div className="flex flex-col gap-1">
                <textarea
                  aria-label="编辑消息"
                  autoFocus
                  value={draft}
                  rows={Math.min(4, Math.max(1, draft.split('\n').length))}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      commitEdit();
                    }
                    if (event.key === 'Escape') setEditing(false);
                  }}
                  className="min-w-[180px] resize-none rounded-lg border border-indigo-300 bg-white px-2 py-1 text-sm text-slate-900 outline-none dark:border-indigo-700 dark:bg-slate-900 dark:text-slate-100"
                />
                <span className="flex items-center justify-end gap-2 text-[11px]">
                  <button type="button" className="underline" onClick={() => setEditing(false)}>
                    取消
                  </button>
                  <button type="button" className="font-medium underline" onClick={commitEdit}>
                    保存
                  </button>
                </span>
              </div>
            ) : merge ? (
              <details className="min-w-[200px]">
                <summary className="cursor-pointer text-sm">
                  📄 {merge.title} · {merge.items.length} 条
                </summary>
                <ol className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-[11px] opacity-80">
                  {merge.items.map((item, index) => (
                    <li key={item.server_msg_id || index} className="truncate">
                      {index + 1}. {item.text}
                    </li>
                  ))}
                </ol>
              </details>
            ) : (
              message.status === 2
                ? '该消息已删除'
                : (
                  <>
                    <span className={!expanded && text.length > 400 ? 'line-clamp-6' : ''}>
                      <MentionText text={text} highlight={highlight} />
                    </span>
                    {text.length > 400 ? (
                      <button
                        type="button"
                        data-expand-message
                        onClick={() => setExpanded((current) => !current)}
                        className="mt-1 block text-[11px] text-indigo-600 underline dark:text-indigo-400"
                      >
                        {expanded ? '收起' : '展开全文'}
                      </button>
                    ) : null}
                  </>
                )
            )}
          </div>
        )}
        {selectable ? (
          <label className={`mt-1 flex items-center gap-1 text-[11px] ${mine ? 'justify-end' : ''}`}>
            <input type="checkbox" checked={Boolean(selected)} onChange={() => onSelect?.()} aria-label="选择消息" />
            <span>选择</span>
          </label>
        ) : null}
        {state === 'failed' ? (
          <div className="mt-0.5 text-right text-[11px] text-rose-600">
            {canRetryUpload ? '上传失败' : '发送失败'}{' '}
            <button
              type="button"
              data-retry-upload={canRetryUpload ? 'true' : 'false'}
              className="text-indigo-600 underline"
              onClick={() => (canRetryUpload ? onRetryUpload?.() : void imStore.retryMessage(message))}
            >
              {canRetryUpload ? '重试上传' : '重试'}
            </button>
          </div>
        ) : null}
        {quote ? (
          <div className="mb-1 rounded-lg border-l-2 border-indigo-400 bg-slate-100 px-2 py-1 text-[11px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <span className="line-clamp-2">{quote.text}</span>
          </div>
        ) : null}
        <div className={`mt-0.5 hidden items-center gap-2 text-[11px] text-slate-400 group-hover:flex ${mine ? 'justify-end' : ''}`}>
          {canManage && message.msg_type === 1 ? (
            <button type="button" className="hover:text-indigo-600" onClick={startEdit}>编辑</button>
          ) : null}
          {canManage ? (
            <button type="button" className="hover:text-rose-600" onClick={startDelete}>删除</button>
          ) : null}
          {canManage ? (
            <button type="button" className="hover:text-amber-600" onClick={startRecall}>撤回</button>
          ) : null}
          <button
            type="button"
            className="hover:text-indigo-600"
            onClick={() => void navigator.clipboard?.writeText(text)}
          >
            复制
          </button>
          <button type="button" className="hover:text-indigo-600" onClick={() => imStore.setQuoteTarget(message)}>
            引用
          </button>
          <button type="button" className="hover:text-indigo-600" onClick={() => onForward?.(message)}>
            转发
          </button>
          <span className="flex items-center gap-1">
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`回应 ${emoji}`}
                className="hover:scale-110"
                onClick={() => void imStore.toggleReaction(message, emoji)}
              >
                {emoji}
              </button>
            ))}
          </span>
        </div>
        {(message.reactions ?? []).length > 0 ? (
          <div className={`mt-1 flex flex-wrap gap-1 ${mine ? 'justify-end' : ''}`}>
            {(message.reactions ?? []).map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                onClick={() => void imStore.toggleReaction(message, reaction.emoji)}
                className={`rounded-full border px-1.5 py-0.5 text-[11px] transition ${
                  reaction.mine
                    ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:bg-indigo-950'
                    : 'border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                }`}
              >
                {reaction.emoji} {reaction.count}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Composer({ disabled }: { disabled: boolean }) {
  const state = useIm();
  const quote = state.quoteTarget;
  const [value, setValue] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [recording, setRecording] = useState<{ recorder: MediaRecorder; chunks: Blob[]; startedAt: number } | null>(null);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);

  // Restore the draft of the conversation being opened.
  useEffect(() => {
    setValue(imStore.draftOf(state.activeCid));
    setMentionQuery(null);
  }, [state.activeCid]);
  const [mentions, setMentions] = useState<{ uid: string; name: string }[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const conversation = state.conversations.find((item) => item.conversation_id === state.activeCid);
  const isGroupChat = conversation?.type === 2;
  const [mentionMembers, setMentionMembers] = useState<{ uid: string; name: string }[]>([]);

  // Load group members the first time the mention picker is needed.
  useEffect(() => {
    if (!mentionQuery || !isGroupChat || !conversation?.group_id) return;
    if (mentionMembers.length > 0) return;
    const gid = conversation.conversation_id.startsWith('g_')
      ? conversation.conversation_id.slice(2)
      : String(conversation.group_id);
    void imStore.groupMembers(gid)
      .then((members) => {
        setMentionMembers(members.map((member) => ({
          uid: String(member.user_id),
          name: imStore.senderName(String(member.user_id)),
        })));
      })
      .catch(() => setMentionMembers([]));
  }, [mentionQuery, isGroupChat, conversation?.group_id, mentionMembers.length]);

  // Prefer real group members; fall back to the friend list when the member
  // RPC returns nothing (legacy groups may have no member rows to read).
  const mentionPool = mentionMembers.length > 0
    ? mentionMembers
    : state.friends.map((friend) => ({
      uid: String(friend.friend_id),
      name: imStore.friendName(String(friend.friend_id)),
    }));
  const mentionCandidates = (() => {
    if (mentionQuery === null) return [] as { uid: string; name: string }[];
    const needle = mentionQuery.toLowerCase();
    const members = mentionPool
      .filter((member) => !needle || member.name.toLowerCase().includes(needle) || member.uid.includes(needle));
    // "@所有人" is offered first in group chats.
    const all = isGroupChat && (!needle || '所有人'.includes(needle) || 'all'.includes(needle))
      ? [{ uid: 'all', name: '所有人' }]
      : [];
    return [...all, ...members].slice(0, 7);
  })();

  const pickMention = (member: { uid: string; name: string }) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@[^@\s]*$/, '');
    const after = value.slice(caret);
    setValue(`${before}@${member.name} ${after}`);
    setMentions((current) => (current.some((item) => item.uid === member.uid)
      ? current
      : [...current, member]));
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      const next = before.length + member.name.length + 2;
      el?.setSelectionRange(next, next);
    });
  };

  // Voice messages: record in the browser, then upload like any attachment.
  const startRecording = async () => {
    if (disabled) {
      imStore.notify('连接断开，无法录音', 'error');
      return;
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      imStore.notify('当前浏览器不支持录音', 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.start();
      setRecordSeconds(0);
      setRecording({ recorder, chunks, startedAt: Date.now() });
    } catch {
      imStore.notify('麦克风不可用，请检查浏览器权限', 'error');
    }
  };

  const stopRecording = async (keep: boolean) => {
    const current = recording;
    if (!current) return;
    setRecording(null);
    const { recorder, chunks, startedAt } = current;
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    recorder.stream.getTracks().forEach((track) => track.stop());
    if (!keep) return;
    if (Date.now() - startedAt < 500) {
      imStore.notify('录音太短，已取消');
      return;
    }
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    if (blob.size === 0) {
      imStore.notify('没有录到声音', 'error');
      return;
    }
    const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type });
    await imStore.sendAttachment(file);
  };

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      setRecordSeconds(Math.floor((Date.now() - recording.startedAt) / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  const send = () => {
    const text = value.trim();
    if (!text) return;
    if (disabled) {
      // Never drop a typed message silently: keep the text and say why.
      imStore.notify('连接未就绪，消息未发送', 'error');
      return;
    }
    const mentioned = mentions
      .filter((item) => text.includes(`@${item.name}`))
      .map((item) => item.uid);
    setValue('');
    imStore.setDraft(state.activeCid ?? '', '');
    setMentions([]);
    setMentionQuery(null);
    if (inputRef.current) inputRef.current.style.height = 'auto';
    void imStore.sendMessage(text, mentioned);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    setValue((current) => current.slice(0, start) + emoji + current.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      const caret = start + emoji.length;
      el?.setSelectionRange(caret, caret);
    });
  };

  const pickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.type.startsWith('image/')) void imStore.sendImage(file);
    else void imStore.sendAttachment(file);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    const image = files.find((file) => file.type.startsWith('image/'));
    if (!image) return;
    event.preventDefault();
    void imStore.sendImage(image);
  };

  return (
    <form
      onSubmit={submit}
      className="relative flex items-end gap-2 border-t border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900"
    >
      {emojiOpen ? <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} /> : null}

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setEmojiOpen((open) => !open)}
          className="grid h-9 w-9 place-items-center rounded-xl text-lg transition hover:bg-slate-100 dark:hover:bg-slate-800"
          title="表情"
          aria-label="表情"
        >
          😊
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="grid h-9 w-9 place-items-center rounded-xl text-lg transition hover:bg-slate-100 dark:hover:bg-slate-800"
          title="发送图片或附件"
          aria-label="发送附件"
        >
          🖼️
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,audio/*,video/*,.pdf,.zip,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv"
          className="hidden"
          onChange={pickFile}
          aria-label="选择附件"
        />
        <button
          type="button"
          onClick={() => (recording ? void stopRecording(true) : void startRecording())}
          disabled={disabled && !recording}
          aria-label="录制语音"
          aria-pressed={Boolean(recording)}
          title={recording ? '结束并发送语音' : '录制语音消息'}
          className={`grid h-9 w-9 place-items-center rounded-xl text-lg transition disabled:opacity-40 ${
            recording
              ? 'bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-300'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
        >
          {recording ? '⏹' : '🎙️'}
        </button>
      </div>

      {recording ? (
        <div
          data-recording="true"
          className="mx-2 mb-1 flex items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-600 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" />
          <span data-record-seconds={recordSeconds}>
            录音中 {Math.floor(recordSeconds / 60)}:{String(recordSeconds % 60).padStart(2, '0')}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => void stopRecording(true)}
            className="rounded-lg bg-rose-600 px-2.5 py-0.5 font-medium text-white"
          >
            发送
          </button>
          <button
            type="button"
            onClick={() => void stopRecording(false)}
            className="rounded-lg border border-rose-300 px-2.5 py-0.5 dark:border-rose-800"
          >
            取消
          </button>
        </div>
      ) : null}

      {mentionQuery !== null && mentionCandidates.length > 0 ? (
        <div
          data-mention-picker="true"
          className="mx-2 mb-1 max-h-40 w-56 overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <p className="px-2.5 py-1 text-[11px] text-slate-400">选择要提醒的成员</p>
          {mentionCandidates.map((member) => (
            <button
              key={member.uid}
              type="button"
              data-mention-option={member.uid}
              onClick={() => pickMention(member)}
              className="block w-full truncate px-2.5 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              {member.name}
              <span className="ml-1 text-[10px] text-slate-400">{member.uid}</span>
            </button>
          ))}
        </div>
      ) : null}

      {quote ? (
        <div className="mx-2 mb-1 flex items-start gap-2 rounded-lg border-l-2 border-indigo-400 bg-slate-100 px-2 py-1 text-[11px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          <span className="line-clamp-2 flex-1" data-quote-preview>
            引用：{messageText(quote.content, quote.msg_type).text}
          </span>
          <button type="button" aria-label="取消引用" className="shrink-0" onClick={() => imStore.setQuoteTarget(null)}>
            ×
          </button>
        </div>
      ) : null}

      <textarea
        ref={inputRef}
        value={value}
        rows={1}
        maxLength={4000}
        placeholder="输入消息，Enter 发送，Shift+Enter 换行，可直接粘贴图片"
        onChange={(event) => {
          setValue(event.target.value);
          imStore.setDraft(state.activeCid ?? '', event.target.value);
          if (event.target.value.trim() !== '') imStore.notifyTyping();
          // "@" opens the member picker inside group chats.
          const caret = event.target.selectionStart ?? event.target.value.length;
          const before = event.target.value.slice(0, caret);
          const match = isGroupChat ? before.match(/@([^@\s]*)$/) : null;
          setMentionQuery(match ? match[1] : null);
          const el = event.currentTarget;
          el.style.height = 'auto';
          el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="max-h-[140px] flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
      />
      <button
        type="submit"
        disabled={disabled}
        className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
      >
        发送
      </button>
    </form>
  );
}

export function ChatPanel() {
  const state = useIm();
  const [membersOpen, setMembersOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<UiMessage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [forwardTarget, setForwardTarget] = useState<UiMessage | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mergePending, setMergePending] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [swipeX, setSwipeX] = useState(0);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ message: UiMessage; x: number; y: number } | null>(null);
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [forwardTargets, setForwardTargets] = useState<string[]>([]);

  // Global search / quote jump: scroll the target message into view and flash it.
  useEffect(() => {
    const id = state.focusMessageId;
    if (!id) return;
    const element = document.querySelector(`[data-msg-id="${id}"]`);
    if (!element) return;
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    element.classList.add('zim-flash');
    const timer = window.setTimeout(() => element.classList.remove('zim-flash'), 1600);
    return () => window.clearTimeout(timer);
  }, [state.focusMessageId]);

  // Escape closes the image lightbox (keyboard access parity with the X button).
  useEffect(() => {
    if (!previewImage) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewImage(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewImage]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const conversation = useMemo(
    () => state.conversations.find((item) => item.conversation_id === state.activeCid),
    [state.conversations, state.activeCid],
  );
  const thread = state.activeCid ? state.threads[state.activeCid] : undefined;
  const isGroup = conversation?.type === 2;
  // Group announcement (group.notification): shown as a banner in group chats.
  const groupNotice = (() => {
    if (!isGroup || !state.activeCid?.startsWith('g_')) return '';
    const gid = state.activeCid.slice(2);
    return (state.groupNotices[gid] ?? imStore.groupOf(gid)?.notification ?? '').trim();
  })();

  // Read indicator for direct chats: compare my last message seq with the
  // peer's watermark delivered by 1906.
  const readState = (() => {
    if (!conversation || isGroup) return null;
    const items = thread?.items ?? [];
    const mine = [...items].reverse().find(
      (item) => String(item.send_id) === String(state.me?.uid ?? '') && item.server_msg_id,
    );
    if (!mine) return null;
    const peerSeq = state.peerReads[conversation.conversation_id] ?? 0;
    return { read: peerSeq >= Number(mine.seq) };
  })();

  const runSearch = async () => {
    if (!conversation || !keyword.trim()) return;
    imStore.rememberSearch(keyword);
    setSearching(true);
    try {
      setResults(await imStore.searchMessages(conversation.conversation_id, keyword.trim()));
    } catch (err) {
      imStore.notify(errorText(err), 'error');
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  // Only auto-scroll when the reader is already at the bottom, so history
  // browsing is not interrupted by incoming messages.
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [state.activeCid, thread?.items.length]);

  if (!conversation) {
    return (
      <section className="flex min-w-0 flex-1 flex-col bg-slate-100 max-md:hidden dark:bg-slate-950">
        <div className="grid flex-1 place-items-center text-sm text-slate-500">选择一个会话开始聊天</div>
      </section>
    );
  }

  const title = imStore.conversationTitle(conversation);
  const typingUntil = state.typing[conversation?.conversation_id ?? '']?.until ?? 0;
  const subtitle = typingUntil > Date.now()
    ? (isGroup ? '有人正在输入…' : '对方正在输入…')
    : isGroup
      ? `群 ${conversation.group_id} · 会话 ${conversation.conversation_id}`
      : `用户 ${conversation.peer_id} · 会话 ${conversation.conversation_id}`;

  return (
    <section
      className="relative flex min-w-0 flex-1 flex-col bg-slate-100 dark:bg-slate-950"
      aria-label="聊天"
      style={swipeX > 0 ? { transform: `translateX(${swipeX}px)`, transition: 'transform 120ms ease-out' } : undefined}
      onTouchStart={(event) => {
        const touch = event.touches[0];
        swipeStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
      }}
      onTouchMove={(event) => {
        const start = swipeStart.current;
        const touch = event.touches[0];
        if (!start || !touch) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        // Swipe right on narrow screens returns to the list (mobile back).
        if (window.innerWidth < 768 && dx > 20 && Math.abs(dy) < 40) {
          setSwipeX(Math.min(dx, 120));
        }
      }}
      onTouchEnd={() => {
        const start = swipeStart.current;
        swipeStart.current = null;
        if (start && swipeX > 90) imStore.clearActive();
        setSwipeX(0);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const files = Array.from(event.dataTransfer?.files ?? []);
        for (const file of files) {
          if (file.type.startsWith('image/')) void imStore.sendImage(file);
          else void imStore.sendAttachment(file);
        }
      }}
    >
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => imStore.clearActive()}
            className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-500 md:hidden dark:border-slate-700"
          >
            ←
          </button>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
            <p className="truncate text-[11px] text-slate-500" data-typing={typingUntil > Date.now() ? 'true' : 'false'}>
              {subtitle}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {conversation ? (
            <>
              <button
                type="button"
                aria-label="语音通话"
                data-rtc-support={imStore.rtcSupport.supported ? 'ok' : imStore.rtcSupport.reason}
                title={imStore.rtcSupport.supported ? '发起语音通话' : imStore.rtcSupport.detail}
                onClick={() => void imStore.startCall(1)}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 transition hover:border-indigo-400 dark:border-slate-700"
              >
                语音
              </button>
              <button
                type="button"
                aria-label="视频通话"
                data-rtc-support={imStore.rtcSupport.supported ? 'ok' : imStore.rtcSupport.reason}
                title={imStore.rtcSupport.supported ? '发起视频通话' : imStore.rtcSupport.detail}
                onClick={() => void imStore.startCall(2)}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 transition hover:border-indigo-400 dark:border-slate-700"
              >
                视频
              </button>
            </>
          ) : null}
          <button
            type="button"
            aria-label="导出聊天记录"
            onClick={() => conversation && imStore.exportConversation(conversation.conversation_id)}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 transition hover:border-indigo-400 dark:border-slate-700"
          >
            导出
          </button>
          <button
            type="button"
            aria-label="消息搜索"
            onClick={() => setSearchOpen((open) => !open)}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 transition hover:border-indigo-400 dark:border-slate-700"
          >
            搜索
          </button>
          <button
            type="button"
            aria-label="多选消息"
            onClick={() => {
              setSelectMode((on) => !on);
              setSelectedIds([]);
            }}
            className={`rounded-lg border px-2.5 py-1 text-xs transition ${
              selectMode
                ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:bg-indigo-950'
                : 'border-slate-200 text-slate-500 hover:border-indigo-400 dark:border-slate-700'
            }`}
          >
            多选
          </button>
          {isGroup ? (
            <button
              type="button"
              onClick={() => setMembersOpen(true)}
              aria-label="群设置"
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 transition hover:border-indigo-400 dark:border-slate-700"
            >
              群设置
            </button>
          ) : null}
        </div>
      </header>

      {searchOpen ? (
        <div className="border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex gap-1.5">
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void runSearch();
                }
              }}
              placeholder="搜索本会话消息，回车执行"
              aria-label="搜索本会话消息"
              className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-800"
            />
            <button
              type="button"
              disabled={searching || !keyword.trim()}
              onClick={() => void runSearch()}
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs dark:border-slate-700 disabled:opacity-50"
            >
              {searching ? '搜索中…' : '搜索'}
            </button>
          </div>
          {keyword.trim() === '' && state.searchHistory.length > 0 ? (
            <div data-search-history className="mt-1.5 flex flex-wrap gap-1">
              {state.searchHistory.map((item) => (
                <button
                  key={item}
                  type="button"
                  data-search-history-item={item}
                  onClick={() => {
                    setKeyword(item);
                    void imStore
                      .searchMessages(conversation?.conversation_id ?? '', item)
                      .then(setResults)
                      .catch(() => setResults([]));
                    imStore.rememberSearch(item);
                  }}
                  className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:border-indigo-400 dark:border-slate-700"
                >
                  {item}
                </button>
              ))}
            </div>
          ) : null}
          {results !== null ? (
            <div className="mt-2 max-h-[180px] overflow-y-auto" data-search-results>
              {results.length === 0 ? <p className="py-3 text-center text-xs text-slate-500">没有匹配的消息</p> : null}
              {results.map((item) => (
                <button
                  key={item.server_msg_id || item.client_msg_id}
                  type="button"
                  data-search-result
                  onClick={() => {
                    setSearchOpen(false);
                    const cid = conversation?.conversation_id ?? '';
                    if (item.server_msg_id) void imStore.jumpToMessage(cid, item.server_msg_id, keyword.trim());
                  }}
                  className="flex w-full items-baseline gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800/60"
                >
                  <span className="shrink-0 text-slate-400">{formatClock(item.send_time)}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">
                    <MentionText text={messageText(item.content, item.msg_type).text} highlight={keyword.trim()} />
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          const near = distance < 80;
          if (near !== atBottomRef.current) {
            atBottomRef.current = near;
            setAtBottom(near);
          }
        }}
        className="relative flex flex-1 flex-col overflow-y-auto px-4 py-4"
      >
        {groupNotice ? (
          <div
            data-group-notice
            className="mb-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <span className="shrink-0 font-medium">📢 群公告</span>
            <span className="line-clamp-3 flex-1 whitespace-pre-wrap">{groupNotice}</span>
            <button
              type="button"
              aria-label="编辑群公告"
              onClick={() => setMembersOpen(true)}
              className="shrink-0 rounded border border-amber-300 px-1.5 text-[10px] hover:border-amber-500 dark:border-amber-800"
            >
              编辑
            </button>
          </div>
        ) : null}
        {dragging ? (
          <div
            data-drag-overlay="true"
            className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-indigo-400 bg-indigo-50/80 text-sm font-medium text-indigo-600 dark:bg-indigo-950/70 dark:text-indigo-300"
          >
            松开即可发送图片或文件
          </div>
        ) : null}
        <div className="mt-auto flex flex-col gap-2.5">
          {thread?.hasMoreOlder ? (
            <button
              type="button"
              disabled={thread.loadingOlder}
              onClick={() => void imStore.loadOlderMessages(conversation.conversation_id)}
              className="mx-auto rounded-full border border-dashed border-slate-300 px-3.5 py-1 text-xs text-slate-500 transition hover:border-indigo-400 disabled:opacity-50 dark:border-slate-700"
            >
              {thread.loadingOlder ? '加载中…' : '加载更早的消息'}
            </button>
          ) : null}

          {thread?.loading ? <p className="py-10 text-center text-sm text-slate-500">加载中…</p> : null}
          {thread?.error ? <p className="py-10 text-center text-sm text-rose-600">{thread.error}</p> : null}
          {!thread?.loading && !thread?.error && thread && thread.items.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-500">还没有消息，说点什么吧</p>
          ) : null}

          {thread?.items.map((message, index) => {
            const mine = String(message.send_id) === String(state.me?.uid ?? '');
            const previous = index > 0 ? thread.items[index - 1] : undefined;
            const dayLabel = daySeparator(Number(previous?.send_time ?? 0) || undefined, Number(message.send_time));
            const anchor = conversation ? state.unreadAnchors[conversation.conversation_id] : undefined;
            const showUnread = Boolean(anchor)
              && Number(message.seq) > Number(anchor)
              && !thread.items.slice(0, index).some((entry) => Number(entry.seq) > Number(anchor));
            return (
              <Fragment key={message.server_msg_id || message.client_msg_id}>
                {dayLabel ? (
                  <div data-day-separator className="self-center rounded-full bg-slate-200/70 px-2.5 py-0.5 text-[11px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {dayLabel}
                  </div>
                ) : null}
                {showUnread ? (
                  <div data-unread-divider className="flex items-center gap-2 self-stretch px-2 text-[11px] text-indigo-500">
                    <span className="h-px flex-1 bg-indigo-300 dark:bg-indigo-800" />
                    以下为新消息
                    <span className="h-px flex-1 bg-indigo-300 dark:bg-indigo-800" />
                  </div>
                ) : null}
                <Bubble
                  message={message}
                  mine={mine}
                  showSender={Boolean(isGroup)}
                  senderName={imStore.senderName(message.send_id)}
                  onForward={setForwardTarget}
                  onPreviewImage={(url) => {
                  setPreviewZoom(1);
                  setPreviewPan({ x: 0, y: 0 });
                  setPreviewImage(url);
                }}
                onMenu={(target, x, y) => setContextMenu({ message: target, x, y })}
                autoEdit={Boolean(editTarget) && editTarget === message.server_msg_id}
                canRetryUpload={state.uploadRetries.includes(message.client_msg_id)}
                onRetryUpload={() => void imStore.retryUpload(message.client_msg_id)}
                highlight={state.searchHighlight || undefined}
                  selectable={selectMode}
                  selected={selectedIds.includes(message.server_msg_id)}
                  onSelect={() => {
                    const id = message.server_msg_id;
                    if (!id) return;
                    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
                  }}
                />
              </Fragment>
            );
          })}
          {!isGroup && readState ? (
            <p
              data-read-status={readState.read ? 'read' : 'unread'}
              className="self-end pr-1 text-[11px] text-slate-400"
            >
              {readState.read ? '已读' : '未读'}
            </p>
          ) : null}
        </div>
      </div>

      {!atBottom ? (
        <button
          type="button"
          data-jump-latest
          aria-label="回到底部"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          }}
          className="absolute bottom-24 right-6 z-10 rounded-full bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg transition hover:bg-indigo-500"
        >
          ↓ 回到底部
        </button>
      ) : null}

      {selectMode ? (
        <div className="flex items-center justify-between border-t border-slate-200 bg-indigo-50/60 px-3 py-1.5 text-xs dark:border-slate-800 dark:bg-indigo-950/30">
          <span>已选 {selectedIds.length} 条</span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              disabled={selectedIds.length === 0}
              onClick={() => setMergePending(true)}
              className="rounded-lg bg-indigo-600 px-2.5 py-1 font-medium text-white disabled:opacity-40"
            >
              合并转发
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectMode(false);
                setSelectedIds([]);
              }}
              className="rounded-lg border border-slate-200 px-2.5 py-1 dark:border-slate-700"
            >
              取消
            </button>
          </span>
        </div>
      ) : null}

      <Composer disabled={state.connection !== 'open'} />

      <GroupSettingsDialog
        open={membersOpen}
        gid={String(conversation.group_id)}
        onClose={() => setMembersOpen(false)}
      />

      <dialog
        open={Boolean(forwardTarget) || mergePending}
        onClose={() => {
          setForwardTarget(null);
          setMergePending(false);
        }}
        className="w-[min(420px,94vw)] rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-slate-700">
          <h3 className="text-sm font-semibold">{mergePending ? '合并转发到' : '转发到'}</h3>
          <button type="button" className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs dark:border-slate-700" onClick={() => setForwardTarget(null)}>
            关闭
          </button>
        </header>
        <div className="max-h-[320px] overflow-y-auto p-2">
          {state.conversations.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-500">暂无会话</p>
          ) : null}
          {state.conversations.map((item) => {
            const title = item.type === 2
              ? imStore.groupName(item.group_id)
              : imStore.friendName(item.peer_id);
            return (
              <div key={item.conversation_id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  aria-label={`选择转发目标 ${title}`}
                  checked={forwardTargets.includes(item.conversation_id)}
                  onChange={() => {
                    setForwardTargets((current) => current.includes(item.conversation_id)
                      ? current.filter((cid) => cid !== item.conversation_id)
                      : [...current, item.conversation_id]);
                  }}
                  className="ml-1 h-3.5 w-3.5 shrink-0"
                />
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left text-[13px] hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  onClick={() => {
                    const target = forwardTarget;
                    const pending = mergePending;
                    const ids = selectedIds;
                    setForwardTarget(null);
                    setMergePending(false);
                    setSelectMode(false);
                    setSelectedIds([]);
                    setForwardTargets([]);
                    if (pending) {
                      void imStore.mergeForward(ids, item.conversation_id);
                    } else if (target) {
                      void imStore.forwardMessage(target, item.conversation_id);
                    }
                  }}
                >
                  <Avatar name={title} seed={item.conversation_id} size={26} />
                  <span className="truncate">{title}</span>
                </button>
              </div>
            );
          })}
        </div>
        {forwardTargets.length > 0 ? (
          <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-3 py-2 text-xs dark:border-slate-700">
            <span>已选 {forwardTargets.length} 个会话</span>
            <button
              type="button"
              data-forward-selected
              onClick={() => {
                const target = forwardTarget;
                const pending = mergePending;
                const ids = selectedIds;
                const targets = forwardTargets;
                setForwardTarget(null);
                setMergePending(false);
                setSelectMode(false);
                setSelectedIds([]);
                setForwardTargets([]);
                if (pending) {
                  void imStore.mergeForward(ids, targets);
                } else if (target) {
                  void imStore.forwardMessage(target, targets);
                }
              }}
              className="rounded-lg bg-indigo-600 px-2.5 py-1 font-medium text-white"
            >
              转发到已选
            </button>
          </div>
        ) : null}
      </dialog>

      {contextMenu ? (
        <>
          <div className="fixed inset-0 z-[55]" onClick={() => setContextMenu(null)} onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu(null);
          }} />
          <div
            role="menu"
            data-message-menu="true"
            style={{ left: Math.min(contextMenu.x, window.innerWidth - 160), top: Math.min(contextMenu.y, window.innerHeight - 240) }}
            className="fixed z-[56] w-36 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-xs shadow-xl dark:border-slate-700 dark:bg-slate-900"
          >
            <button
              type="button"
              data-menu-action="copy"
              onClick={() => {
                const body = messageText(contextMenu.message.content, contextMenu.message.msg_type).text;
                void navigator.clipboard?.writeText(body).then(() => imStore.notify('已复制')).catch(() => imStore.notify('复制失败', 'error'));
                setContextMenu(null);
              }}
              className="block w-full px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              复制
            </button>
            <button
              type="button"
              data-menu-action="quote"
              onClick={() => {
                imStore.setQuoteTarget(contextMenu.message);
                setContextMenu(null);
              }}
              className="block w-full px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              引用
            </button>
            <button
              type="button"
              data-menu-action="forward"
              onClick={() => {
                setForwardTarget(contextMenu.message);
                setContextMenu(null);
              }}
              className="block w-full px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              转发
            </button>
            <div
              data-menu-action="react"
              className="flex items-center justify-between gap-1 border-t border-slate-100 px-2 py-1 dark:border-slate-800"
            >
              {REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`回应 ${emoji}`}
                  className="text-base transition hover:scale-110"
                  onClick={() => {
                    void imStore.toggleReaction(contextMenu.message, emoji);
                    setContextMenu(null);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
            {contextMenu.message.msg_type === 1
              && String(contextMenu.message.send_id) === String(state.me?.uid ?? '')
              && contextMenu.message.server_msg_id ? (
                <button
                  type="button"
                  data-menu-action="edit"
                  onClick={() => {
                    setEditTarget(contextMenu.message.server_msg_id);
                    setContextMenu(null);
                  }}
                  className="block w-full px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  编辑
                </button>
              ) : null}
            {String(contextMenu.message.send_id) === String(state.me?.uid ?? '') && contextMenu.message.server_msg_id ? (
              <button
                type="button"
                data-menu-action="delete"
                onClick={() => {
                  void imStore.deleteMessage(contextMenu.message);
                  setContextMenu(null);
                }}
                className="block w-full px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
              >
                删除
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {previewImage ? (
        <div
          role="dialog"
          aria-label="图片预览"
          data-image-preview="true"
          onClick={() => setPreviewImage(null)}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/90 p-6 backdrop-blur"
        >
          <img
            src={previewImage}
            alt="预览"
            data-preview-image
            style={{
              transform: `scale(${previewZoom}) translate(${previewPan.x}px, ${previewPan.y}px)`,
              cursor: previewZoom > 1 ? 'grab' : 'zoom-in',
            }}
            className="max-h-full max-w-full rounded-xl object-contain shadow-2xl transition-transform"
            onWheel={(event) => {
              event.preventDefault();
              setPreviewZoom((current) => Math.min(4, Math.max(1, current - Math.sign(event.deltaY) * 0.2)));
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              setPreviewZoom((current) => (current > 1 ? 1 : 2));
              setPreviewPan({ x: 0, y: 0 });
            }}
            onClick={(event) => event.stopPropagation()}
          />
          <button
            type="button"
            aria-label="关闭预览"
            onClick={() => setPreviewImage(null)}
            className="absolute right-5 top-5 rounded-full bg-white/10 px-3 py-1 text-sm text-white hover:bg-white/20"
          >
            ✕
          </button>
        </div>
      ) : null}
    </section>
  );
}
