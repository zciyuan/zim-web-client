import { useCallback, useEffect, useState } from 'react';

import { Avatar } from './Avatar';
import { errorText, imStore, useIm } from '../app/store';
import { roleLabel } from '../app/format';
import type { Group, GroupMember } from '../sdk/types';

export interface GroupApply {
  user_id: string;
  why?: string;
  status?: number;
}

interface GroupSettingsDialogProps {
  open: boolean;
  gid: string;
  onClose: () => void;
}

type Tab = 'info' | 'members' | 'requests';

/**
 * Group console: profile + notice, member administration (mute / kick / admin /
 * transfer), invite, mute-all, notification setting and join-request review.
 * Owner-only actions are hidden rather than disabled, so the common case stays
 * uncluttered.
 */
export function GroupSettingsDialog({ open, gid, onClose }: GroupSettingsDialogProps) {
  const state = useIm();
  const [dialogEl, setDialogEl] = useState<HTMLDialogElement | null>(null);
  const [tab, setTab] = useState<Tab>('info');
  const [detail, setDetail] = useState<Group | null>(null);
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [applies, setApplies] = useState<GroupApply[]>([]);
  const [inviteUids, setInviteUids] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [name, setName] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const selfUid = state.me?.uid ?? '';
  const myRole = members?.find((member) => String(member.user_id) === selfUid)?.role ?? 0;
  const isOwner = myRole === 2;
  const isAdmin = isOwner || myRole === 1;

  const loadAll = useCallback(async () => {
    setError('');
    try {
      const [info, list] = await Promise.all([imStore.groupDetail(gid), imStore.groupMembers(gid)]);
      setDetail(info);
      setName(info?.name ?? '');
      setNotice(info?.notification ?? '');
      setMembers(list);
    } catch (err) {
      setError(errorText(err));
    }
    try {
      setApplies(((await imStore.groupApplies(gid)) as GroupApply[]) ?? []);
    } catch {
      setApplies([]);
    }
  }, [gid]);

  useEffect(() => {
    if (!open) return;
    void loadAll();
  }, [open, loadAll]);

  useEffect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) dialogEl.showModal();
    if (!open && dialogEl.open) dialogEl.close();
  }, [open, dialogEl]);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try {
      await action();
      await loadAll();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  // Filter members by nickname / username / uid; role order keeps admins visible.
  const filteredMembers = members === null
    ? null
    : members
      .filter((member) => {
        const needle = memberQuery.trim().toLowerCase();
        if (!needle) return true;
        const name = (member.nickname || member.username || '').toLowerCase();
        return name.includes(needle) || String(member.user_id).includes(needle);
      })
      .sort((a, b) => Number(b.role ?? 0) - Number(a.role ?? 0));

  const memberRow = (member: GroupMember) => {
    const name = member.nickname || member.username || `用户 ${member.user_id}`;
    const isSelf = String(member.user_id) === selfUid;
    const isOwner = member.role === 2;
    const isGroupAdmin = member.role === 1;
    return (
      <div
        key={String(member.user_id)}
        data-member-row={member.user_id}
        data-member-role={member.role ?? 0}
        className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/60"
      >
        <Avatar name={name} seed={member.user_id} size={28} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{name}</span>
        {isOwner || isGroupAdmin ? (
          <span
            data-role-badge={isOwner ? 'owner' : 'admin'}
            className={`shrink-0 rounded px-1 text-[10px] font-medium ${
              isOwner
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
            }`}
          >
            {roleLabel(member.role)}
          </span>
        ) : null}
        {!isSelf && isAdmin ? (
          <span className="flex shrink-0 gap-1 text-[11px]">
            {isOwner ? (
              <button type="button" className="rounded border border-slate-200 px-1.5 py-0.5 dark:border-slate-700" onClick={() => void run('admin', () => imStore.setGroupAdmin(gid, String(member.user_id), member.role !== 1))}>
                {member.role === 1 ? '取消管理' : '设管理'}
              </button>
            ) : null}
            <button type="button" className="rounded border border-slate-200 px-1.5 py-0.5 dark:border-slate-700" onClick={() => void run('mute', () => imStore.muteGroupMember(gid, String(member.user_id), Number(member.mute_until) > Date.now() ? 0 : 30))}>
              {Number(member.mute_until) > Date.now() ? '解除禁言' : '禁言30分'}
            </button>
            {isOwner ? (
              <button type="button" className="rounded border border-rose-200 px-1.5 py-0.5 text-rose-600 dark:border-rose-900" onClick={() => { if (window.confirm(`移出 ${name}？`)) void run('kick', () => imStore.kickGroupMember(gid, String(member.user_id))); }}>
                移出
              </button>
            ) : null}
            {isOwner ? (
              <button type="button" className="rounded border border-slate-200 px-1.5 py-0.5 dark:border-slate-700" onClick={() => { if (window.confirm(`把群主转让给 ${name}？`)) void run('transfer', () => imStore.transferGroup(gid, String(member.user_id))); }}>
                转让
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <dialog
      ref={setDialogEl}
      onClose={onClose}
      className="w-[min(560px,94vw)] rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-900/40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <h3 className="text-sm font-semibold">群设置 · {detail?.name ?? gid}</h3>
        <button type="button" onClick={() => dialogEl?.close()} className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-500 dark:border-slate-700">
          关闭
        </button>
      </header>

      <div className="flex gap-1 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
        {(['info', 'members', 'requests'] as Tab[]).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={`rounded-lg px-2.5 py-1 text-xs ${tab === item ? 'bg-indigo-50 font-semibold text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300' : 'text-slate-500'}`}
          >
            {item === 'info' ? '群资料' : item === 'members' ? `成员${members ? `（${members.length}）` : ''}` : `入群申请${applies.length ? `（${applies.length}）` : ''}`}
          </button>
        ))}
      </div>

      <div className="max-h-[60vh] overflow-y-auto p-4">
        {error ? <p className="mb-2 text-xs text-rose-600">{error}</p> : null}

        {tab === 'info' ? (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500">群名称</span>
              <input value={name} onChange={(event) => setName(event.target.value)} disabled={!isAdmin} className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500">群公告</span>
              <textarea value={notice} onChange={(event) => setNotice(event.target.value)} rows={3} disabled={!isAdmin} className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" />
            </label>
            {isAdmin ? (
              <button type="button" disabled={busy === 'info'} onClick={() => void run('info', () => imStore.updateGroupInfo(gid, { name, notification: notice }))} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                保存资料
              </button>
            ) : null}

            <div className="flex flex-wrap gap-1.5 border-t border-slate-100 pt-3 dark:border-slate-800">
              {isAdmin ? (
                <button type="button" className="rounded-lg border border-slate-200 px-2 py-1 text-xs dark:border-slate-700" onClick={() => void run('muteall', () => imStore.muteAllGroup(gid, 30))}>
                  全员禁言 30 分
                </button>
              ) : null}
              <button type="button" className="rounded-lg border border-slate-200 px-2 py-1 text-xs dark:border-slate-700" onClick={() => void run('notify', () => imStore.setGroupNotify(gid, 1))}>
                关闭本群提醒
              </button>
              <button type="button" className="rounded-lg border border-slate-200 px-2 py-1 text-xs dark:border-slate-700" onClick={() => void run('notify', () => imStore.setGroupNotify(gid, 0))}>
                开启本群提醒
              </button>
              {isOwner ? (
                <button type="button" className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-600 dark:border-rose-900" onClick={() => { if (window.confirm('解散该群？不可恢复')) void run('dismiss', () => imStore.dismissGroup(gid)); }}>
                  解散群
                </button>
              ) : (
                <button type="button" className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-600 dark:border-rose-900" onClick={() => { if (window.confirm('退出该群？')) void run('quit', () => imStore.quitGroup(gid)); }}>
                  退出群
                </button>
              )}
            </div>
          </div>
        ) : null}

        {tab === 'members' ? (
          <div>
            <div className="mb-2 flex gap-1.5">
              <input value={inviteUids} onChange={(event) => setInviteUids(event.target.value)} placeholder="邀请好友 uid，逗号分隔" className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-800" />
              <button type="button" className="rounded-lg border border-slate-200 px-2 py-1 text-xs dark:border-slate-700" onClick={() => void run('invite', async () => { const ids = inviteUids.split(',').map((item) => item.trim()).filter(Boolean); if (ids.length) await imStore.inviteGroupMembers(gid, ids); setInviteUids(''); })}>
                邀请
              </button>
            </div>
            <input
              value={memberQuery}
              onChange={(event) => setMemberQuery(event.target.value)}
              placeholder="搜索成员昵称或 uid"
              aria-label="搜索群成员"
              className="mb-2 w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-800"
            />
            {members === null ? <p className="py-6 text-center text-xs text-slate-500">加载中…</p> : null}
            {filteredMembers?.map(memberRow)}
            {filteredMembers && filteredMembers.length === 0 && (members?.length ?? 0) > 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">没有匹配的成员</p>
            ) : null}
            {members && members.length === 0 ? <p className="py-6 text-center text-xs text-slate-500">没有成员</p> : null}
          </div>
        ) : null}

        {tab === 'requests' ? (
          <div>
            {applies.length === 0 ? <p className="py-6 text-center text-xs text-slate-500">没有待处理的入群申请</p> : null}
            {applies.map((apply) => (
              <div key={String(apply.user_id)} className="flex items-center gap-2 rounded-xl px-2 py-1.5">
                <Avatar name={`用户 ${apply.user_id}`} seed={apply.user_id} size={28} />
                <span className="min-w-0 flex-1 truncate text-[13px]">用户 {apply.user_id}{apply.why ? ` · ${apply.why}` : ''}</span>
                <button type="button" className="rounded border border-emerald-200 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:border-emerald-900" onClick={() => void run('answer', () => imStore.answerJoinGroup(gid, String(apply.user_id), true))}>
                  同意
                </button>
                <button type="button" className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] dark:border-slate-700" onClick={() => void run('answer', () => imStore.answerJoinGroup(gid, String(apply.user_id), false))}>
                  拒绝
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
