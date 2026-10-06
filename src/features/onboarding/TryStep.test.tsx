import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { unansweredQuestionSchema } from '@/api/contracts/knowledge';
import onboardingMessages from '@/i18n/messages/en/onboarding.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const actions = vi.hoisted(() => ({ teachAnswer: vi.fn() }));
vi.mock('./onboarding-actions', () => actions);

import { TryStep } from './TryStep';

const q = (id: string, question: string, timesAsked = 1) =>
  unansweredQuestionSchema.parse({ id, question, timesAsked });

const show = (questions: Parameters<typeof TryStep>[0]['questions']) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingMessages }}>
      <TryStep questions={questions} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  actions.teachAnswer.mockReset();
});

describe('★★ 00h - real questions, taught once; no answer it could not have given', () => {
  it('real questions, how often asked - and no answer drawn, with why', () => {
    show([q('a', 'Do you deliver to Eilat?', 4), q('b', 'Is the Arc lamp back?')]);
    expect(screen.getByTestId('try-question-a')).toHaveTextContent('Do you deliver to Eilat?');
    expect(screen.getByTestId('try-question-a')).toHaveTextContent('Asked 4 times');
    expect(screen.getByTestId('try-why')).toHaveTextContent('needs a live workspace');
    expect(screen.queryByText(/Shopify|Knowledge ·/)).toBeNull();
  });

  it('Teach: the answer goes to Knowledge for that question; learned says so', async () => {
    actions.teachAnswer.mockResolvedValue(true);
    show([q('a', 'Do you deliver to Eilat?')]);
    fireEvent.click(screen.getByTestId('try-teach'));
    expect(screen.getByTestId('try-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('try-answer'), {
      target: { value: 'Yes, 5-7 business days, 45 shekels.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-save'));
    });
    expect(actions.teachAnswer).toHaveBeenCalledWith(
      'Do you deliver to Eilat?',
      'Yes, 5-7 business days, 45 shekels.',
      'en',
    );
    expect(screen.getByTestId('try-learned')).toBeInTheDocument();
  });

  it('not learned: says so, and the answer stays to try again', async () => {
    actions.teachAnswer.mockResolvedValue(false);
    show([q('a', 'Do you deliver to Eilat?')]);
    fireEvent.click(screen.getByTestId('try-teach'));
    fireEvent.change(screen.getByTestId('try-answer'), { target: { value: 'Yes.' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-save'));
    });
    expect(screen.getByTestId('try-failed')).toBeInTheDocument();
    expect(screen.getByTestId('try-answer')).toHaveValue('Yes.');
  });

  it('none yet, and unread, are different sentences; Home either way - not go-live', () => {
    const one = show([]);
    expect(screen.getByTestId('try-lead')).toHaveTextContent('Once customers write');
    expect(screen.getByTestId('try-open')).toHaveAttribute('href', '/home');
    one.unmount();
    show(null);
    expect(screen.getByTestId('try-lead')).toHaveTextContent("Couldn't read");
  });
});
