import { useEffect, useState } from 'react';

import { Avatar } from './Avatar';
import { errorText, imStore, useIm } from '../app/store';
import type { UserProfile } from '../sdk/types';

interface AddFriendDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Search a user by account/nickname and send a friend request. */
export function AddFriendDialog({ open, onClose }: AddFriendDialogProps) {
  const state = useIm();
  const [dialogEl, setDialogEl] = useState<HTMLDialogElement | null>(null);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<UserProfile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) dialogEl.showModal();
    if (!open && dialogEl.open) dialogEl.close();
  }, [open, dialogEl]);

  const friendIds = new Set(state.friends.map((friend) => String(friend.friend_id)));

  const search = async () => {
    const term = keyword.trim();
    if (!term) return;
    setBusy(true);
    setError('');
    try {
      setResults(await imStore.searchUsers(term));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const send = async (uid: string) => {
    setBusy(true);
    setError('');
    try {
      await imStore.addFriend(uid);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={setDialogEl}
      onClose={onClose}
      className="m-auto max-h-[85dvh] w-[min(460px,92vw)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-900/40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <h3 className="text-sm font-semibold">添加好友</h3>
        <button type="button" onClick={() => dialogEl?.close()} className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-500 dark:border-slate-700">
          关闭
        </button>
      </header>

      <div className="space-y-3 p-4">
        <div className="flex gap-1.5">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void search();
              }
            }}
            placeholder="账号或昵称"
            className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
          />
          <button type="button" disabled={busy || !keyword.trim()} onClick={() => void search()} className="rounded-lg border border-slate-200 px-3 py-1 text-xs dark:border-slate-700 disabled:opacity-50">
            搜索
          </button>
        </div>

        {error ? <p className="text-xs text-rose-600">{error}</p> : null}
        {results?.length === 0 ? <p className="py-4 text-center text-xs text-slate-500">没有找到用户</p> : null}

        <div className="max-h-[300px] space-y-1 overflow-y-auto">
          {results?.map((profile) => {
            const uid = String(profile.uid);
            const name = profile.nickname || profile.username || uid;
            const isFriend = friendIds.has(uid);
            return (
              <div key={uid} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                <Avatar name={name} seed={uid} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{name}</span>
                  <span className="block text-[11px] text-slate-400">uid {uid}</span>
                </span>
                <button
                  type="button"
                  disabled={busy || isFriend || uid === state.me?.uid}
                  onClick={() => void send(uid)}
                  className="rounded border border-indigo-200 px-2 py-0.5 text-[11px] text-indigo-600 disabled:opacity-40 dark:border-indigo-900"
                >
                  {isFriend ? '已是好友' : '加好友'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </dialog>
  );
}
