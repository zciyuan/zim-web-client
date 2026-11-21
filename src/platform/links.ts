// External links: a chat message must open the system browser, never replace
// the app's own WebView. Native shells intercept anchor clicks.

import { platform } from './detect';

let interceptorReady = false;

export const openExternal = (url: string): void => {
  if (!/^https?:\/\//i.test(url)) return;
  if (platform.kind === 'tauri') {
    void import('@tauri-apps/plugin-opener')
      .then(({ openUrl }) => openUrl(url))
      .catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
    return;
  }
  if (platform.mobile) {
    void import('@capacitor/browser')
      .then(({ Browser }) => Browser.open({ url }))
      .catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
};

export const initLinkInterceptor = (): void => {
  if (interceptorReady || !platform.native || typeof document === 'undefined') return;
  interceptorReady = true;
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const href = anchor.href;
    if (!/^https?:\/\//i.test(href) || anchor.hasAttribute('download')) return;
    event.preventDefault();
    event.stopPropagation();
    openExternal(href);
  }, true);
};
