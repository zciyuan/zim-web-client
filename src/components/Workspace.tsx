import { Avatar } from './Avatar';
import { ChatPanel } from './ChatPanel';
import { imStore, useIm, type Tab } from '../app/store';
import { formatListTime, previewConversation } from '../app/format';

const TABS: { key: Tab; icon: string; label: string }[] = [
  { key: 'conversations', icon: '💬', label: '会话' },
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
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-2">
        <span title={CONNECTION_LABEL[state.connection] ?? state.connection} className={`h-2.5 w-2.5 rounded-full ${dot}`} />
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
  const title =
    state.tab === 'friends' ? `好友（${state.friends.length}）`
      : state.tab === 'groups' ? `群聊（${state.groups.length}）`
        : '会话';

  return (
    <section
      className={`${state.activeCid ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-slate-200 bg-white md:w-[300px] dark:border-slate-800 dark:bg-slate-900`}
      aria-label="列表"
    >
      <header className="flex items-center justify-between px-4 pt-4 pb-2.5">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        <button
          type="button"
          onClick={() => void imStore.refresh()}
          className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-500 transition hover:border-indigo-400 hover:text-slate-900 dark:border-slate-700 dark:hover:text-slate-100"
        >
          刷新
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
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
                  <button
                    key={conversation.conversation_id}
                    type="button"
                    onClick={() => void imStore.openConversation(conversation.conversation_id)}
                    aria-current={active}
                    className={`flex w-full items-center gap-2.5 rounded-xl p-2.5 text-left transition ${
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
                );
              })
          )
        ) : null}

        {state.tab === 'friends' ? (
          state.friends.length === 0 ? (
            <EmptyList text="还没有好友" />
          ) : (
            state.friends.map((friend) => {
              const name = friend.remark || friend.profile?.nickname || friend.profile?.username || `用户 ${friend.friend_id}`;
              return (
                <button
                  key={String(friend.friend_id)}
                  type="button"
                  onClick={() => imStore.openFriend(friend)}
                  className="flex w-full items-center gap-2.5 rounded-xl p-2.5 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/60"
                >
                  <Avatar name={name} seed={friend.friend_id} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-slate-900 dark:text-slate-100">{name}</span>
                    <span className="block text-xs text-slate-500">uid {String(friend.friend_id)}</span>
                  </span>
                </button>
              );
            })
          )
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
    </section>
  );
}

export function Workspace() {
  return (
    <div className="flex h-full bg-slate-100 dark:bg-slate-950">
      <Rail />
      <Sidebar />
      <ChatPanel />
    </div>
  );
}
