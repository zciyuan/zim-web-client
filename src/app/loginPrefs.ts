// Remembers only the last account (and endpoint) so the login form is prefilled.
//
// Passwords are deliberately NOT stored here: they belong to the browser's
// password manager. The form uses `autocomplete="username"` /
// `autocomplete="current-password"` and reports a successful login through the
// Credential Management API (Chromium), which is what Chrome/Edge use to offer
// "save password". Safari/Firefox rely on their own autofill heuristics over the
// same standard autocomplete attributes.
//
// Older builds stored a plaintext password in `zim.login.v1`: loading migrates
// the record and rewrites it without the secret.

const LOGIN_KEY = 'zim.login.v1';
const ENDPOINT_KEY = 'zim.endpoint';

export interface LoginPrefs {
  username: string;
  endpoint: string;
  /** Most recent usernames, newest first (used for a quick picker). */
  recent: string[];
}

const EMPTY: LoginPrefs = { username: '', endpoint: '', recent: [] };

const normalizeRecent = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '').slice(0, 5)
    : []
);

const write = (prefs: LoginPrefs): void => {
  try {
    localStorage.setItem(LOGIN_KEY, JSON.stringify(prefs));
    localStorage.setItem(ENDPOINT_KEY, prefs.endpoint);
  } catch {
    // Private mode / quota: the session still works, only the prefill is lost.
  }
};

export const loadLoginPrefs = (): LoginPrefs => {
  if (typeof localStorage === 'undefined') return { ...EMPTY };
  try {
    const raw = localStorage.getItem(LOGIN_KEY);
    const endpoint = localStorage.getItem(ENDPOINT_KEY) ?? '';
    if (!raw) return { ...EMPTY, endpoint };
    const parsed = JSON.parse(raw) as Partial<LoginPrefs> & { password?: unknown; remember?: unknown };
    const prefs: LoginPrefs = {
      username: typeof parsed.username === 'string' ? parsed.username : '',
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : endpoint,
      recent: normalizeRecent(parsed.recent),
    };
    if (typeof parsed.password === 'string' || parsed.remember !== undefined) {
      // Migrate the old plaintext record away.
      write(prefs);
    }
    return prefs;
  } catch {
    return { ...EMPTY };
  }
};

export const saveLoginPrefs = (prefs: { username: string; endpoint: string }): LoginPrefs => {
  const previous = loadLoginPrefs();
  const next: LoginPrefs = {
    username: prefs.username,
    endpoint: prefs.endpoint,
    recent: [prefs.username, ...previous.recent.filter((item) => item !== prefs.username)].slice(0, 5),
  };
  write(next);
  return next;
};

/**
 * Reports a successful login to the browser password manager.
 *
 * Chromium exposes the Credential Management API: storing a PasswordCredential
 * shows the "save password?" prompt. Other browsers ignore it and fall back to
 * their own autofill heuristics, so a failure here must never block the login.
 */
export const offerPasswordSave = (username: string, password: string, displayName?: string): void => {
  if (typeof window === 'undefined' || !password) return;
  const container = navigator.credentials as (CredentialsContainer & { store?: (credential: unknown) => Promise<unknown> }) | undefined;
  const PasswordCredentialCtor = (window as unknown as {
    PasswordCredential?: new (init: { id: string; password: string; name?: string }) => unknown;
  }).PasswordCredential;
  if (!container?.store || !PasswordCredentialCtor) return;
  try {
    const credential = new PasswordCredentialCtor({
      id: username,
      password,
      ...(displayName ? { name: displayName } : {}),
    });
    void container.store(credential).catch(() => undefined);
  } catch {
    // The API is optional; the standard autocomplete attributes still work.
  }
};
