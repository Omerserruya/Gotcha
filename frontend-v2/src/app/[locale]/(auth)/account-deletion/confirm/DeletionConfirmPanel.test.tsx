import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import auth from '@/i18n/messages/en/auth.json';
import authHe from '@/i18n/messages/he/auth.json';

/** Mocked: nothing is confirmed. */
const { action } = vi.hoisted(() => ({
  action: { requestAccountDeletion: vi.fn(), confirmAccountDeletion: vi.fn() },
}));
vi.mock('@/features/account-deletion/actions', () => action);

const { DeletionConfirmPanel } = await import('./DeletionConfirmPanel');

const show = (token: string | null = 'tok-1', locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ auth: locale === 'he' ? authHe : auth }}
    >
      <DeletionConfirmPanel
        token={token}
        requestHref="/en/account-deletion"
        signInHref="/en/sign-in"
      />
    </NextIntlClientProvider>,
  );
const press = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('deletion-confirm-press'));
  });
};

beforeEach(() => {
  action.confirmAccountDeletion.mockReset();
});

describe('★★ /account-deletion/confirm: the email link', () => {
  it('★★★ opening the link spends NOTHING: no call until the press (mail scanners open links)', async () => {
    show();
    await act(async () => {});
    expect(action.confirmAccountDeletion).not.toHaveBeenCalled();
    expect(screen.getByTestId('deletion-confirm')).toHaveTextContent(
      'Nothing happens until you press it',
    );
    expect(screen.getByTestId('deletion-keep')).toHaveAttribute('href', '/en/sign-in');
  });

  it('★★ the press sends the token once; the deadline is said as "by <date>"', async () => {
    action.confirmAccountDeletion.mockResolvedValue({
      ok: true,
      confirmed: {
        status: 'scheduled',
        deleteBy: '2026-12-14T10:00:00Z',
        email: 'd***@aviv.co.il',
      },
    });
    show();
    await press();
    expect(action.confirmAccountDeletion).toHaveBeenCalledTimes(1);
    expect(action.confirmAccountDeletion).toHaveBeenCalledWith('tok-1');
    expect(screen.getByTestId('deletion-confirmed-by')).toHaveTextContent(
      'Your account will be deleted by December 14, 2026.',
    );
    expect(screen.getByTestId('deletion-confirmed')).toHaveTextContent('d***@aviv.co.il');
    expect(screen.queryByTestId('deletion-confirm-press')).toBeNull();
  });

  it('no deadline said: "soon", never an invented date', async () => {
    action.confirmAccountDeletion.mockResolvedValue({
      ok: true,
      confirmed: { status: 'scheduled', deleteBy: null, email: null },
    });
    show();
    await press();
    expect(screen.getByTestId('deletion-confirmed-by')).toHaveTextContent('will be deleted soon');
  });

  it.each([
    ['TOKEN_EXPIRED', 'This link has expired', true],
    ['BAD_TOKEN', 'This link doesn’t work', true],
    ['ALREADY_CONFIRMED', 'Already confirmed', false],
  ])('★ %s: said, and a new link offered only where one helps', async (reason, words, again) => {
    action.confirmAccountDeletion.mockResolvedValue({ ok: false, reason });
    show();
    await press();
    expect(screen.getByTestId(`deletion-${reason}`)).toHaveTextContent(words);
    expect(screen.queryByTestId('deletion-ask-again') !== null).toBe(again);
  });

  it('★ expired says the link’s hours from the constant', async () => {
    action.confirmAccountDeletion.mockResolvedValue({ ok: false, reason: 'TOKEN_EXPIRED' });
    show();
    await press();
    expect(screen.getByTestId('deletion-TOKEN_EXPIRED')).toHaveTextContent('24 hours');
  });

  it('★ it did not go through: said, and the press stays to try again', async () => {
    action.confirmAccountDeletion.mockResolvedValue({ ok: false, reason: 'failed' });
    show();
    await press();
    expect(screen.getByTestId('deletion-confirm-failed')).toBeInTheDocument();
    expect(screen.getByTestId('deletion-confirm-press')).toBeEnabled();
  });

  it('★ no token on the link: "doesn’t work", no button to press', () => {
    show(null);
    expect(screen.getByTestId('deletion-BAD_TOKEN')).toBeInTheDocument();
    expect(screen.queryByTestId('deletion-confirm-press')).toBeNull();
  });

  it('★ Hebrew: every word in the catalogue, no raw key', async () => {
    action.confirmAccountDeletion.mockResolvedValue({
      ok: true,
      confirmed: { status: 'scheduled', deleteBy: '2026-12-14T10:00:00Z', email: null },
    });
    show('tok-1', 'he');
    expect(document.body.textContent).not.toMatch(/accountDeletion\.|auth\./);
    await press();
    expect(document.body.textContent).not.toMatch(/accountDeletion\.|auth\./);
    expect(screen.getByTestId('deletion-confirmed-by')).toHaveTextContent('החשבון יימחק עד');
  });
});
