// Remembers the last successful login so the form is pre-filled instead of
// showing hard-coded demo credentials.
//
// The password lives in localStorage only when the user keeps 「记住密码」 on;
// it never leaves this browser and can be cleared with the checkbox.

const LOGIN_KEY = 'zim.login.v1';
const ENDPOINT_KEY = 'zim.endpoint';

export interface LoginPrefs {
  username: string;
  password: string;
  remember: boolean;
  endpoint: string;
  /** Most recent usernames, newest first (used for a quick picker). */
  recent: string[];
}

const EMPTY: LoginPrefs = { username: '', password: '', remember: true, endpoint: '', recent: [] };

const normalizeRecent = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '').slice(0, 5)
    : []
);

export const loadLoginPrefs = (): LoginPrefs => {
  if (typeof localStorage === 'undefined') return { ...EMPTY };
  try {
    const raw = localStorage.getItem(LOGIN_KEY);
    const endpoint = localStorage.getItem(ENDPOINT_KEY) ?? '';
    if (!raw) return { ...EMPTY, endpoint };
    const parsed = JSON.parse(raw) as Partial<LoginPrefs>;
    return {
      username: typeof parsed.username === 'string' ? parsed.username : '',
      password: typeof parsed.password === 'string' ? parsed.password : '',
      remember: parsed.remember !== false,
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : endpoint,
      recent: normalizeRecent(parsed.recent),
    };
  } catch {
    return { ...EMPTY };
  }
};

export const saveLoginPrefs = (prefs: Omit<LoginPrefs, 'recent'>): LoginPrefs => {
  const previous = loadLoginPrefs();
  const next: LoginPrefs = {
    username: prefs.username,
    password: prefs.remember ? prefs.password : '',
    remember: prefs.remember,
    endpoint: prefs.endpoint,
    recent: [prefs.username, ...previous.recent.filter((item) => item !== prefs.username)].slice(0, 5),
  };
  try {
    localStorage.setItem(LOGIN_KEY, JSON.stringify(next));
    localStorage.setItem(ENDPOINT_KEY, next.endpoint);
  } catch {
    // Private mode / quota: the session still works, only the prefill is lost.
  }
  return next;
};

export const clearLoginPrefs = (): void => {
  try {
    localStorage.removeItem(LOGIN_KEY);
  } catch {
    // ignore
  }
};
