import { useEffect, useState } from 'react';

import { Avatar } from './Avatar';
import { imStore, useIm } from '../app/store';
import { useInstallPrompt, usePlatform } from '../platform';

/**
 * Edits the signed-in user's profile and exposes the shell-level settings a
 * phone cannot reach from the desktop rail: theme, notifications, PWA install,
 * server address and logout.
 *
 * Rendered through showModal() so the dialog sits in the browser's top layer:
 * an inline <dialog open> would stay in the page flow, which made the profile
 * panel bleed into the sidebar behind it and clipped it on narrow screens.
 */
export function ProfileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useIm();
  const platform = usePlatform();
  const install = useInstallPrompt();
  const [dialogEl, setDialogEl] = useState<HTMLDialogElement | null>(null);
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) dialogEl.showModal();
    if (!open && dialogEl.open) dialogEl.close();
  }, [open, dialogEl]);

  useEffect(() => {
    if (!open) return;
    setNickname(state.me?.name ?? '');
    setAvatar(state.me?.avatar ?? '');
    setBusy(false);
  }, [open, state.me?.name, state.me?.avatar]);

  const save = async () => {
    setBusy(true);
    try {
      await imStore.updateProfile({ nickname, avatar });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const themeLabel = state.theme === 'dark' ? '深色' : state.theme === 'light' ? '浅色' : '跟随系统';
  const connectionLabel = state.connection === 'open' || state.connection === 'reconnected'
    ? '已连接'
    : state.connection === 'connecting' || state.connection === 'reconnecting'
      ? '连接中'
      : '未连接';

  return (
    <dialog
      ref={setDialogEl}
      aria-label="个人资料"
      data-profile-dialog
      onClose={onClose}
      onCancel={(event) => {
        // Escape must also reset the React state that opened the dialog.
        event.preventDefault();
        onClose();
      }}
      className="m-auto w-[min(440px,94vw)] max-h-[86dvh] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-900/50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5 dark:border-slate-700 dark:bg-slate-900">
        <h3 className="text-sm font-semibold">我的</h3>
        <button type="button" aria-label="关闭资料" onClick={onClose} className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs dark:border-slate-700">
          关闭
        </button>
      </header>

      <div className="space-y-3 p-4">
        <div className="flex items-center gap-3">
          <Avatar name={nickname || state.me?.name || '我'} seed={state.me?.uid ?? 'me'} size={48} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{nickname || state.me?.name}</p>
            <p className="truncate text-[11px] text-slate-500">UID {state.me?.uid}</p>
          </div>
          <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] text-slate-500 dark:border-slate-700">
            {connectionLabel}
          </span>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">昵称</span>
          <input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            aria-label="昵称"
            maxLength={32}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">头像 URL（留空使用文字头像）</span>
          <input
            value={avatar}
            onChange={(event) => setAvatar(event.target.value)}
            aria-label="头像URL"
            placeholder="https://…"
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
          />
        </label>

        <p className="text-[11px] text-rose-600" data-profile-error />
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="w-full rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? '保存中…' : '保存'}
        </button>

        <section className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700" data-app-info>
          <div className="flex items-center justify-between gap-3 text-[11px]">
            <span className="text-slate-500">运行端</span>
            <span data-platform-label className="font-medium">{platform.label}</span>
          </div>
          <div className="flex items-center justify-between gap-3 text-[11px]">
            <span className="text-slate-500">版本</span>
            <span className="font-mono">v{platform.version}</span>
          </div>
          <div className="flex items-center justify-between gap-3 text-[11px]">
            <span className="shrink-0 text-slate-500">服务器</span>
            <span className="min-w-0 truncate text-right font-mono" title={state.endpoint || '同源部署'}>
              {state.endpoint || '同源部署'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 text-[11px]">
            <span className="text-slate-500">协议</span>
            <span className="font-mono">{state.connection} · {state.notifications ? '通知开' : '通知关'}</span>
          </div>
          <div className="flex items-center justify-between gap-3 text-[11px]">
            <span className="text-slate-500">传输</span>
            <span data-transport={state.transport?.kind ?? 'ws'} className="font-mono">
              {state.transport?.kind === 'quic'
                ? 'QUIC（原生）'
                : state.transport?.kind === 'webtransport'
                  ? 'WebTransport (QUIC)'
                  : state.transport?.reason === 'quic-fallback' || state.transport?.reason === 'webtransport-fallback'
                    ? 'WebSocket（QUIC 回退）'
                    : 'WebSocket'}
            </span>
          </div>
        </section>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            data-profile-theme
            aria-label="切换主题"
            onClick={() => imStore.cycleTheme()}
            className="rounded-lg border border-slate-200 px-2.5 py-2 text-xs text-slate-600 transition hover:border-indigo-400 dark:border-slate-700 dark:text-slate-300"
          >
            主题：{themeLabel}
          </button>
          <button
            type="button"
            data-profile-notifications={state.notifications ? 'on' : 'off'}
            aria-label="切换系统通知"
            onClick={() => {
              if (state.notifications) imStore.disableNotifications();
              else void imStore.enableNotifications();
            }}
            className={`rounded-lg border px-2.5 py-2 text-xs transition ${
              state.notifications
                ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
                : 'border-slate-200 text-slate-600 hover:border-indigo-400 dark:border-slate-700 dark:text-slate-300'
            }`}
          >
            通知：{state.notifications ? '已开启' : '已关闭'}
          </button>
          {install.available ? (
            <button
              type="button"
              data-profile-install
              onClick={() => void install.install()}
              className="col-span-2 rounded-lg border border-indigo-300 px-2.5 py-2 text-xs text-indigo-600 transition hover:border-indigo-500 dark:border-indigo-800 dark:text-indigo-300"
            >
              安装到桌面 / 主屏
            </button>
          ) : null}
        </div>

        <button
          type="button"
          data-profile-logout
          onClick={() => {
            if (!window.confirm('退出登录？')) return;
            onClose();
            imStore.logout();
          }}
          className="w-full rounded-lg border border-rose-200 px-3 py-1.5 text-sm text-rose-600 transition hover:border-rose-400 dark:border-rose-900 dark:text-rose-300"
        >
          退出登录
        </button>
      </div>
    </dialog>
  );
}
