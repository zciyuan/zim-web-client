import { useEffect, useRef, useState } from 'react';

import { Avatar } from './Avatar';
import { errorText, imStore } from '../app/store';
import { roleLabel } from '../app/format';
import type { GroupMember } from '../sdk/types';

interface MembersDialogProps {
  open: boolean;
  gid: string;
  title: string;
  onClose: () => void;
}

export function MembersDialog({ open, gid, title, onClose }: MembersDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open || !gid) return;
    let cancelled = false;
    setMembers(null);
    setError('');
    imStore
      .groupMembers(gid)
      .then((list) => {
        if (!cancelled) setMembers(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, gid]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="w-[min(420px,92vw)] rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-900/40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <h3 className="text-sm font-semibold">群成员 · {title}</h3>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-500 dark:border-slate-700"
        >
          关闭
        </button>
      </header>
      <div className="max-h-[60vh] overflow-y-auto p-2">
        {error ? <p className="px-3 py-6 text-center text-sm text-rose-600">{error}</p> : null}
        {!error && members === null ? <p className="px-3 py-6 text-center text-sm text-slate-500">加载中…</p> : null}
        {!error && members?.length === 0 ? <p className="px-3 py-6 text-center text-sm text-slate-500">没有成员信息</p> : null}
        {members?.map((member) => {
          const name = member.nickname || member.username || `用户 ${String(member.user_id)}`;
          return (
            <div key={String(member.user_id)} className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/60">
              <Avatar name={name} seed={member.user_id} size={30} />
              <span className="text-[13px]">{name}</span>
              {member.role ? (
                <span className="ml-auto text-[11px] text-indigo-500">{roleLabel(member.role)}</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </dialog>
  );
}
