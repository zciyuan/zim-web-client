// System notifications for background messages.
//
// Web/PWA uses the Notification API; the desktop shell uses Tauri's notification
// plugin; the app uses Capacitor local notifications. Permission is requested
// only from an explicit user gesture (the bell button in Settings).

import { platform } from './detect';
import type { NotificationPermissionState } from './types';

export interface SystemNotification {
  title: string;
  body: string;
  /** Collapses repeated notifications of the same conversation on the web. */
  tag?: string;
  /** Invoked when the notification is activated (web + app). */
  onClick?: () => void;
}

type CapacitorPermission = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale';

const mapCapacitorPermission = (state: CapacitorPermission): NotificationPermissionState => {
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'default';
};

const loadCapacitorNotifications = () => import('@capacitor/local-notifications');

export const notificationPermission = async (): Promise<NotificationPermissionState> => {
  try {
    if (platform.kind === 'tauri') {
      const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
      return (await isPermissionGranted()) ? 'granted' : 'default';
    }
    if (platform.mobile) {
      const { LocalNotifications } = await loadCapacitorNotifications();
      const result = await LocalNotifications.checkPermissions();
      return mapCapacitorPermission(result.display);
    }
  } catch {
    return 'unsupported';
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
};

export const requestNotificationPermission = async (): Promise<boolean> => {
  try {
    if (platform.kind === 'tauri') {
      const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
      if (await isPermissionGranted()) return true;
      return (await requestPermission()) === 'granted';
    }
    if (platform.mobile) {
      const { LocalNotifications } = await loadCapacitorNotifications();
      const result = await LocalNotifications.requestPermissions();
      return result.display === 'granted';
    }
  } catch {
    return false;
  }
  if (typeof Notification === 'undefined') return false;
  return (await Notification.requestPermission()) === 'granted';
};

/** Capacitor notification ids must stay 32-bit ints. */
let nextNotificationId = 1000;
const actionHandlers = new Map<number, () => void>();
let capacitorListenerReady = false;
let capacitorChannelReady = false;

const prepareCapacitorNotifications = async () => {
  const { LocalNotifications } = await loadCapacitorNotifications();
  if (!capacitorChannelReady) {
    capacitorChannelReady = true;
    await LocalNotifications.createChannel({
      id: 'zim-messages',
      name: 'ZIM 消息',
      description: '新消息提醒',
      importance: 4,
      visibility: 1,
      vibration: true,
    }).catch(() => undefined);
  }
  if (!capacitorListenerReady) {
    capacitorListenerReady = true;
    await LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
      const handler = actionHandlers.get(event.notification.id);
      if (!handler) return;
      actionHandlers.delete(event.notification.id);
      handler();
    }).catch(() => undefined);
  }
  return LocalNotifications;
};

export const showNotification = async (payload: SystemNotification): Promise<boolean> => {
  if ((await notificationPermission()) !== 'granted') return false;
  try {
    if (platform.kind === 'tauri') {
      const { sendNotification } = await import('@tauri-apps/plugin-notification');
      sendNotification({ title: payload.title, body: payload.body });
      return true;
    }
    if (platform.mobile) {
      const LocalNotifications = await prepareCapacitorNotifications();
      const id = nextNotificationId++;
      if (payload.onClick) actionHandlers.set(id, payload.onClick);
      await LocalNotifications.schedule({
        notifications: [{
          id,
          title: payload.title,
          body: payload.body,
          channelId: 'zim-messages',
          autoCancel: true,
          schedule: { at: new Date(Date.now() + 150) },
        }],
      });
      return true;
    }
    if (typeof Notification === 'undefined') return false;
    const notification = new Notification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      silent: false,
    });
    notification.onclick = () => {
      payload.onClick?.();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
};
