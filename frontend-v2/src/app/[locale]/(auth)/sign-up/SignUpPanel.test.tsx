import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import auth from '@/i18n/messages/he/auth.json';

const submitSignUp = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/self-signup', () => ({ submitSignUp }));

const { SignUpPanel } = await import('./SignUpPanel');

const OPEN = { enabled: true, trialDays: 14, cardRequiredAfterDays: 14 };
const show = (config = OPEN) =>
  render(
    <NextIntlClientProvider locale="he" messages={{ auth }}>
      <SignUpPanel config={config} signInHref="/he/sign-in" />
    </NextIntlClientProvider>,
  );

const fill = async () => {
  await userEvent.type(screen.getByTestId('signup-name'), 'מאיה כהן');
  await userEvent.type(screen.getByTestId('signup-email'), 'maya@aviv.co');
  await userEvent.type(screen.getByTestId('signup-businessName'), 'אביב');
};

beforeEach(() => {
  submitSignUp.mockReset().mockResolvedValue({ kind: 'sent' });
});

describe('★★ /sign-up', () => {
  it('★ the approved lines, the trial in numbers from the server, and the way back', () => {
    show();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('פתיחת חשבון');
    expect(screen.getByText(auth.signUp.lede)).toBeInTheDocument();
    expect(screen.getByText(/תקופת ניסיון של 14 ימים/)).toBeInTheDocument();
    expect(screen.getByTestId('signup-sign-in')).toHaveAttribute('href', '/he/sign-in');
  });

  it('★ no numbers from the server: no trial line', () => {
    show({ enabled: true, trialDays: null, cardRequiredAfterDays: null } as never);
    expect(screen.queryByText(/תקופת ניסיון/)).toBeNull();
  });

  it('⚠⚠ submit waits for every field AND the Terms box', async () => {
    show();
    await fill();
    expect(screen.getByTestId('signup-submit')).toBeDisabled();
    await userEvent.click(screen.getByTestId('signup-terms-box'));
    expect(screen.getByTestId('signup-submit')).toBeEnabled();
  });

  it('★★ sends the form with the words of the box, then the same "check your email" for anyone', async () => {
    show();
    await fill();
    await userEvent.click(screen.getByTestId('signup-terms-box'));
    await userEvent.click(screen.getByTestId('signup-submit'));
    const sent = await screen.findByTestId('signup-sent');
    expect(sent).toHaveTextContent('בדקו את תיבת המייל');
    expect(sent).toHaveTextContent('maya@aviv.co');
    expect(sent.querySelector('bdi')).toHaveAttribute('dir', 'ltr');
    expect(submitSignUp).toHaveBeenCalledWith(
      { name: 'מאיה כהן', email: 'maya@aviv.co', businessName: 'אביב' },
      'he',
      expect.stringContaining('תנאי השירות'),
      // The honeypot, empty for a person.
      '',
    );
  });

  it.each([
    [{ kind: 'rateLimited' }, auth.signUp.rateLimited],
    [{ kind: 'failed' }, auth.signUp.failed],
    [{ kind: 'closed' }, auth.signUp.failed],
  ])('⚠ %j says so and keeps what was typed', async (outcome, words) => {
    submitSignUp.mockResolvedValue(outcome);
    show();
    await fill();
    await userEvent.click(screen.getByTestId('signup-terms-box'));
    await userEvent.click(screen.getByTestId('signup-submit'));
    expect(await screen.findByTestId('signup-problem')).toHaveTextContent(words);
    expect(screen.getByTestId('signup-email')).toHaveValue('maya@aviv.co');
  });

  it('★ a field the server refused is marked', async () => {
    submitSignUp.mockResolvedValue({ kind: 'invalid', field: 'email' });
    show();
    await fill();
    await userEvent.click(screen.getByTestId('signup-terms-box'));
    await userEvent.click(screen.getByTestId('signup-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('signup-email')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getByTestId('signup-name')).not.toHaveAttribute('aria-invalid');
  });
});
