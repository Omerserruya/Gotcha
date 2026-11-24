import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redeemAppSignIn = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/app-sign-in', () => ({ redeemAppSignIn }));

const { appGoogleAvailable, codeFrom, makeVerifier, signInWithGoogleInApp } =
  await import('./app-google');

type W = { Capacitor?: unknown };
const native = (
  platform: 'ios' | 'android',
  plugins: Record<string, unknown>,
  methods: string[],
) => {
  (window as unknown as W).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    PluginHeaders: [{ name: 'NavigationPolicy', methods: methods.map((name) => ({ name })) }],
    Plugins: plugins,
  };
};

beforeEach(() => {
  redeemAppSignIn.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  delete (window as unknown as W).Capacitor;
});

describe('★★ where Google can run inside the app (2026-11-24)', () => {
  it('★★ an iPhone build that registered authenticate: yes', () => {
    native('ios', { NavigationPolicy: { authenticate: vi.fn() } }, [
      'openDocument',
      'authenticate',
    ]);
    expect(appGoogleAvailable()).toBe(true);
  });

  it('⚠⚠ an older iPhone build (the proxy answers any name, the headers do not): no', () => {
    native('ios', { NavigationPolicy: { authenticate: vi.fn() } }, ['openDocument']);
    expect(appGoogleAvailable()).toBe(false);
  });

  it('★ Android with Browser and App (every build so far): yes', () => {
    native(
      'android',
      { Browser: { open: vi.fn(), addListener: vi.fn() }, App: { addListener: vi.fn() } },
      [],
    );
    expect(appGoogleAvailable()).toBe(true);
  });

  it('⚠ a browser: no', () => {
    expect(appGoogleAvailable()).toBe(false);
  });
});

describe('★ the verifier and the return', () => {
  it('★ a 43-character verifier and its S256', async () => {
    const { verifier, challenge } = await makeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each([
    ['gotcha://auth/done?code=abc', 'abc'],
    ['gotcha://m/inbox/1', null],
    ['https://app.gotcha.co.il/auth/done?code=abc', null],
  ])('%s -> %s', (url, code) => {
    expect(codeFrom(url)).toBe(code);
  });
});

describe('★★ the iPhone trip', () => {
  it('★★ out to the start with the challenge, back with a code, the code redeemed', async () => {
    const authenticate = vi.fn(async () => ({ url: 'gotcha://auth/done?code=C' }));
    native('ios', { NavigationPolicy: { authenticate } }, ['authenticate']);
    expect(await signInWithGoogleInApp('he')).toBe('signed_in');
    const [{ url, callbackScheme }] = authenticate.mock.calls[0] as unknown as [
      { url: string; callbackScheme: string },
    ];
    const start = new URL(url);
    expect(start.pathname).toBe('/api/bff/app-sign-in/start');
    expect(start.searchParams.get('locale')).toBe('he');
    expect(callbackScheme).toBe('gotcha');
    const [code, verifier] = redeemAppSignIn.mock.calls[0] as [string, string];
    expect(code).toBe('C');
    // Only the challenge left the app: the verifier is not in the start URL.
    expect(url).not.toContain(verifier);
  });

  it('★ closed by the person: cancelled, nothing redeemed', async () => {
    native(
      'ios',
      {
        NavigationPolicy: {
          authenticate: vi.fn(async () => Promise.reject(new Error('cancelled'))),
        },
      },
      ['authenticate'],
    );
    expect(await signInWithGoogleInApp('he')).toBe('cancelled');
    expect(redeemAppSignIn).not.toHaveBeenCalled();
  });

  it('⚠⚠ a refused redeem: failed', async () => {
    redeemAppSignIn.mockResolvedValue(false);
    native(
      'ios',
      {
        NavigationPolicy: {
          authenticate: vi.fn(async () => ({ url: 'gotcha://auth/done?code=C' })),
        },
      },
      ['authenticate'],
    );
    expect(await signInWithGoogleInApp('he')).toBe('failed');
  });
});

describe('★★ the Android trip', () => {
  const android = () => {
    const handlers: Record<string, (event?: { url: string }) => void> = {};
    const listener = { remove: vi.fn() };
    const browser = {
      open: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      addListener: vi.fn(async (event: string, fn: () => void) => {
        handlers[event] = fn;
        return listener;
      }),
    };
    const app = {
      addListener: vi.fn(async (event: string, fn: (e: { url: string }) => void) => {
        handlers[event] = fn as never;
        return listener;
      }),
    };
    native('android', { Browser: browser, App: app }, []);
    return { handlers, browser, listener };
  };

  it('★★ a Custom Tab out, gotcha:// back through appUrlOpen, redeemed', async () => {
    const { handlers, browser, listener } = android();
    const trip = signInWithGoogleInApp('he');
    await vi.waitFor(() => expect(browser.open).toHaveBeenCalled());
    handlers.appUrlOpen?.({ url: 'gotcha://m/inbox/1' }); // a deep link, not ours
    handlers.appUrlOpen?.({ url: 'gotcha://auth/done?code=C' });
    expect(await trip).toBe('signed_in');
    expect(redeemAppSignIn.mock.calls[0]?.[0]).toBe('C');
    expect(listener.remove).toHaveBeenCalled();
  });

  it('★ the tab closed with no return: cancelled, after a moment for a late one', async () => {
    vi.useFakeTimers();
    try {
      const { handlers, browser } = android();
      const trip = signInWithGoogleInApp('he');
      await vi.waitFor(() => expect(browser.open).toHaveBeenCalled());
      handlers.browserFinished?.();
      await vi.advanceTimersByTimeAsync(2000);
      expect(await trip).toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('★ the tab closes just before the return arrives: still signed in', async () => {
    vi.useFakeTimers();
    try {
      const { handlers, browser } = android();
      const trip = signInWithGoogleInApp('he');
      await vi.waitFor(() => expect(browser.open).toHaveBeenCalled());
      handlers.browserFinished?.();
      await vi.advanceTimersByTimeAsync(300);
      handlers.appUrlOpen?.({ url: 'gotcha://auth/done?code=C' });
      expect(await trip).toBe('signed_in');
    } finally {
      vi.useRealTimers();
    }
  });
});
