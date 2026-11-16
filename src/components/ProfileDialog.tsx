import { useEffect, useState } from 'react';

import { Avatar } from './Avatar';
import { imStore, useIm } from '../app/store';

/** Edits the signed-in user's nickname and avatar. */
export function ProfileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useIm();
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNickname(state.me?.name ?? '');
    setAvatar(state.me?.avatar ?? '');
    setBusy(false);
  }, [open, state.me?.name, state.me?.avatar]);

  if (!open) return null;

  const save = async () => {
    setBusy(true);
    try {
      await imStore.updateProfile({ nickname, avatar });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      open
      aria-label="个人资料"
      className="w-[min(380px,94vw)] rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-slate-700">
        <h3 className="text-sm font-semibold">个人资料</h3>
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
      </div>
    </dialog>
  );
}
