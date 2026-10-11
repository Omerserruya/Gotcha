/**
 * The two per-device switches for an incoming message: a chime, and a desktop
 * notification. Read by the shell's listener and written by Settings ·
 * Notifications, which is why they live here: the shell may not import a
 * feature, and a feature may not import the shell.
 *
 * ── WHY THE BROWSER, AND NOT THE PERSON'S PREFERENCES ──
 * `GET/PATCH /api/notification-preferences/me` has inApp, email, whatsapp,
 * approvals and quiet hours - no sound and no desktop field - and the
 * permission to show a desktop notification is the BROWSER's, granted per
 * site per browser. A switch stored on the person would say "on" on a laptop
 * that never granted it. So: localStorage, per device, and no invented field.
 *
 * ── STORAGE THAT THROWS ──
 * A private window, blocked site data or a sandboxed frame can make every
 * localStorage access throw. Each one is wrapped; the switches then hold in
 * memory for this page's life, and `kept: false` lets the screen say so.
 */

export interface DeviceAlertSettings {
  /** A chime for an incoming customer message. On unless switched off. */
  readonly sound: boolean;
  /** A desktop notification. Off until the person turns it on (and the browser allows it). */
  readonly desktop: boolean;
}

export const DEVICE_ALERT_DEFAULTS: DeviceAlertSettings = { sound: true, desktop: false };

/** The localStorage key. One JSON object, so the two switches change together. */
export const DEVICE_ALERTS_KEY = 'gotcha:device-alerts';

/** Same-tab change signal: the `storage` event fires only in OTHER tabs. */
const CHANGED_EVENT = 'gotcha:device-alerts-changed';

export interface DeviceAlertSnapshot {
  readonly settings: DeviceAlertSettings;
  /** False when this browser refused storage: the switches last until a reload. */
  readonly kept: boolean;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** What was set while storage refused - this page only. */
let memory: DeviceAlertSettings | null = null;

function browserStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): DeviceAlertSettings {
  if (!raw) return DEVICE_ALERT_DEFAULTS;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    return {
      sound: typeof value?.sound === 'boolean' ? value.sound : DEVICE_ALERT_DEFAULTS.sound,
      desktop: typeof value?.desktop === 'boolean' ? value.desktop : DEVICE_ALERT_DEFAULTS.desktop,
    };
  } catch {
    return DEVICE_ALERT_DEFAULTS;
  }
}

/** The switches as this device holds them. Never throws. */
export function readDeviceAlerts(store: Store | null = browserStore()): DeviceAlertSnapshot {
  if (!store) return { settings: memory ?? DEVICE_ALERT_DEFAULTS, kept: false };
  try {
    return { settings: parse(store.getItem(DEVICE_ALERTS_KEY)), kept: true };
  } catch {
    return { settings: memory ?? DEVICE_ALERT_DEFAULTS, kept: false };
  }
}

/** Sets the switches; true when the browser kept them. Never throws. */
export function writeDeviceAlerts(
  next: DeviceAlertSettings,
  store: Store | null = browserStore(),
): boolean {
  memory = next;
  let kept = false;
  try {
    store?.setItem(DEVICE_ALERTS_KEY, JSON.stringify(next));
    kept = store !== null;
  } catch {
    kept = false;
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED_EVENT));
  return kept;
}

/**
 * The snapshot for `useSyncExternalStore`: the same object until something
 * changes, which that hook requires.
 */
let cached: { key: string; snapshot: DeviceAlertSnapshot } | null = null;
export function deviceAlertsSnapshot(): DeviceAlertSnapshot {
  const read = readDeviceAlerts();
  const key = `${read.kept}:${read.settings.sound}:${read.settings.desktop}`;
  if (cached?.key !== key) cached = { key, snapshot: read };
  return cached.snapshot;
}

/** What the server renders: the defaults, kept (nothing has refused yet). */
export const SERVER_DEVICE_ALERTS: DeviceAlertSnapshot = {
  settings: DEVICE_ALERT_DEFAULTS,
  kept: true,
};

/** Calls `onChange` when the switches change, in this tab or another. */
export function subscribeDeviceAlerts(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const fromOtherTab = (event: StorageEvent) => {
    if (event.key === null || event.key === DEVICE_ALERTS_KEY) onChange();
  };
  window.addEventListener('storage', fromOtherTab);
  window.addEventListener(CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', fromOtherTab);
    window.removeEventListener(CHANGED_EVENT, onChange);
  };
}

/* ── The browser's permission for a desktop notification ─────────────── */

/** `unsupported`: this browser has no `Notification` at all. */
export type DesktopPermission = 'unsupported' | 'default' | 'granted' | 'denied';

const PERMISSION_EVENT = 'gotcha:desktop-permission-changed';

export function desktopPermission(): DesktopPermission {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    const value = window.Notification.permission;
    return value === 'granted' || value === 'denied' ? value : 'default';
  } catch {
    return 'unsupported';
  }
}

/**
 * Asks the browser, and answers what it decided. Must be called from the
 * click itself: browsers ignore a permission request without a gesture.
 * Takes both forms - the promise, and the callback older Safari still uses.
 */
export function requestDesktopPermission(): Promise<DesktopPermission> {
  return new Promise((resolve) => {
    const done = () => {
      resolve(desktopPermission());
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(PERMISSION_EVENT));
    };
    try {
      if (desktopPermission() === 'unsupported') {
        done();
        return;
      }
      const asked = window.Notification.requestPermission(() => done()) as
        Promise<NotificationPermission> | undefined;
      asked?.then(done, done);
    } catch {
      done();
    }
  });
}

/**
 * Calls `onChange` when the permission may have changed: after a request, and
 * when the window regains focus (the person may be back from the site's
 * settings, where a block is lifted).
 */
export function subscribeDesktopPermission(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(PERMISSION_EVENT, onChange);
  window.addEventListener('focus', onChange);
  return () => {
    window.removeEventListener(PERMISSION_EVENT, onChange);
    window.removeEventListener('focus', onChange);
  };
}

/* ── Quiet hours changed on the settings page ────────────────────────── */

/** Same-tab signal; other tabs hear it on the BroadcastChannel below. */
export const PREFERENCES_CHANGED_EVENT = 'gotcha:notification-preferences-changed';
export const PREFERENCES_CHANNEL = 'gotcha:notification-preferences';

/**
 * The person saved their notification preferences (quiet hours). Every open
 * tab re-reads them once - not per message.
 */
export function announcePreferencesChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(PREFERENCES_CHANGED_EVENT));
  try {
    const channel = new BroadcastChannel(PREFERENCES_CHANNEL);
    channel.postMessage('changed');
    channel.close();
  } catch {
    // No BroadcastChannel: the other tabs read them again on their next load.
  }
}
