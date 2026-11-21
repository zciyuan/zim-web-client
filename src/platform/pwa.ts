// PWA install prompt. Chrome fires `beforeinstallprompt` once; we hold it until
// the user taps "安装应用" in Settings.

import { platform } from './detect';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let pendingPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

export const initPwaInstallPrompt = (): void => {
  if (!platform.capabilities.installPrompt || typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    pendingPrompt = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    pendingPrompt = null;
    emit();
  });
};

export const getInstallPrompt = (): BeforeInstallPromptEvent | null => pendingPrompt;

export const subscribeInstallPrompt = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const promptPwaInstall = async (): Promise<boolean> => {
  const prompt = pendingPrompt;
  if (!prompt) return false;
  pendingPrompt = null;
  emit();
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    return choice.outcome === 'accepted';
  } catch {
    return false;
  }
};
