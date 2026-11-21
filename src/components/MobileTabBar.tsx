import { imStore, useIm, type Tab } from '../app/store';
import { tapFeedback } from '../platform';

const ITEMS: { key: Tab; icon: string; label: string }[] = [
  { key: 'conversations', icon: '💬', label: '会话' },
  { key: 'unread', icon: '🔔', label: '未读' },
  { key: 'friends', icon: '👥', label: '好友' },
  { key: 'groups', icon: '🏠', label: '群聊' },
];

/**
 * Bottom navigation for phones. The desktop rail is hidden below md; this bar
 * keeps the four main destinations plus the account/settings sheet reachable
 * with one thumb.
 */
export function MobileTabBar({ onProfile }: { onProfile: () => void }) {
  const state = useIm();
  const unread = state.conversations.reduce((sum, item) => sum + Number(item.unread ?? 0), 0);
  const pending = state.friendRequests.length;

  const badgeOf = (key: Tab): number => {
    if (key === 'unread' || key === 'conversations') return unread;
    if (key === 'friends') return pending;
    return 0;
  };

  return (
    <nav
      aria-label="底部导航"
      data-mobile-tabbar
      className="zim-tabbar flex shrink-0 items-stretch border-t border-slate-200 bg-white/95 backdrop-blur md:hidden dark:border-slate-800 dark:bg-slate-900/95"
    >
      {ITEMS.map((item) => {
        const active = state.tab === item.key;
        const badge = badgeOf(item.key);
        return (
          <button
            key={item.key}
            type="button"
            aria-label={item.label}
            aria-selected={active}
            data-mobile-tab={item.key}
            onClick={() => {
              tapFeedback();
              imStore.clearActive();
              imStore.setTab(item.key);
            }}
            className={`relative flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition ${
              active
                ? 'font-semibold text-indigo-600 dark:text-indigo-300'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            <span className="text-xl leading-none">{item.icon}</span>
            <span className="truncate">{item.label}</span>
            {badge > 0 ? (
              <span className="absolute top-1 right-[22%] min-w-4 rounded-full bg-rose-500 px-1 text-[10px] leading-4 text-white">
                {badge > 99 ? '99+' : badge}
              </span>
            ) : null}
          </button>
        );
      })}
      <button
        type="button"
        aria-label="我的"
        data-mobile-tab="me"
        onClick={() => {
          tapFeedback();
          onProfile();
        }}
        className="relative flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[11px] text-slate-500 transition hover:text-slate-800 dark:hover:text-slate-200"
      >
        <span className="grid h-5 w-5 place-items-center rounded-full bg-linear-to-br from-indigo-500 to-violet-500 text-[10px] font-bold text-white">
          {String(state.me?.name ?? 'Z').slice(0, 1).toUpperCase()}
        </span>
        <span className="truncate">我的</span>
      </button>
    </nav>
  );
}
