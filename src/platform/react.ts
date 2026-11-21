import { useEffect, useState, useSyncExternalStore } from 'react';

import { platform } from './detect';
import type { PlatformInfo } from './types';
import { getInstallPrompt, promptPwaInstall, subscribeInstallPrompt } from './pwa';

export const usePlatform = (): PlatformInfo => platform;

/** Reactive CSS media query (layout decisions still live in Tailwind/CSS). */
export const useMediaQuery = (query: string): boolean => {
  const [matches, setMatches] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  ));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
};

export interface InstallPromptHandle {
  available: boolean;
  install: () => Promise<boolean>;
}

/** Reactive view of the browser's PWA install prompt. */
export const useInstallPrompt = (): InstallPromptHandle => {
  const available = useSyncExternalStore(
    subscribeInstallPrompt,
    () => getInstallPrompt() !== null,
    () => false,
  );
  return { available, install: promptPwaInstall };
};
