import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/billing.json';

/* Confirming asks the provider: a spy, always. */
const confirmCardSession = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ confirmCardSession }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href: _href, ...rest }: { children: ReactNode; href: unknown }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { CARD_SESSION_KEY } from './card-session';
import { CardReturn } from './CardReturn';

beforeEach(() => {
  confirmCardSession.mockReset();
  sessionStorage.clear();
});
const show = async (cancelled = false) => {
  render(
    <NextIntlClientProvider locale="en" messages={{ billing: messages }}>
      <CardReturn cancelled={cancelled} />
    </NextIntlClientProvider>,
  );
  await act(async () => {});
};
const said = () => screen.getByTestId('card-return-said');

describe('★★ back from the secure page - asked once, said in words', () => {
  it('stored: the card named; the session forgotten', async () => {
    sessionStorage.setItem(CARD_SESSION_KEY, 's1');
    confirmCardSession.mockResolvedValue({
      ok: true,
      status: 'STORED',
      card: { brand: 'Visa', last4: '4417' },
    });
    await show();
    expect(confirmCardSession).toHaveBeenCalledWith('s1');
    expect(said()).toHaveTextContent("Saved: Visa ending 4417. It's the card charged from now on.");
    expect(sessionStorage.getItem(CARD_SESSION_KEY)).toBeNull();
  });

  it('not yet: said, the session kept, and Check again asks again', async () => {
    sessionStorage.setItem(CARD_SESSION_KEY, 's1');
    confirmCardSession.mockResolvedValue({
      ok: true,
      status: 'PENDING',
      reason: 'no_new_card_yet',
    });
    await show();
    expect(said()).toHaveTextContent("The provider hasn't reported a new card yet.");
    expect(sessionStorage.getItem(CARD_SESSION_KEY)).toBe('s1');
    await userEvent.click(screen.getByTestId('card-check-again'));
    expect(confirmCardSession).toHaveBeenCalledTimes(2);
  });

  it('cancelled: nothing changed, the provider not asked, the session forgotten', async () => {
    sessionStorage.setItem(CARD_SESSION_KEY, 's1');
    await show(true);
    expect(said()).toHaveTextContent('You left the secure page without saving a card.');
    expect(confirmCardSession).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CARD_SESSION_KEY)).toBeNull();
  });

  it('no session in this browser: nothing to check - the provider not asked', async () => {
    await show();
    expect(said()).toHaveTextContent("There's no card being added from this browser to check.");
    expect(confirmCardSession).not.toHaveBeenCalled();
  });

  it('held (writes off): said in words', async () => {
    sessionStorage.setItem(CARD_SESSION_KEY, 's1');
    confirmCardSession.mockResolvedValue({ ok: false, reason: 'held' });
    await show();
    expect(said()).toHaveTextContent('uses the live payment account');
  });
});
