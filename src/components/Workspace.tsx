import { useEffect, useMemo, useRef, useState } from 'react';

import { Avatar } from './Avatar';
import { ChatPanel } from './ChatPanel';
import { AddFriendDialog } from './AddFriendDialog';
import { GroupDialogs } from './GroupDialogs';
import { imStore, useIm, type Tab } from '../app/store';
import { formatClock, formatListTime, messagePreview, previewConversation } from '../app/format';

const TABS: { key: Tab; icon: string; label: string }[] = [
  { key: 'conversations', icon: '💬', label: '会话' },
  { key: 'unread', icon: '🔔', label: '未读' },
  { key: 'friends', icon: '👥', label: '好友' },
  { key: 'groups', icon: '🏠', label: '群聊' },
];

const CONNECTION_LABEL: Record<string, string> = {
  idle: '未连接',
  connecting: '连接中',
  open: '已连接',
  reconnecting: '重连中',
  reconnected: '已连接',
  closed: '已断开',
  offline: '连接已断开',
  error: '连接异常',
};

const CONNECTION_COLOR: Record<string, string> = {
  open: 'bg-emerald-500',
  reconnected: 'bg-emerald-500',
  connecting: 'bg-amber-500',
  reconnecting: 'bg-amber-500',
  closed: 'bg-rose-500',
  offline: 'bg-rose-500',
  error: 'bg-rose-500',
};

