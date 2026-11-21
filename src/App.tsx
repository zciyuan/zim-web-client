import { useEffect } from 'react';

import { CallOverlay } from './components/CallOverlay';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LoginView } from './components/LoginView';
import { Toast } from './components/Toast';
import { Workspace } from './components/Workspace';
import { imStore, useIm } from './app/store';
import { setHardwareBackHandler } from './platform';

export default function App() {
  const state = useIm();

  useEffect(() => {
    void imStore.restore();
  }, []);

  useEffect(() => {
    const onVisible = () => imStore.onVisible();
    document.addEventListener('visibilitychange', onVisible);
    // Capacitor appStateChange (background -> foreground) cannot rely on the
    // document event in every WebView, so the shell dispatches this as well.
    window.addEventListener('zim:resume', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('zim:resume', onVisible);
    };
  }, []);

  // Android hardware back: close a dialog, leave a chat, return to the first
  // tab, then let the shell exit the app.
  useEffect(() => {
    setHardwareBackHandler(() => {
      const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].pop();
      if (dialog) {
        dialog.close();
        return true;
      }
      if (document.querySelector('[data-message-menu-overlay]')) {
        document.querySelector<HTMLElement>('[data-message-menu-overlay]')?.click();
        return true;
      }
      const preview = document.querySelector<HTMLElement>('[data-image-preview]');
      if (preview) {
        preview.click();
        return true;
      }
      const snapshot = imStore.getSnapshot();
      if (snapshot.activeCid) {
        imStore.clearActive();
        return true;
      }
      if (snapshot.tab !== 'conversations') {
        imStore.setTab('conversations');
        return true;
      }
      return false;
    });
    return () => setHardwareBackHandler(null);
  }, []);

  const ready = state.status === 'ready' && state.me !== null;

  return (
    <ErrorBoundary>
      {ready ? <Workspace /> : <LoginView />}
      <CallOverlay />
      <Toast />
    </ErrorBoundary>
  );
}
