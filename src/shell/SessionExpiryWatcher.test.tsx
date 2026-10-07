import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ★★ A session that ended is sign-in, "Your session ended" - never a screen
 * of "couldn't read" (supervisor, 2026-10-07). One client handler for both
 * ways it is found: a browser read the BFF refused, and a streamed section
 * the server found signed out.
 */
vi.mock('server-only', () => ({}));

const { SESSION_EXPIRED_EVENT } = await import('@/api/client/browser-api');
const { SessionEnded } = await import('@/api/client/SessionEnded');
const { SessionExpiryWatcher } = await import('./SessionExpiryWatcher');

const assign = vi.fn();
beforeEach(() => {
  assign.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign, pathname: '/he/studio/automations', search: '?new=1' },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('★★ the one client handler', () => {
  it('a streamed section found signed out: the marker tells the handler', () => {
    const heard = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, heard);
    render(<SessionEnded />);
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener(SESSION_EXPIRED_EVENT, heard);
  });

  it('our sign-in screen, "ended", in the page\'s language, and back here after', () => {
    render(<SessionExpiryWatcher />);
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    });
    expect(assign).toHaveBeenCalledTimes(1);
    const to = new URL(assign.mock.calls[0]![0] as string, 'https://dev.gotcha.co.il');
    expect(to.pathname).toMatch(/\/he\/sign-in$/);
    expect(to.searchParams.get('error')).toBe('ended');
    expect(to.searchParams.get('returnTo')).toBe('/he/studio/automations?new=1');
    expect(to.pathname).not.toContain('/api/auth/login');
  });

  it('ten at once are one navigation', () => {
    render(<SessionExpiryWatcher />);
    act(() => {
      for (let i = 0; i < 10; i += 1) window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    });
    expect(assign).toHaveBeenCalledTimes(1);
  });
});
