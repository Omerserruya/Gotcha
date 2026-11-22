import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import auth from '@/i18n/messages/he/auth.json';

const acceptTerms = vi.hoisted(() => vi.fn());
vi.mock('./terms-actions', () => ({ acceptTerms }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const signOut = vi.hoisted(() => vi.fn());
vi.mock('@/auth/sign-out', () => ({ signOut }));

const { TermsGate } = await import('./TermsGate');

const show = () =>
  render(
    <NextIntlClientProvider locale="he" messages={{ auth }}>
      <TermsGate />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  acceptTerms.mockReset().mockResolvedValue('accepted');
  refresh.mockReset();
  signOut.mockReset();
});

describe('★★ the Terms before first entry', () => {
  it('★★ the approved lines, and the setup link’s own box and links', () => {
    show();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('לפני שמתחילים');
    expect(screen.getByText(auth.terms.lede)).toBeInTheDocument();
    expect(screen.getByTestId('terms-terms-box')).not.toBeChecked();
    expect(screen.getByTestId('terms-terms-link')).toHaveAttribute('target', '_blank');
    expect(screen.getByTestId('terms-privacy-link')).toBeInTheDocument();
    expect(screen.getByTestId('terms-sign-out')).toHaveTextContent('התנתקות');
  });

  it('⚠⚠ "המשך" waits for the tick', async () => {
    show();
    expect(screen.getByTestId('terms-continue')).toBeDisabled();
    await userEvent.click(screen.getByTestId('terms-terms-box'));
    expect(screen.getByTestId('terms-continue')).toBeEnabled();
  });

  it('★★ sends the words as the person saw them, then lets the layout read again', async () => {
    show();
    await userEvent.click(screen.getByTestId('terms-terms-box'));
    await userEvent.click(screen.getByTestId('terms-continue'));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const words = acceptTerms.mock.calls[0]?.[0] as string;
    expect(words).toBe(screen.getByTestId('terms-terms').textContent?.trim());
    expect(words).toContain('תנאי השירות');
  });

  it('⚠⚠ not recorded: the screen stays, says so, and can be pressed again', async () => {
    acceptTerms.mockResolvedValue('failed');
    show();
    await userEvent.click(screen.getByTestId('terms-terms-box'));
    await userEvent.click(screen.getByTestId('terms-continue'));
    expect(await screen.findByTestId('terms-failed')).toHaveTextContent(auth.terms.failed);
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('terms-continue')).toBeEnabled();
  });

  it('★ "not now" signs out', async () => {
    show();
    await userEvent.click(screen.getByTestId('terms-sign-out'));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
