import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '@/i18n/messages/en/notifications-settings.json';
import he from '@/i18n/messages/he/notifications-settings.json';
import { DEVICE_ALERTS_KEY } from '@/lib/inbound-alerts/settings';

/* The chime is Web Audio: a spy, never a sound. */
const playFromGesture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/inbound-alerts/chime', () => ({ sharedChime: () => ({ playFromGesture }) }));

import { DeviceAlerts } from './DeviceAlerts';

const show = (messages: typeof en = en, locale = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={{ 'notifications-settings': messages }}>
      <DeviceAlerts />
    </NextIntlClientProvider>,
  );

/** A Notification with a permission and a scripted answer - never a real prompt. */
function stubNotification(permission: NotificationPermission, answer?: NotificationPermission) {
  const stub = {
    permission,
    requestPermission: vi.fn(async () => {
      if (answer) stub.permission = answer;
      return stub.permission;
    }),
  };
  vi.stubGlobal('Notification', stub);
  return stub;
}

const sound = () => screen.getByTestId('pref-device-sound');
const desktop = () => screen.getByTestId('pref-device-desktop');

beforeEach(() => {
  window.localStorage.clear();
  playFromGesture.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('★ this device’s alerts for an incoming message', () => {
  it('★ the defaults: sound on, desktop off', () => {
    stubNotification('default');
    show();
    expect(sound()).toHaveAttribute('aria-checked', 'true');
    expect(desktop()).toHaveAttribute('aria-checked', 'false');
    expect(desktop()).toBeEnabled();
    expect(screen.getByText('Sound for incoming messages')).toBeInTheDocument();
    expect(screen.getByText('Desktop notifications')).toBeInTheDocument();
  });

  it('the sound switched off is kept on this device, and on again chimes once', () => {
    stubNotification('default');
    show();
    fireEvent.click(sound());
    expect(sound()).toHaveAttribute('aria-checked', 'false');
    expect(JSON.parse(window.localStorage.getItem(DEVICE_ALERTS_KEY)!)).toMatchObject({
      sound: false,
    });
    expect(playFromGesture).not.toHaveBeenCalled();
    fireEvent.click(sound());
    expect(sound()).toHaveAttribute('aria-checked', 'true');
    expect(playFromGesture).toHaveBeenCalledTimes(1);
  });

  it('★ turning desktop on asks the browser, from the click; granted, it is on', async () => {
    const stub = stubNotification('default', 'granted');
    show();
    await act(async () => {
      fireEvent.click(desktop());
    });
    expect(stub.requestPermission).toHaveBeenCalledTimes(1);
    expect(desktop()).toHaveAttribute('aria-checked', 'true');
    expect(JSON.parse(window.localStorage.getItem(DEVICE_ALERTS_KEY)!)).toMatchObject({
      desktop: true,
    });
  });

  it('★ the browser says no: off, and blocked - in words that say where to fix it', async () => {
    stubNotification('default', 'denied');
    show();
    await act(async () => {
      fireEvent.click(desktop());
    });
    expect(desktop()).toHaveAttribute('aria-checked', 'false');
    expect(desktop()).toBeDisabled();
    expect(screen.getByTestId('pref-device-desktop-state')).toHaveTextContent(
      'Blocked in this browser - allow it in the site settings',
    );
  });

  it('★ already blocked: the switch is off and says so, in Hebrew too', () => {
    stubNotification('denied');
    window.localStorage.setItem(DEVICE_ALERTS_KEY, '{"sound":true,"desktop":true}');
    show(he, 'he');
    // Set on, but the browser blocks it: never drawn on.
    expect(desktop()).toHaveAttribute('aria-checked', 'false');
    expect(desktop()).toBeDisabled();
    expect(screen.getByTestId('pref-device-desktop-state')).toHaveTextContent(
      'חסום בדפדפן - אפשר לאפשר בהגדרות האתר',
    );
  });

  it('the prompt dismissed without an answer: still off, and says how to be asked again', async () => {
    stubNotification('default', 'default');
    show();
    await act(async () => {
      fireEvent.click(desktop());
    });
    expect(desktop()).toHaveAttribute('aria-checked', 'false');
    expect(desktop()).toBeEnabled();
    expect(screen.getByTestId('pref-device-desktop-state')).toHaveTextContent(/Still off/);
  });

  it('already granted: on and off without asking again', () => {
    const stub = stubNotification('granted');
    show();
    fireEvent.click(desktop());
    expect(desktop()).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(desktop());
    expect(desktop()).toHaveAttribute('aria-checked', 'false');
    expect(stub.requestPermission).not.toHaveBeenCalled();
  });

  it('★ a browser with no Notification at all: the switch is off, disabled, and says why', () => {
    const saved = Object.getOwnPropertyDescriptor(window, 'Notification');
    delete (window as { Notification?: unknown }).Notification;
    try {
      show();
      expect(desktop()).toHaveAttribute('aria-checked', 'false');
      expect(desktop()).toBeDisabled();
      expect(screen.getByTestId('pref-device-desktop-state')).toHaveTextContent(
        'This browser has no desktop notifications.',
      );
      // The sound does not depend on it.
      expect(sound()).toBeEnabled();
    } finally {
      if (saved) Object.defineProperty(window, 'Notification', saved);
    }
  });

  it('★ storage that throws: the screen still renders, works for this page, and says so', () => {
    stubNotification('default');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    show();
    expect(sound()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('pref-device-kept')).toHaveTextContent(/isn't keeping settings/);
    fireEvent.click(sound());
    expect(sound()).toHaveAttribute('aria-checked', 'false');
  });

  it('kept: says it is this browser’s alone', () => {
    stubNotification('default');
    show();
    expect(screen.getByTestId('pref-device-kept')).toHaveTextContent('Kept in this browser only.');
  });
});
