import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { unansweredQuestionSchema } from '@/api/contracts/knowledge';
import onboardingMessages from '@/i18n/messages/en/onboarding.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push }),
}));
const actions = vi.hoisted(() => ({ teachAnswer: vi.fn(), finishOnboarding: vi.fn() }));
vi.mock('./onboarding-actions', () => actions);

import { TryStep } from './TryStep';

const q = (id: string, question: string, timesAsked = 1) =>
  unansweredQuestionSchema.parse({ id, question, timesAsked });

const show = (questions: Parameters<typeof TryStep>[0]['questions'], skippedCore = false) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingMessages }}>
      <TryStep questions={questions} skippedCore={skippedCore} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  actions.teachAnswer.mockReset();
  actions.finishOnboarding.mockReset();
  push.mockReset();
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

  it('none yet, and unread, are different sentences', () => {
    const one = show([]);
    expect(screen.getByTestId('try-lead')).toHaveTextContent('Once customers write');
    one.unmount();
    show(null);
    expect(screen.getByTestId('try-lead')).toHaveTextContent("Couldn't read");
  });
});

describe('★★ "Open my workspace" finishes - routed on the flags, never the prose', () => {
  const open = async () => {
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-open'));
    });
  };

  it('done: Home; skipping 00g is told to the route, and only then', async () => {
    actions.finishOnboarding.mockResolvedValue({ ok: true, payAt: null, knowledgeUsable: true });
    show([], true);
    await open();
    expect(actions.finishOnboarding).toHaveBeenCalledWith({ skippedCore: true, locale: 'en' });
    expect(push).toHaveBeenCalledWith('/home');
  });

  it('owes payment: to payment, not Home', async () => {
    const replace = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { replace } });
    actions.finishOnboarding.mockResolvedValue({
      ok: true,
      payAt: '/checkout/payment-required?ref=chk_1',
      knowledgeUsable: true,
    });
    show([]);
    await open();
    expect(replace).toHaveBeenCalledWith('/checkout/payment-required?ref=chk_1');
    expect(push).not.toHaveBeenCalled();
  });

  it('nothing usable in Knowledge: said before the workspace, never a silent "all set"', async () => {
    actions.finishOnboarding.mockResolvedValue({ ok: true, payAt: null, knowledgeUsable: false });
    show([]);
    await open();
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId('try-no-knowledge')).toHaveTextContent('nothing to answer from');
    expect(screen.getByTestId('try-open-anyway')).toHaveAttribute('href', '/home');
  });

  it('no core system and not skipped: why, and the way back to 00g', async () => {
    actions.finishOnboarding.mockResolvedValue({
      ok: false,
      reason: 'core_system_required',
      message: 'Connect your main business system',
    });
    show([]);
    await open();
    expect(screen.getByTestId('try-refused')).toHaveTextContent('main business system');
    expect(screen.getByText('Back to Source of truth')).toHaveAttribute(
      'href',
      '/onboarding/truth',
    );
  });
});
