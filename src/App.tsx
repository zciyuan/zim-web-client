import { useEffect } from 'react';

import { CallOverlay } from './components/CallOverlay';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LoginView } from './components/LoginView';
import { Toast } from './components/Toast';
import { Workspace } from './components/Workspace';
import { imStore, useIm } from './app/store';

export default function App() {
  const state = useIm();

  useEffect(() => {
    void imStore.restore();
  }, []);

  useEffect(() => {
    const onVisible = () => imStore.onVisible();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
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
