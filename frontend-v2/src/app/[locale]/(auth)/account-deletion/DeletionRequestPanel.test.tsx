import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import auth from '@/i18n/messages/en/auth.json';
import authHe from '@/i18n/messages/he/auth.json';

/** Mocked: nothing is sent. */
const { action } = vi.hoisted(() => ({
  action: { requestAccountDeletion: vi.fn(), confirmAccountDeletion: vi.fn() },
}));
vi.mock('@/features/account-deletion/actions', () => action);

const { DeletionRequestPanel } = await import('./DeletionRequestPanel');

const show = (locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={{ auth: locale === 'he' ? authHe : auth }}>
      <DeletionRequestPanel locale={locale} signInHref="/en/sign-in" />
    </NextIntlClientProvider>,
  );
const fill = (email: string, workspace = '') => {
  fireEvent.change(screen.getByTestId('deletion-email'), { target: { value: email } });
  fireEvent.change(screen.getByTestId('deletion-workspace'), { target: { value: workspace } });
};
const submit = async () => {
  await act(async () => {
    fireEvent.submit(screen.getByTestId('deletion-form'));
  });
};

beforeEach(() => {
  action.requestAccountDeletion.mockReset();
});

describe('★★ /account-deletion: ask, signed out', () => {
  it('★ the form says what happens, and what is deleted, kept and when (Play requires it)', () => {
    show();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Delete your GOTCHA account',
    );
    expect(screen.getByTestId('deletion-form')).toHaveTextContent(
      'nothing is deleted until you press it',
    );
    expect(screen.getByTestId('deletion-policy').querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByTestId('deletion-submit')).toBeDisabled();
  });

  it('★★ sends what was typed, with the page language', async () => {
    action.requestAccountDeletion.mockResolvedValue({ ok: true });
    show();
    fill('dana@aviv.co.il', 'Aviv');
    await submit();
    expect(action.requestAccountDeletion).toHaveBeenCalledWith({
      email: 'dana@aviv.co.il',
      workspace: 'Aviv',
      locale: 'en',
    });
  });

  it('★★ sent: the SAME words whether or not an account exists, with the link’s hours', async () => {
    action.requestAccountDeletion.mockResolvedValue({ ok: true });
    show();
    fill('nobody@nowhere.co');
    await submit();
    const sent = screen.getByTestId('deletion-sent');
    expect(sent).toHaveTextContent('If an account uses this address');
    expect(sent).toHaveTextContent('for 24 hours');
    expect(screen.queryByTestId('deletion-form')).toBeNull();
  });

  it.each([
    ['BAD_EMAIL', 'doesn’t look like an email address'],
    ['RATE_LIMITED', 'Too many requests'],
    ['failed', 'didn’t go through'],
  ])('★ refused %s: said in words, the form stays', async (reason, words) => {
    action.requestAccountDeletion.mockResolvedValue({ ok: false, reason });
    show();
    fill('dana@aviv.co.il');
    await submit();
    expect(screen.getByTestId('deletion-refused')).toHaveTextContent(words);
    expect(screen.getByTestId('deletion-email')).toHaveValue('dana@aviv.co.il');
  });

  it('★ Hebrew: every word in the catalogue, no raw key', async () => {
    action.requestAccountDeletion.mockResolvedValue({ ok: false, reason: 'RATE_LIMITED' });
    show('he');
    fill('dana@aviv.co.il');
    await submit();
    expect(document.body.textContent).not.toMatch(/accountDeletion\.|auth\./);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('מחיקת חשבון GOTCHA');
  });
});
