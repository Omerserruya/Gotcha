import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeBridge } from './NativeBridge';

/* Nothing here reaches a route: the router and the API are doubles. */
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/api/client/browser-api', () => ({ browserApi: { get: vi.fn() } }));
vi.mock('./push-actions', () => ({ registerPushDevice: vi.fn() }));

type W = { Capacitor?: unknown };

/*
 * The shape each platform's bridge really has: on iOS a plugin's addListener
 * answers the listener itself (Capacitor's JSExport), on Android a promise.
 */
function bridge(platform: 'ios' | 'android') {
  const listener = { remove: vi.fn() };
  const addListener = vi.fn(() => (platform === 'ios' ? listener : Promise.resolve(listener)));
  (window as unknown as W).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: {
      App: { addListener, exitApp: vi.fn() },
      Browser: { open: vi.fn() },
      PushNotifications: {
        addListener,
        checkPermissions: vi.fn(async () => ({ receive: 'denied' })),
        requestPermissions: vi.fn(async () => ({ receive: 'denied' })),
        register: vi.fn(),
      },
    },
  };
  return addListener;
}

afterEach(() => {
  delete (window as unknown as W).Capacitor;
});

describe('NativeBridge', () => {
  it('★ on iOS, a listener that is not a promise does not break the screen (Omer, 2026-11-05)', async () => {
    const addListener = bridge('ios');
    expect(() => render(<NativeBridge />)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(addListener.mock.calls.map((c) => (c as unknown[])[0])).not.toContain('backButton');
  });

  it("on Android, Back is listened to (the photo viewer's close)", async () => {
    const addListener = bridge('android');
    render(<NativeBridge />);
    await new Promise((r) => setTimeout(r, 0));
    expect(addListener.mock.calls.map((c) => (c as unknown[])[0])).toContain('backButton');
  });
});
