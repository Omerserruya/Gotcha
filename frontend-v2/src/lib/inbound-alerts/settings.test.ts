import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEVICE_ALERT_DEFAULTS,
  DEVICE_ALERTS_KEY,
  desktopPermission,
  readDeviceAlerts,
  requestDesktopPermission,
  writeDeviceAlerts,
} from './settings';

/** A storage whose every call throws, as in a private window with site data blocked. */
const refusing = {
  getItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
};

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the per-device switches', () => {
  it('★ nothing stored: sound on, desktop off', () => {
    expect(DEVICE_ALERT_DEFAULTS).toEqual({ sound: true, desktop: false });
    expect(readDeviceAlerts()).toEqual({ settings: { sound: true, desktop: false }, kept: true });
  });

  it('kept in localStorage, and read back', () => {
    expect(writeDeviceAlerts({ sound: false, desktop: true })).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(DEVICE_ALERTS_KEY)!)).toEqual({
      sound: false,
      desktop: true,
    });
    expect(readDeviceAlerts().settings).toEqual({ sound: false, desktop: true });
  });

  it('a stored value that is not ours reads as the defaults, field by field', () => {
    window.localStorage.setItem(DEVICE_ALERTS_KEY, '{"sound":"yes","desktop":true}');
    expect(readDeviceAlerts().settings).toEqual({ sound: true, desktop: true });
    window.localStorage.setItem(DEVICE_ALERTS_KEY, 'not json');
    expect(readDeviceAlerts().settings).toEqual(DEVICE_ALERT_DEFAULTS);
  });

  it('★ storage that throws: no error, the switch holds for this page, and says it is not kept', () => {
    expect(readDeviceAlerts(refusing).kept).toBe(false);
    expect(writeDeviceAlerts({ sound: false, desktop: false }, refusing)).toBe(false);
    expect(readDeviceAlerts(refusing)).toEqual({
      settings: { sound: false, desktop: false },
      kept: false,
    });
  });

  it('a change is heard in this tab', () => {
    const heard = vi.fn();
    window.addEventListener('gotcha:device-alerts-changed', heard);
    writeDeviceAlerts({ sound: true, desktop: true });
    window.removeEventListener('gotcha:device-alerts-changed', heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('the browser’s permission', () => {
  it('★ no Notification at all: unsupported', () => {
    vi.stubGlobal('Notification', undefined);
    // `'Notification' in window` is still true with the value undefined; delete it for the real case.
    const saved = Object.getOwnPropertyDescriptor(window, 'Notification');
    delete (window as { Notification?: unknown }).Notification;
    try {
      expect(desktopPermission()).toBe('unsupported');
    } finally {
      if (saved) Object.defineProperty(window, 'Notification', saved);
    }
  });

  it.each(['granted', 'denied', 'default'] as const)('reads %s', (permission) => {
    vi.stubGlobal('Notification', { permission, requestPermission: vi.fn() });
    expect(desktopPermission()).toBe(permission);
  });

  it('★ asking answers what the browser decided (promise form)', async () => {
    const stub = {
      permission: 'default' as NotificationPermission,
      requestPermission: vi.fn(async () => {
        stub.permission = 'granted';
        return 'granted' as const;
      }),
    };
    vi.stubGlobal('Notification', stub);
    await expect(requestDesktopPermission()).resolves.toBe('granted');
    expect(stub.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('asking, in the callback form older Safari uses', async () => {
    const stub = {
      permission: 'default' as NotificationPermission,
      requestPermission: vi.fn((callback: (p: NotificationPermission) => void) => {
        stub.permission = 'denied';
        callback('denied');
        return undefined;
      }),
    };
    vi.stubGlobal('Notification', stub);
    await expect(requestDesktopPermission()).resolves.toBe('denied');
  });
});
