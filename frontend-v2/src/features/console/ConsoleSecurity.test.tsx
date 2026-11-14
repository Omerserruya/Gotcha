import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountSecurity } from '@/api/contracts/mfa';
import console_ from '@/i18n/messages/en/console.json';
import heConsole from '@/i18n/messages/he/console.json';

/**
 * ★★ Console · Security: the admin's own two-step sign-in, the legacy
 * account page's Security section. ⚠ The remove is mocked: nothing here
 * removes a factor.
 */
const removeMyFactor = vi.hoisted(() => vi.fn());
vi.mock('./security-actions', () => ({ removeMyFactor }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { ConsoleSecurity } from './ConsoleSecurity';

const ORIGIN = 'https://auth.example.test';
const app = (id: string, name: string | null = 'Pixel') => ({
  id,
  name,
  createdAt: '2026-11-01T10:00:00.000Z',
});
const security = (over: Partial<AccountSecurity> = {}): AccountSecurity => ({
  available: true,
  totp: [app('7')],
  passkeys: [],
  recoveryCodes: [{ id: '3', name: null, createdAt: null }],
  ...over,
});
const show = (value: AccountSecurity | null, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      timeZone="Asia/Jerusalem"
      messages={{ console: locale === 'en' ? console_ : heConsole }}
    >
      <ConsoleSecurity security={value} authOrigin={ORIGIN} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  removeMyFactor.mockReset();
  refresh.mockReset();
});

describe('★★ what is set up, said - and unknown is never "off"', () => {
  it('both factors: on; the app named, with replace said; codes made', () => {
    show(security());
    expect(screen.getByTestId('security-status')).toHaveTextContent('Two-step sign-in is on');
    expect(screen.getByTestId('factor-7')).toHaveTextContent('Pixel');
    expect(screen.getByTestId('security-authenticator')).toHaveTextContent(
      'To replace an app, add the new one, then remove the old one.',
    );
    expect(screen.getByTestId('security-add-authenticator')).toHaveTextContent('Add an app');
    expect(screen.getByTestId('security-recovery-codes')).toHaveTextContent('Make new codes');
  });

  it('nothing set up: not complete; "Set up", "Make codes"', () => {
    show(security({ totp: [], recoveryCodes: [] }));
    expect(screen.getByTestId('security-status')).toHaveTextContent("isn't complete");
    expect(screen.getByTestId('security-add-authenticator')).toHaveTextContent(
      'Set up an authenticator app',
    );
    expect(screen.getByTestId('security-recovery-codes')).toHaveTextContent('Make codes');
  });

  it('an app but no codes: still not complete (the gate needs both)', () => {
    show(security({ recoveryCodes: [] }));
    expect(screen.getByTestId('security-status')).toHaveTextContent("isn't complete");
  });

  it.each([
    [null, "We couldn't read"],
    [{ available: false, totp: [], passkeys: [], recoveryCodes: [] }, "didn't answer"],
  ] as const)('unread or unknown (%#): said, and no row claims anything', (value, words) => {
    show(value as AccountSecurity | null);
    expect(screen.getByTestId('security-unread')).toHaveTextContent(words);
    expect(screen.queryByTestId('security-status')).toBeNull();
  });

  it('in Hebrew', () => {
    show(security(), 'he');
    expect(screen.getByTestId('security-status')).toHaveTextContent('כניסה דו־שלבית פעילה');
  });
});

describe('★★ changes are Authentik’s own flows, framed', () => {
  it('set up an app: the authenticator flow, NOT chained into new codes', () => {
    show(security());
    fireEvent.click(screen.getByTestId('security-add-authenticator'));
    const src = new URL((screen.getByTitle('Authenticator app') as HTMLIFrameElement).src);
    expect(src.origin).toBe(ORIGIN);
    expect(src.pathname).toBe('/if/flow/default-authenticator-totp-setup/');
    expect(src.searchParams.has('next')).toBe(false);
  });

  it('new codes: the recovery-codes flow; closing reads the factors again', () => {
    show(security());
    fireEvent.click(screen.getByTestId('security-recovery-codes'));
    const src = new URL((screen.getByTitle('Recovery codes') as HTMLIFrameElement).src);
    expect(src.pathname).toBe('/if/flow/default-authenticator-static-setup/');
    fireEvent.click(screen.getByTestId('security-flow-close'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('★★ remove: asked first, and the last app says what follows', () => {
  it('two apps: the plain question; yes removes that one', async () => {
    removeMyFactor.mockResolvedValue({ ok: true });
    show(security({ totp: [app('7'), app('8', 'Work phone')] }));
    fireEvent.click(screen.getByTestId('factor-8-remove'));
    expect(screen.getByTestId('factor-8')).toHaveTextContent('Remove this app?');
    await act(async () => {
      fireEvent.click(screen.getByTestId('factor-8-yes'));
    });
    expect(removeMyFactor).toHaveBeenCalledWith('totp', '8');
  });

  it('★ the only app: says the gate will ask again', () => {
    show(security());
    fireEvent.click(screen.getByTestId('factor-7-remove'));
    expect(screen.getByTestId('factor-7')).toHaveTextContent(
      "you'll be asked to set one up again before you can continue",
    );
    expect(removeMyFactor).not.toHaveBeenCalled();
  });

  it('refused: said', async () => {
    removeMyFactor.mockResolvedValue({ ok: false, reason: 'failed' });
    show(security());
    fireEvent.click(screen.getByTestId('factor-7-remove'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('factor-7-yes'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent("That didn't remove. Try again.");
  });
});
