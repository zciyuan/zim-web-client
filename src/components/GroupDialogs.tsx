import { useEffect, useState } from 'react';

import { imStore, useIm } from '../app/store';
import { errorText } from '../app/store';
import type { GroupSummary } from '../sdk/groups';
import type { Group } from '../sdk/types';

type Mode = 'create' | 'join';

interface GroupDialogsProps {
  open: boolean;
  onClose: () => void;
}

/** Create a group from friends, or find one and apply to join. */
export function GroupDialogs({ open, onClose }: GroupDialogsProps) {
  const state = useIm();
  const [dialogEl, setDialogEl] = useState<HTMLDialogElement | null>(null);
  const [mode, setMode] = useState<Mode>('create');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<GroupSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) dialogEl.showModal();
    if (!open && dialogEl.open) dialogEl.close();
  }, [open, dialogEl]);

  const toggle = (uid: string) => {
    setSelected((current) => (current.includes(uid) ? current.filter((item) => item !== uid) : [...current, uid]));
  };

  const create = async () => {
    if (!name.trim()) {
      setError('请输入群名称');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const gid = await imStore.createGroup(name.trim(), selected);
      imStore.openGroup({ group_id: gid, name: name.trim() } as Group);
      setName('');
      setSelected([]);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const search = async () => {
    setBusy(true);
    setError('');
    try {
      setResults(await imStore.searchGroups(keyword.trim()));
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
        <h3 className="text-sm font-semibold">{mode === 'create' ? '创建群聊' : '加入群聊'}</h3>
        <button type="button" onClick={() => dialogEl?.close()} className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-500 dark:border-slate-700">
          关闭
        </button>
      </header>

      <div className="flex gap-1 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
        {(['create', 'join'] as Mode[]).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setMode(item)}
            className={`rounded-lg px-2.5 py-1 text-xs ${mode === item ? 'bg-indigo-50 font-semibold text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300' : 'text-slate-500'}`}
          >
            {item === 'create' ? '创建' : '搜索加入'}
          </button>
        ))}
      </div>

      <div className="max-h-[60vh] overflow-y-auto p-4">
        {error ? <p className="mb-2 text-xs text-rose-600">{error}</p> : null}

        {mode === 'create' ? (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500">群名称</span>
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={32} className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" />
            </label>
            <div>
              <span className="mb-1 block text-xs text-slate-500">选择成员（{selected.length}）</span>
              <div className="max-h-[240px] overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
                {state.friends.length === 0 ? <p className="p-3 text-xs text-slate-500">还没有好友</p> : null}
                {state.friends.map((friend) => {
                  const uid = String(friend.friend_id);
                  const label = friend.remark || friend.profile?.nickname || friend.profile?.username || uid;
                  return (
                    <label key={uid} className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[13px] hover:bg-slate-50 dark:hover:bg-slate-800/60">
                      <input type="checkbox" checked={selected.includes(uid)} onChange={() => toggle(uid)} />
                      <span className="truncate">{label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <button type="button" disabled={busy} onClick={() => void create()} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {busy ? '创建中…' : '创建群'}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-1.5">
              <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="群名称关键字" className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" />
              <button type="button" disabled={busy || !keyword.trim()} onClick={() => void search()} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs dark:border-slate-700 disabled:opacity-50">
                搜索
              </button>
            </div>
            {results?.length === 0 ? <p className="py-4 text-center text-xs text-slate-500">没有找到群</p> : null}
            {results?.map((group) => (
              <div key={group.group_id} className="flex items-center gap-2 rounded-xl px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[13px]">{group.name || group.group_id}</span>
                <span className="text-[11px] text-slate-400">{group.member_count} 人</span>
                <button type="button" className="rounded border border-indigo-200 px-1.5 py-0.5 text-[11px] text-indigo-600 dark:border-indigo-900" onClick={() => void imStore.applyJoinGroup(group.group_id, '')}>
                  申请加入
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </dialog>
  );
}