function Rail() {
  const state = useIm();
  const total = state.conversations.reduce((sum, item) => sum + Number(item.unread ?? 0), 0);
  const pending = state.friendRequests.length;
  const dot = CONNECTION_COLOR[state.connection] ?? 'bg-slate-400';

  return (
    <aside className="flex w-[76px] shrink-0 flex-col items-center gap-2 border-r border-slate-200 bg-slate-50 px-2 py-3.5 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-1.5 grid h-10 w-10 place-items-center rounded-xl bg-linear-to-br from-indigo-500 to-violet-500 font-bold text-white">
        Z
      </div>

      <nav className="flex w-full flex-col gap-1" aria-label="主导航">
        {TABS.map((tab) => {
          const active = state.tab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => imStore.setTab(tab.key)}
              aria-selected={active}
              className={`relative flex flex-col items-center gap-0.5 rounded-xl py-2 text-[11px] transition ${
                active
                  ? 'bg-indigo-50 font-semibold text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300'
                  : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <span className="text-lg leading-none">{tab.icon}</span>
              <span>{tab.label}</span>
              {tab.key === 'conversations' && total > 0 ? (
                <span className="absolute top-1 right-2 min-w-4 rounded-full bg-rose-500 px-1 text-[10px] leading-4 text-white">
                  {total > 99 ? '99+' : total}
                </span>
              ) : null}
              {tab.key === 'unread' && total > 0 ? (
                <span
                  data-unread-total
                  className="absolute top-1 right-2 min-w-4 rounded-full bg-rose-500 px-1 text-[10px] leading-4 text-white"
                >
                  {total > 99 ? '99+' : total}
                </span>
              ) : null}
              {tab.key === 'friends' && pending > 0 ? (
                <span
                  data-friend-requests
                  className="absolute top-1 right-2 min-w-4 rounded-full bg-amber-500 px-1 text-[10px] leading-4 text-white"
                >
                  {pending > 99 ? '99+' : pending}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-2">
        <span title={CONNECTION_LABEL[state.connection] ?? state.connection} className={`h-2.5 w-2.5 rounded-full ${dot}`} />
        <button
          type="button"
          aria-label="切换主题"
          data-theme-mode={state.theme}
          title={state.theme === 'dark' ? '深色模式' : state.theme === 'light' ? '浅色模式' : '跟随系统'}
          onClick={() => imStore.cycleTheme()}
          className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 text-sm text-slate-500 transition hover:border-indigo-400 dark:border-slate-700"
        >
          {state.theme === 'dark' ? '🌙' : state.theme === 'light' ? '☀️' : '🖥️'}
        </button>
        <button
          type="button"
          aria-label="桌面通知"
          aria-pressed={state.notifications}
          data-notifications={state.notifications ? 'on' : 'off'}
          title={state.notifications ? '桌面通知已开启' : '开启桌面通知'}
          onClick={() => {
            if (state.notifications) imStore.disableNotifications();
            else void imStore.enableNotifications();
          }}
          className={`grid h-9 w-9 place-items-center rounded-xl border text-sm transition ${
            state.notifications
              ? 'border-indigo-400 bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300'
              : 'border-slate-200 text-slate-500 hover:border-indigo-400 dark:border-slate-700'
          }`}
        >
          {state.notifications ? '🔔' : '🔕'}
        </button>
        <button
          type="button"
          onClick={() => imStore.logout()}
          className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 transition hover:border-indigo-400 hover:text-slate-900 dark:border-slate-700 dark:hover:text-slate-100"
        >
          退出
        </button>
      </div>
    </aside>
  );
}

function EmptyList({ text }: { text: string }) {
  return <div className="px-4 py-10 text-center text-sm text-slate-500">{text}</div>;
}

function Sidebar() {
  const state = useIm();
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [menuCid, setMenuCid] = useState<string | null>(null);
  const pullStart = useRef<number | null>(null);
  const [pullOffset, setPullOffset] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const results = useMemo(() => imStore.searchAll(keyword), [keyword, state.conversations, state.threads]);

  // Ctrl/Cmd+K opens the global search (Esc closes it).
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInput.current?.focus());
      }
      if (event.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);
  const unreadTotal = state.conversations.reduce((sum, item) => sum + Number(item.unread ?? 0), 0);
  const title =
    state.tab === 'unread' ? `未读（${unreadTotal}）`
      : state.tab === 'friends' ? `好友（${state.friends.length}）`
        : state.tab === 'groups' ? `群聊（${state.groups.length}）`
          : '会话';

  return (
    <section
      className={`${state.activeCid ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-slate-200 bg-white md:w-[300px] dark:border-slate-800 dark:bg-slate-900`}
      aria-label="列表"
    >
      <header className="flex items-center justify-between px-4 pt-4 pb-2.5">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        <span className="flex items-center gap-1">
          <button
            type="button"
            aria-label="全局搜索"
            aria-expanded={searchOpen}
            onClick={() => setSearchOpen((open) => !open)}
            className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-500 transition hover:border-indigo-400 dark:border-slate-700"
          >
            🔍
          </button>
          {state.tab === 'friends' ? (
            <button
              type="button"
              onClick={() => setAddFriendOpen(true)}
              className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-500 transition hover:border-indigo-400 hover:text-slate-900 dark:border-slate-700 dark:hover:text-slate-100"
            >
              + 添加
            </button>
          ) : null}
          {state.tab === 'groups' ? (
            <button
              type="button"
              onClick={() => setGroupDialogOpen(true)}
              className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-500 transition hover:border-indigo-400 hover:text-slate-900 dark:border-slate-700 dark:hover:text-slate-100"
            >
              + 新建
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void imStore.refresh()}
            className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-500 transition hover:border-indigo-400 hover:text-slate-900 dark:border-slate-700 dark:hover:text-slate-100"
          >
            刷新
          </button>
        </span>
      </header>

      {searchOpen ? (
        <div className="px-3 pb-2" data-global-search>
          <input
            ref={searchInput}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索会话和已加载的消息（Ctrl+K）"
            aria-label="全局搜索输入"
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
          />
          {keyword.trim() ? (
            <div className="mt-1.5 max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white text-xs dark:border-slate-700 dark:bg-slate-900">
              {results.conversations.length === 0 && results.messages.length === 0 ? (
                <p className="px-2.5 py-2 text-slate-500">没有匹配的会话或消息</p>
              ) : null}
              {results.conversations.length > 0 ? (
                <p className="px-2.5 pt-2 text-[11px] text-slate-400">会话</p>
              ) : null}
              {results.conversations.map((item) => (
                <button
                  key={item.conversation_id}
                  type="button"
                  data-search-hit="conversation"
                  onClick={() => {
                    setSearchOpen(false);
                    void imStore.openConversation(item.conversation_id);
                  }}
                  className="block w-full truncate px-2.5 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  {imStore.conversationTitle(item)}
                </button>
              ))}
              {results.messages.length > 0 ? (
                <p className="px-2.5 pt-2 text-[11px] text-slate-400">消息（{results.messages.length}）</p>
              ) : null}
              {results.messages.slice(0, 12).map((hit) => (
                <button
                  key={`${hit.cid}-${hit.item.server_msg_id || hit.item.client_msg_id}`}
                  type="button"
                  data-search-hit="message"
                  onClick={() => {
                    setSearchOpen(false);
                    void imStore.jumpToMessage(hit.cid, hit.item.server_msg_id);
                  }}
                  className="block w-full px-2.5 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <span className="mr-2 text-[10px] text-slate-400">{formatClock(hit.item.send_time)}</span>
                  <span className="text-slate-700 dark:text-slate-200">
                    {messagePreview(hit.item.content, hit.item.msg_type)}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        className="relative flex-1 overflow-y-auto px-2 pb-3"
        data-list-scroll
        onTouchStart={(event) => {
          pullStart.current = event.currentTarget.scrollTop === 0
            ? event.touches[0]?.clientY ?? null
            : null;
        }}
        onTouchMove={(event) => {
          if (pullStart.current === null) return;
          const delta = (event.touches[0]?.clientY ?? pullStart.current) - pullStart.current;
          setPullOffset(delta > 0 ? Math.min(delta, 80) : 0);
        }}
        onTouchEnd={() => {
          if (pullOffset > 50) void imStore.refresh();
          setPullOffset(0);
          pullStart.current = null;
        }}
      >
        {pullOffset > 0 ? (
          <div
            data-pull-hint={Math.round(pullOffset)}
            style={{ height: pullOffset }}
            className="flex items-center justify-center overflow-hidden text-[11px] text-slate-400"
          >
            {pullOffset > 50 ? '松开刷新' : '下拉刷新'}
          </div>
        ) : null}
        {state.tab === 'unread' ? (
          <div data-unread-page>
            {state.conversations.filter((item) => Number(item.unread ?? 0) > 0).length === 0 ? (
              <EmptyList text="没有未读消息" />
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-[11px] text-slate-400">
                    {state.conversations.filter((item) => Number(item.unread ?? 0) > 0).length} 个会话有未读
                  </span>
                  <button
                    type="button"
                    aria-label="全部标为已读"
                    onClick={() => {
                      for (const item of state.conversations) {
                        if (Number(item.unread ?? 0) > 0) void imStore.markRead(item.conversation_id);
                      }
                    }}
                    className="rounded-lg border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:border-indigo-400 dark:border-slate-700"
                  >
                    全部已读
                  </button>
                </div>
                {[...state.conversations]
                  .filter((item) => Number(item.unread ?? 0) > 0)
                  .sort((a, b) => Number(b.last_msg_at ?? 0) - Number(a.last_msg_at ?? 0))
                  .map((conversation) => {
                    const name = imStore.conversationTitle(conversation);
                    const unread = Number(conversation.unread ?? 0);
                    return (
                      <button
                        key={conversation.conversation_id}
                        type="button"
                        data-unread-row={conversation.conversation_id}
                        onClick={() => void imStore.openConversation(conversation.conversation_id)}
                        className="flex w-full items-center gap-2.5 rounded-xl p-2.5 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/60"
                      >
                        <Avatar name={name} seed={conversation.conversation_id} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-[13.5px] font-semibold text-slate-900 dark:text-slate-100">{name}</span>
                            <span className="shrink-0 text-[11px] text-slate-400">{formatListTime(conversation.last_msg_at)}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-slate-500">{previewConversation(conversation)}</span>
                        </span>
                        <span className="shrink-0 rounded-full bg-rose-500 px-1.5 text-[11px] leading-[18px] text-white">
                          {unread > 99 ? '99+' : unread}
                        </span>
                      </button>
                    );
                  })}
              </>
            )}
          </div>
        ) : null}

        {state.tab === 'conversations' ? (
          state.conversations.length === 0 ? (
            <EmptyList text="还没有会话，去「好友」发起聊天" />
          ) : (
            [...state.conversations]
              .sort((a, b) => Number(b.is_pinned ?? 0) - Number(a.is_pinned ?? 0))
              .map((conversation) => {
                const isGroup = conversation.type === 2;
                const name = imStore.conversationTitle(conversation);
                const unread = Number(conversation.unread ?? 0);
                const active = state.activeCid === conversation.conversation_id;
                return (
                  <div key={conversation.conversation_id} className="group relative">
                  <button
                    type="button"
                    onClick={() => void imStore.openConversation(conversation.conversation_id)}
                    aria-current={active}
                    data-conversation-row={conversation.conversation_id}
                    className={`flex w-full items-center gap-2.5 rounded-xl p-2.5 pr-8 text-left transition ${
                      active ? 'bg-indigo-50 dark:bg-indigo-950/60' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
                    }`}
                  >
                    <Avatar name={name} seed={conversation.conversation_id} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[13.5px] font-semibold text-slate-900 dark:text-slate-100">
                          {name}
                        </span>
                        <span className="shrink-0 text-[11px] text-slate-400">
                          {formatListTime(conversation.last_msg_at)}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-slate-500">
                        {previewConversation(conversation)}
                      </span>
                    </span>
                    {unread > 0 ? (
                      <span className="shrink-0 rounded-full bg-rose-500 px-1.5 text-[11px] leading-[18px] text-white">
                        {unread > 99 ? '99+' : unread}
                      </span>
                    ) : isGroup ? (
                      <span className="shrink-0 rounded border border-indigo-400 px-1 text-[10px] text-indigo-500">群</span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label="会话操作"
                    data-conversation-menu={conversation.conversation_id}
                    onClick={() => setMenuCid(menuCid === conversation.conversation_id ? null : conversation.conversation_id)}
                    className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-lg border border-slate-200 bg-white text-[11px] text-slate-500 opacity-0 transition group-hover:opacity-100 dark:border-slate-700 dark:bg-slate-900"
                  >
                    ⋯
                  </button>
                  {menuCid === conversation.conversation_id ? (
                    <div
                      data-conversation-actions
                      className="absolute right-1.5 top-8 z-20 w-28 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900"
                    >
                      <button
                        type="button"
                        data-pin-action
                        onClick={() => {
                          setMenuCid(null);
                          void imStore.pinConversation(conversation.conversation_id, !Number(conversation.is_pinned ?? 0));
                        }}
                        className="block w-full px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        {Number(conversation.is_pinned ?? 0) ? '取消置顶' : '置顶会话'}
                      </button>
                      <button
                        type="button"
                        data-delete-action
                        onClick={() => {
                          setMenuCid(null);
                          void imStore.deleteConversation(conversation.conversation_id);
                        }}
                        className="block w-full px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                      >
                        删除会话
                      </button>
                    </div>
                  ) : null}
                  </div>
                );
              })
          )
        ) : null}

        {state.tab === 'friends' ? (
          <div>
            {state.friendRequests.length > 0 ? (
              <div className="mb-2">
                <p className="px-2 py-1 text-[11px] text-slate-400">好友申请（{state.friendRequests.length}）</p>
                {state.friendRequests.map((request) => {
                  const from = String(request.from_id);
                  const profile = state.requestProfiles[from];
                  const name = profile?.nickname || profile?.username || `用户 ${from}`;
                  return (
                    <div key={String(request.id ?? from)} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                      <Avatar name={name} seed={from} size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">{name}</span>
                        <span className="block truncate text-[11px] text-slate-400">{request.why || '请求添加你为好友'}</span>
                      </span>
                      <button type="button" className="rounded border border-emerald-200 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:border-emerald-900" onClick={() => void imStore.answerFriend(from, true)}>
                        同意
                      </button>
                      <button type="button" className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] dark:border-slate-700" onClick={() => void imStore.answerFriend(from, false)}>
                        拒绝
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {state.friends.length === 0 ? (
              <EmptyList text="还没有好友，点「+ 添加」搜索账号" />
            ) : (
              state.friends.map((friend) => {
                const uid = String(friend.friend_id);
                const name = friend.remark || friend.profile?.nickname || friend.profile?.username || `用户 ${uid}`;
                return (
                  <div key={uid} className="group flex items-center gap-2.5 rounded-xl p-2.5 transition hover:bg-slate-50 dark:hover:bg-slate-800/60">
                    <Avatar name={name} seed={uid} />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => imStore.openFriend(friend)}>
                      <span className="flex items-baseline gap-1 truncate text-[13.5px] font-semibold text-slate-900 dark:text-slate-100">
                        {name}
                        {friend.pinned ? <span className="rounded border border-indigo-400 px-1 text-[10px] text-indigo-500">置顶</span> : null}
                      </span>
                      <span className="block text-xs text-slate-500">uid {uid}</span>
                    </button>
                    <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
                      <button type="button" className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] dark:border-slate-700" onClick={() => { const remark = window.prompt('备注名', friend.remark ?? ''); if (remark !== null) void imStore.setFriendRemark(uid, remark); }}>
                        备注
                      </button>
                      <button type="button" className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] dark:border-slate-700" onClick={() => void imStore.pinFriend(uid, !friend.pinned)}>
                        {friend.pinned ? '取消置顶' : '置顶'}
                      </button>
                      <button type="button" className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] dark:border-slate-700" onClick={() => { if (window.confirm(`把 ${name} 加入黑名单？`)) void imStore.blockUser(uid); }}>
                        拉黑
                      </button>
                      <button type="button" className="rounded border border-rose-200 px-1.5 py-0.5 text-[10px] text-rose-600 dark:border-rose-900" onClick={() => { if (window.confirm(`删除好友 ${name}？`)) void imStore.deleteFriend(uid); }}>
                        删除
                      </button>
                    </span>
                  </div>
                );
              })
            )}

            {state.blacklist.length > 0 ? (
              <details className="mt-3 border-t border-slate-100 pt-2 dark:border-slate-800">
                <summary className="cursor-pointer px-2 py-1 text-[11px] text-slate-400">
                  黑名单（{state.blacklist.length}）
                </summary>
                {state.blacklist.map((user) => {
                  const uid = String(user.uid);
                  const name = user.nickname || user.username || `用户 ${uid}`;
                  return (
                    <div key={uid} className="flex items-center gap-2 rounded-xl px-2 py-1.5">
                      <Avatar name={name} seed={uid} size={28} />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{name}</span>
                      <button type="button" className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] dark:border-slate-700" onClick={() => void imStore.unblockUser(uid)}>
                        解除
                      </button>
                    </div>
                  );
                })}
              </details>
            ) : null}
          </div>
        ) : null}

        {state.tab === 'groups' ? (
          state.groups.length === 0 ? (
            <EmptyList text="还没有加入任何群" />
          ) : (
            state.groups.map((group) => (
              <button
                key={String(group.group_id)}
                type="button"
                onClick={() => imStore.openGroup(group)}
                className="flex w-full items-center gap-2.5 rounded-xl p-2.5 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/60"
              >
                <Avatar name={group.name ?? ''} seed={group.group_id} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[13.5px] font-semibold text-slate-900 dark:text-slate-100">
                      {group.name || `群 ${String(group.group_id)}`}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-400">{group.member_count ?? 0} 人</span>
                  </span>
                  <span className="block truncate text-xs text-slate-500">gid {group.display_id ?? String(group.group_id)}</span>
                </span>
              </button>
            ))
          )
        ) : null}
      </div>

      <GroupDialogs open={groupDialogOpen} onClose={() => setGroupDialogOpen(false)} />
      <AddFriendDialog open={addFriendOpen} onClose={() => setAddFriendOpen(false)} />
    </section>
  );
}

export function Workspace() {
  const state = useIm();
  const unread = state.conversations.reduce((sum, item) => sum + Number(item.unread ?? 0), 0);

  // Keep the tab title in sync with the unread total (classic IM affordance).
  useEffect(() => {
    document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) ZIM` : 'ZIM';
  }, [unread]);

  return (
    <div className="flex h-full bg-slate-100 dark:bg-slate-950">
      <Rail />
      <Sidebar />
      <ChatPanel />
    </div>
  );
}
