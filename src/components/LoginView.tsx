import { useState, type FormEvent } from 'react';

import { imStore, useIm } from '../app/store';

type Mode = 'login' | 'register';

/** Login / sign-up card. Registration returns tokens, so it enters the app directly. */
export function LoginView() {
  const state = useIm();
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('alice');
  const [password, setPassword] = useState('password');
  const [nickname, setNickname] = useState('');
  const [endpoint, setEndpoint] = useState(state.endpoint);
  const busy = state.status === 'authenticating';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (mode === 'login') {
        await imStore.login(username, password, endpoint);
      } else {
        await imStore.register(username, password, nickname, endpoint);
      }
    } catch {
      // The store already surfaced the reason through state.authError.
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    if (next === 'register' && username === 'alice') {
      setUsername('');
      setPassword('');
      setNickname('');
    }
    if (next === 'login' && username === '') {
      setUsername('alice');
      setPassword('password');
    }
  };

  if (state.status === 'restoring') {
    return (
      <div className="grid min-h-full place-items-center bg-slate-50 dark:bg-slate-950">
        <p className="text-sm text-slate-500">正在恢复会话…</p>
      </div>
    );
  }

  const isRegister = mode === 'register';

  return (
    <div className="grid min-h-full place-items-center bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div className="w-full max-w-[420px] rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-900/5 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-5 flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-linear-to-br from-indigo-500 to-violet-500 font-bold tracking-wide text-white">
            ZIM
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">ZIM Web 客户端</h1>
            <p className="text-xs text-slate-500">React + TypeScript · Web / PC / App 同一套代码</p>
          </div>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
          {(['login', 'register'] as Mode[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => switchMode(item)}
              className={`rounded-lg py-1.5 text-sm transition ${
                mode === item
                  ? 'bg-white font-semibold text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-50'
                  : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              {item === 'login' ? '登录' : '注册'}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">账号</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
              minLength={3}
              maxLength={32}
              placeholder={isRegister ? '字母开头，3-32 位字母/数字/下划线' : ''}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-3 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-800 dark:focus:ring-indigo-900/40"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              required
              minLength={isRegister ? 8 : undefined}
              placeholder={isRegister ? '至少 8 位' : ''}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-3 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-800 dark:focus:ring-indigo-900/40"
            />
          </label>

          {isRegister ? (
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500">昵称（可选）</span>
              <input
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                maxLength={32}
                placeholder="默认与账号相同"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-3 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-800 dark:focus:ring-indigo-900/40"
              />
            </label>
          ) : null}

          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">接入地址</span>
            <input
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="留空 = 同源（Web/PWA 推荐）"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-3 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-800 dark:focus:ring-indigo-900/40"
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              桌面端（Tauri）与 App（Capacitor）填服务器地址，例如 https://im.example.com
            </span>
          </label>

          {state.authError ? (
            <p role="alert" className="text-xs text-rose-600">
              {state.authError}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-progress disabled:opacity-60"
          >
            {busy ? '请稍候…' : isRegister ? '注册并进入' : '登录'}
          </button>
        </form>

        <p className="mt-5 text-xs leading-relaxed text-slate-500">
          开发种子账号：<code className="rounded bg-indigo-50 px-1 dark:bg-indigo-950">alice</code> /{' '}
          <code className="rounded bg-indigo-50 px-1 dark:bg-indigo-950">bob</code>，密码{' '}
          <code className="rounded bg-indigo-50 px-1 dark:bg-indigo-950">password</code>。
        </p>
      </div>
    </div>
  );
}
