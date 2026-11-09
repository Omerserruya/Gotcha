import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ★ The gate while the product is open: owed mid-session, refresh (the layout
 * then draws the gate); at most one check a minute (each reads Authentik).
 */
const checkMfaGate = vi.hoisted(() => vi.fn());
vi.mock('./mfa-actions', () => ({ checkMfaGate }));
const refresh = vi.hoisted(() => vi.fn());
const at = vi.hoisted(() => ({ path: '/en/home' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => at.path,
}));

import { MFA_WATCH_EVERY_MS, MfaWatch } from './MfaWatch';

const owed = (mustEnroll: boolean) => ({ mustEnroll });
const flush = () => act(async () => await Promise.resolve());

beforeEach(() => {
  vi.useFakeTimers();
  checkMfaGate.mockReset();
  refresh.mockReset();
  at.path = '/en/home';
});
afterEach(() => vi.useRealTimers());

describe('★ MfaWatch', () => {
  it('not owed: nothing; owed: one refresh', async () => {
    checkMfaGate.mockResolvedValue(owed(false));
    const view = render(<MfaWatch />);
    await flush();
    expect(refresh).not.toHaveBeenCalled();
    checkMfaGate.mockResolvedValue(owed(true));
    vi.advanceTimersByTime(MFA_WATCH_EVERY_MS);
    at.path = '/en/inbox';
    view.rerender(<MfaWatch />);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('★ at most one check a minute, however many pages and focuses', async () => {
    checkMfaGate.mockResolvedValue(owed(false));
    const view = render(<MfaWatch />);
    await flush();
    for (const path of ['/en/inbox', '/en/customers', '/en/approvals']) {
      at.path = path;
      view.rerender(<MfaWatch />);
      window.dispatchEvent(new Event('focus'));
    }
    await flush();
    expect(checkMfaGate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MFA_WATCH_EVERY_MS);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(checkMfaGate).toHaveBeenCalledTimes(2);
  });

  it('unread: nothing', async () => {
    checkMfaGate.mockResolvedValue(null);
    render(<MfaWatch />);
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });
});
