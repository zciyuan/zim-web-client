import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';

import { Avatar } from './Avatar';
import { EmojiPicker } from './EmojiPicker';
import { GroupSettingsDialog } from './GroupSettingsDialog';
import { imStore, useIm, type UiMessage } from '../app/store';
import { formatClock, imageOf, messageText } from '../app/format';

function Bubble({
  message,
  mine,
  showSender,
  senderName,
}: {
  message: UiMessage;
  mine: boolean;
  showSender: boolean;
  senderName: string;
}) {
  const image = message.msg_type === 2 ? imageOf(message.content) : null;
  const { text, system } = messageText(message.content, message.msg_type);
  const state = message.localState ?? 'sent';

  const openImage = () => {
    if (image) window.open(imStore.assetUrl(image.url), '_blank', 'noopener');
  };

  return (
    <div
      className={`message-enter flex max-w-[82%] gap-2 ${mine ? 'flex-row-reverse self-end' : 'self-start'}`}
      data-state={state}
    >
      <Avatar name={senderName} seed={message.send_id} size={30} />
      <div className="min-w-0">
        <div className={`mb-0.5 flex items-baseline gap-1.5 text-[11px] text-slate-400 ${mine ? 'justify-end' : ''}`}>
          {showSender && !mine ? <span>{senderName}</span> : null}
          <span>{formatClock(message.send_time)}</span>
        </div>
        {image ? (
          <button
            type="button"
            onClick={openImage}
            className={`block overflow-hidden rounded-2xl border p-1 transition hover:opacity-90 ${
              mine ? 'border-indigo-500 bg-indigo-600/10' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'
            } ${state === 'sending' ? 'opacity-60' : ''} ${
              state === 'failed' ? 'border-rose-400 bg-transparent' : ''
            }`}
          >
            <img
              src={imStore.assetUrl(image.url)}
              alt="图片消息"
              loading="lazy"
              className="max-h-[240px] max-w-[280px] rounded-xl object-cover"
            />
            {image.width > 0 && image.height > 0 ? (
              <span className="mt-1 block text-[10px] text-slate-400">
                {image.width}×{image.height}
              </span>
            ) : null}
          </button>
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
            {message.status === 2 ? '该消息已删除' : text}
          </div>
        )}
        {state === 'failed' ? (
          <div className="mt-0.5 text-right text-[11px] text-rose-600">
            发送失败{' '}
            <button type="button" className="text-indigo-600 underline" onClick={() => void imStore.retryMessage(message)}>
              重试
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Composer({ disabled }: { disabled: boolean }) {
  const [value, setValue] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = () => {
    const text = value.trim();
    if (!text) return;
    if (disabled) {
      // Never drop a typed message silently: keep the text and say why.
      imStore.notify('连接未就绪，消息未发送', 'error');
      return;
    }
    setValue('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    void imStore.sendMessage(text);
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
    if (file) void imStore.sendImage(file);
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
          title="发送图片"
          aria-label="发送图片"
        >
          🖼️
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickFile} aria-label="选择图片" />
      </div>

      <textarea
        ref={inputRef}
        value={value}
        rows={1}
        maxLength={4000}
        placeholder="输入消息，Enter 发送，Shift+Enter 换行，可直接粘贴图片"
        onChange={(event) => {
          setValue(event.target.value);
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
  const scrollRef = useRef<HTMLDivElement>(null);

  const conversation = useMemo(
    () => state.conversations.find((item) => item.conversation_id === state.activeCid),
    [state.conversations, state.activeCid],
  );
  const thread = state.activeCid ? state.threads[state.activeCid] : undefined;
  const isGroup = conversation?.type === 2;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.activeCid, thread?.items.length]);

  if (!conversation) {
    return (
      <section className="flex min-w-0 flex-1 flex-col bg-slate-100 max-md:hidden dark:bg-slate-950">
        <div className="grid flex-1 place-items-center text-sm text-slate-500">选择一个会话开始聊天</div>
      </section>
    );
  }

  const title = imStore.conversationTitle(conversation);
  const subtitle = isGroup
    ? `群 ${conversation.group_id} · 会话 ${conversation.conversation_id}`
    : `用户 ${conversation.peer_id} · 会话 ${conversation.conversation_id}`;

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-slate-100 dark:bg-slate-950" aria-label="聊天">
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
            <p className="truncate text-[11px] text-slate-500">{subtitle}</p>
          </div>
        </div>
        {isGroup ? (
          <button
            type="button"
            onClick={() => setMembersOpen(true)}
            className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 transition hover:border-indigo-400 dark:border-slate-700"
          >
            群设置
          </button>
        ) : null}
      </header>

      <div ref={scrollRef} className="flex flex-1 flex-col overflow-y-auto px-4 py-4">
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

          {thread?.items.map((message) => {
            const mine = String(message.send_id) === String(state.me?.uid ?? '');
            return (
              <Bubble
                key={message.server_msg_id || message.client_msg_id}
                message={message}
                mine={mine}
                showSender={Boolean(isGroup)}
                senderName={imStore.senderName(message.send_id)}
              />
            );
          })}
        </div>
      </div>

      <Composer disabled={state.connection !== 'open'} />

      <GroupSettingsDialog
        open={membersOpen}
        gid={String(conversation.group_id)}
        onClose={() => setMembersOpen(false)}
      />
    </section>
  );
}
