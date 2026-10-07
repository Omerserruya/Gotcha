import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { previewAnswerSchema, previewQuestionsSchema } from '@/api/contracts/onboarding';
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
const actions = vi.hoisted(() => ({
  teachAnswer: vi.fn(),
  finishOnboarding: vi.fn(),
  askPreview: vi.fn(),
}));
vi.mock('./onboarding-actions', () => actions);

import { TryStep } from './TryStep';

const read = (real: unknown[], suggested: unknown[] = []) =>
  previewQuestionsSchema.parse({ data: { real, suggested } }).data;
const answer = (raw: Record<string, unknown>) =>
  ({ ok: true, answer: previewAnswerSchema.parse({ data: raw }).data }) as const;
const grounded = answer({
  answer: 'We do. 5-7 business days, 45 shekels',
  grounded: true,
  sources: [
    {
      documentId: 'd1',
      title: 'Shipping',
      sourceUrl: 'https://urban.example/shipping',
      path: '/shipping',
    },
    { documentId: 'd2', title: 'FAQ', sourceUrl: 'javascript:alert(1)', path: '' },
  ],
});
const ungrounded = answer({ answer: "I don't know that yet", grounded: false, sources: [] });

const show = (questions: Parameters<typeof TryStep>[0]['questions'], skippedCore = false) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingMessages }}>
      <TryStep questions={questions} skippedCore={skippedCore} />
    </NextIntlClientProvider>,
  );

const click = async (testid: string) => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testid));
  });
};

beforeEach(() => {
  actions.teachAnswer.mockReset();
  actions.finishOnboarding.mockReset();
  actions.askPreview.mockReset();
  push.mockReset();
});

describe('★★ 00h - the questions, in two groups', () => {
  it('real ones with how often asked; suggested ones apart; no answer asked for on arrival', () => {
    show(
      read(
        [{ id: 'a', question: 'Do you deliver to Eilat?', askCount: 4 }],
        [{ question: 'Can I return a sale item?', basis: 'returns policy' }],
      ),
    );
    expect(screen.getByTestId('try-real')).toHaveTextContent('Your real questions');
    expect(screen.getByTestId('try-real-0')).toHaveTextContent('Do you deliver to Eilat?');
    expect(screen.getByTestId('try-real-0')).toHaveTextContent('Asked 4 times');
    expect(screen.getByTestId('try-suggested')).toHaveTextContent(
      'Questions customers usually ask',
    );
    expect(screen.getByTestId('try-suggested-0')).not.toHaveTextContent(/Asked/);
    expect(actions.askPreview).not.toHaveBeenCalled();
  });

  it('none, and unread, are different sentences - and the field is there in both', () => {
    const one = show(read([], []));
    expect(screen.getByTestId('try-lead')).toHaveTextContent('No customer questions to try yet');
    expect(screen.getByTestId('try-own-field')).toBeInTheDocument();
    one.unmount();
    show(null);
    expect(screen.getByTestId('try-lead')).toHaveTextContent("Couldn't read");
    expect(screen.getByTestId('try-own-field')).toBeInTheDocument();
  });
});

describe('★★ an answer, on request, with where it came from', () => {
  it('See how GOTCHA answers asks that question; the answer and its sources show', async () => {
    actions.askPreview.mockResolvedValue(grounded);
    show(read([{ id: 'a', question: 'Do you deliver to Eilat?' }]));
    await click('try-real-0-see');
    expect(actions.askPreview).toHaveBeenCalledWith('Do you deliver to Eilat?', 'en');
    expect(screen.getByTestId('try-real-0-answer')).toHaveTextContent('We do. 5-7 business days');
    const [shipping, faq] = screen.getAllByTestId('try-real-0-source');
    expect(shipping).toHaveTextContent('Knowledge · Shipping');
    expect(shipping).toHaveAttribute('href', 'https://urban.example/shipping');
    expect(shipping).toHaveAttribute('target', '_blank');
    // A source address that is not a web page is no link at all.
    expect(faq?.tagName).toBe('SPAN');
    expect(faq).not.toHaveAttribute('href');
  });

  it('not grounded: a status, not an answer that worked - and Fix is the way on', async () => {
    actions.askPreview.mockResolvedValue(ungrounded);
    show(read([{ id: 'a', question: 'Do you ship abroad?' }]));
    await click('try-real-0-see');
    expect(screen.getByTestId('try-real-0-not-learned')).toHaveTextContent(
      'Not in what GOTCHA learned yet',
    );
    expect(screen.queryByTestId('try-real-0-good')).toBeNull();
    expect(screen.queryByTestId('try-real-0-source')).toBeNull();
    expect(screen.getByTestId('try-real-0-fix').className).toContain('primary');
  });

  it('Good says so, and asks nothing more', async () => {
    actions.askPreview.mockResolvedValue(grounded);
    show(read([{ id: 'a', question: 'Do you deliver to Eilat?' }]));
    await click('try-real-0-see');
    await click('try-real-0-good');
    expect(screen.getByTestId('try-real-0-good-line')).toHaveTextContent(
      "Good, this is how it'll answer",
    );
    expect(actions.askPreview).toHaveBeenCalledTimes(1);
  });

  it('Fix: the answer to edit, taught, then the same question asked again - the new answer shows', async () => {
    actions.askPreview
      .mockResolvedValueOnce(grounded)
      .mockResolvedValueOnce(
        answer({ answer: 'Yes, 3 days, free over 350', grounded: true, sources: [] }),
      );
    actions.teachAnswer.mockResolvedValue(true);
    show(read([{ id: 'a', question: 'Do you deliver to Eilat?' }]));
    await click('try-real-0-see');
    await click('try-real-0-fix');
    expect(screen.getByTestId('try-real-0-fix-text')).toHaveValue(
      'We do. 5-7 business days, 45 shekels',
    );
    fireEvent.change(screen.getByTestId('try-real-0-fix-text'), {
      target: { value: 'Yes, 3 days, free over 350' },
    });
    await click('try-real-0-teach');
    expect(actions.teachAnswer).toHaveBeenCalledWith(
      'Do you deliver to Eilat?',
      'Yes, 3 days, free over 350',
      'en',
    );
    expect(actions.askPreview).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('try-real-0-answer')).toHaveTextContent('Yes, 3 days, free over 350');
    expect(screen.getByTestId('try-real-0-relearned')).toBeInTheDocument();
  });

  it('Fix on "not learned" starts empty; not taught says so and keeps the text', async () => {
    actions.askPreview.mockResolvedValue(ungrounded);
    actions.teachAnswer.mockResolvedValue(false);
    show(read([{ id: 'a', question: 'Do you ship abroad?' }]));
    await click('try-real-0-see');
    await click('try-real-0-fix');
    expect(screen.getByTestId('try-real-0-fix-text')).toHaveValue('');
    expect(screen.getByTestId('try-real-0-teach')).toBeDisabled();
    fireEvent.change(screen.getByTestId('try-real-0-fix-text'), { target: { value: 'No.' } });
    await click('try-real-0-teach');
    expect(screen.getByTestId('try-real-0-fix-failed')).toBeInTheDocument();
    expect(screen.getByTestId('try-real-0-fix-text')).toHaveValue('No.');
    expect(actions.askPreview).toHaveBeenCalledTimes(1);
  });
});

describe('★★ Ask your own question - its problems next to it', () => {
  const ask = async (text: string) => {
    fireEvent.change(screen.getByTestId('try-own-field'), { target: { value: text } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('try-own-field').closest('form')!);
    });
  };

  it('asked: the answer shows as a card, and the field empties', async () => {
    actions.askPreview.mockResolvedValue(grounded);
    show(read([]));
    await ask('  Do you deliver to Eilat?  ');
    expect(actions.askPreview).toHaveBeenCalledWith('Do you deliver to Eilat?', 'en');
    expect(screen.getByTestId('try-own-0')).toHaveTextContent('Do you deliver to Eilat?');
    expect(screen.getByTestId('try-own-0-answer')).toHaveTextContent('We do.');
    expect(screen.getByTestId('try-own-field')).toHaveValue('');
  });

  it('empty is said without asking', async () => {
    show(read([]));
    await ask('   ');
    expect(actions.askPreview).not.toHaveBeenCalled();
    expect(screen.getByTestId('try-own-refused')).toHaveTextContent('Write a question first');
  });

  it.each([
    [{ ok: false, reason: 'too_long' }, 'under 300 characters'],
    [{ ok: false, reason: 'rate', seconds: 17 }, 'Try again in 17 seconds'],
    [{ ok: false, reason: 'no_ai' }, 'no AI available'],
    [{ ok: false, reason: 'forbidden' }, 'Only an admin'],
    [{ ok: false, reason: 'failed' }, "couldn't answer just now"],
  ])('%o is said in its own words, and the question stays', async (refusal, words) => {
    actions.askPreview.mockResolvedValue(refusal);
    show(read([]));
    await ask('Do you deliver?');
    expect(screen.getByTestId('try-own-refused')).toHaveTextContent(words);
    expect(screen.getByTestId('try-own-field')).toHaveValue('Do you deliver?');
  });

  it('the field holds no more than the route takes', () => {
    show(read([]));
    expect(screen.getByTestId('try-own-field')).toHaveAttribute('maxLength', '300');
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
    show(read([]), true);
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
    show(read([]));
    await open();
    expect(replace).toHaveBeenCalledWith('/checkout/payment-required?ref=chk_1');
    expect(push).not.toHaveBeenCalled();
  });

  it('nothing usable in Knowledge: said before the workspace, never a silent "all set"', async () => {
    actions.finishOnboarding.mockResolvedValue({ ok: true, payAt: null, knowledgeUsable: false });
    show(read([]));
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
    show(read([]));
    await open();
    expect(screen.getByTestId('try-refused')).toHaveTextContent('main business system');
    expect(screen.getByText('Back to Source of truth')).toHaveAttribute(
      'href',
      '/onboarding/truth',
    );
  });
});
