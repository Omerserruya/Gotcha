import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { learnedSchema } from '@/api/contracts/onboarding-v2';
import onboardingEn from '@/i18n/messages/en/onboarding.json';

/** Step 4, checking what was learned. Mocked: nothing is rewritten. */
const { edit } = vi.hoisted(() => ({ edit: { editLearned: vi.fn(), readLearned: vi.fn() } }));
vi.mock('./learned-actions', () => edit);
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ReviewStep, ReviewUnavailable } from './ReviewStep';

const base = {
  domain: 'https://avivco.il',
  profile: { name: 'Aviv & Co.', industry: 'Fashion', summary: 'Urban wear', valueProp: null },
  products: {
    count: 34,
    more: true,
    categories: ['Shirts'],
    priceRange: { min: 49, max: 390, currency: 'ILS' },
    highlights: [],
    source: 'feed',
  },
  policies: [
    {
      id: 'returns',
      kind: 'returns',
      summary: 'Return within 14 days.',
      terms: { windowDays: 14, exchange: { allowed: true, how: 'In store' } },
      sourceUrl: 'https://avivco.il/policies/refund-policy',
    },
  ],
  faq: [{ id: 'f1', q: 'Do you ship abroad?', a: 'Only within Israel.', sourceUrl: null }],
  contact: {
    emails: ['hi@avivco.il'],
    phones: ['03-1234567'],
    whatsapp: [],
    address: null,
    hours: 'Sun-Thu 9-18',
  },
  brand: {
    voice: 'Warm and short.',
    greetingExample: 'Hi there!',
    forbiddenWords: ['Dear customer'],
  },
  tools: [{ slug: 'returngo', name: 'ReturnGO' }],
};
const learned = (over: object = {}) => learnedSchema.parse({ ...base, ...over });
const show = (props: Partial<Parameters<typeof ReviewStep>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ onboarding: onboardingEn }}>
      <ReviewStep initial={learned()} {...props} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  edit.editLearned.mockReset();
});

describe('★★ checking what was learned', () => {
  it('★★ every section, in plain words: the business, products, a policy WITH its terms, FAQ, contact, voice, tools', () => {
    show();
    expect(screen.getByTestId('review-profile')).toHaveTextContent('Aviv & Co. · Fashion');
    expect(screen.getByTestId('review-products-count')).toHaveTextContent('34 products, and more');
    const terms = screen.getByTestId('review-policy-returns-terms');
    expect(terms).toHaveTextContent('Returns within 14 days');
    expect(terms).toHaveTextContent('Exchanges allowed: In store');
    expect(within(screen.getByTestId('review-policy-returns')).getByRole('link')).toHaveAttribute(
      'href',
      'https://avivco.il/policies/refund-policy',
    );
    expect(screen.getByTestId('review-faq-f1')).toHaveTextContent('Only within Israel.');
    expect(screen.getByTestId('review-contact')).toHaveTextContent('Hours: Sun-Thu 9-18');
    expect(screen.getByTestId('review-brand')).toHaveTextContent('Never says: Dear customer');
    expect(screen.getByTestId('review-tools')).toHaveTextContent('ReturnGO');
  });

  it('★★ sampled products say "sampled", never a catalogue size; none learned is said', () => {
    const { unmount } = show({
      initial: learned({ products: { ...base.products, count: 6, source: 'sampled' } }),
    });
    expect(screen.getByTestId('review-products-count')).toHaveTextContent(
      '6 products sampled from product pages',
    );
    unmount();
    show({ initial: learned({ products: null }) });
    expect(screen.getByTestId('review-products')).toHaveTextContent("We didn't learn the products");
  });

  it('★★ edit a policy: the change is sent, and the screen redraws from the SERVER’s answer', async () => {
    edit.editLearned.mockResolvedValue({
      ok: true,
      learned: learned({
        policies: [
          { ...base.policies[0], summary: 'Return within 30 days.', terms: { windowDays: 30 } },
        ],
      }),
    });
    show();
    fireEvent.click(screen.getByTestId('review-policy-returns-edit'));
    const form = screen.getByTestId('review-edit-policies-returns');
    fireEvent.change(within(form).getByRole('textbox'), {
      target: { value: ' Return within 30 days. ' },
    });
    await act(async () => fireEvent.submit(form));
    expect(edit.editLearned).toHaveBeenCalledWith({
      section: 'policies',
      id: 'returns',
      value: { summary: 'Return within 30 days.' },
    });
    expect(screen.getByTestId('review-policy-returns-terms')).toHaveTextContent(
      'Returns within 30 days',
    );
    expect(screen.queryByTestId('review-edit-policies-returns')).toBeNull();
  });

  it('★ Save waits for a change - pressing Enter on an unchanged form sends nothing either', async () => {
    show();
    fireEvent.click(screen.getByTestId('review-brand-edit'));
    const form = screen.getByTestId('review-edit-brand');
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();
    await act(async () => fireEvent.submit(form));
    expect(edit.editLearned).not.toHaveBeenCalled();
  });

  it('★★ remove is confirmed first, then sent', async () => {
    edit.editLearned.mockResolvedValue({ ok: true, learned: learned({ faq: [] }) });
    show();
    fireEvent.click(screen.getByTestId('review-faq-f1-remove'));
    expect(edit.editLearned).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByTestId('review-faq-f1-remove-yes')));
    expect(edit.editLearned).toHaveBeenCalledWith({ section: 'faq', id: 'f1', remove: true });
    expect(screen.getByTestId('review-faq')).toHaveTextContent("We didn't find FAQs on the site.");
  });

  it('★★ add a question: no id, both halves', async () => {
    edit.editLearned.mockResolvedValue({ ok: true, learned: learned() });
    show();
    fireEvent.click(screen.getByTestId('review-faq-add'));
    const form = screen.getByTestId('review-edit-faq');
    fireEvent.change(within(form).getByLabelText('Question'), { target: { value: 'Gift wrap?' } });
    fireEvent.change(within(form).getAllByRole('textbox')[1]!, { target: { value: 'Yes, free.' } });
    await act(async () => fireEvent.submit(form));
    expect(edit.editLearned).toHaveBeenCalledWith({
      section: 'faq',
      value: { q: 'Gift wrap?', a: 'Yes, free.' },
    });
  });

  it('★ a refusal is said, in words, where it happened', async () => {
    edit.editLearned.mockResolvedValue({ ok: false, reason: 'gone' });
    show();
    fireEvent.click(screen.getByTestId('review-faq-f1-remove'));
    await act(async () => fireEvent.click(screen.getByTestId('review-faq-f1-remove-yes')));
    expect(within(screen.getByTestId('review-faq-f1')).getByRole('alert')).toHaveTextContent(
      'This item was already removed.',
    );
  });

  it('★ a write that rejects reads as failed, never hangs', async () => {
    edit.editLearned.mockRejectedValue(new Error('Failed to fetch'));
    show();
    fireEvent.click(screen.getByTestId('review-faq-f1-remove'));
    await act(async () => fireEvent.click(screen.getByTestId('review-faq-f1-remove-yes')));
    expect(within(screen.getByTestId('review-faq-f1')).getByRole('alert')).toHaveTextContent(
      "We couldn't save.",
    );
  });

  it('★ nothing learned in a section is said, and can be added', () => {
    show({ initial: learned({ profile: null, contact: null, brand: null }) });
    expect(screen.getByTestId('review-profile')).toHaveTextContent(
      "We didn't learn this from the site.",
    );
    expect(screen.getByTestId('review-profile-edit')).toBeInTheDocument();
  });

  it('★ preview: read only', () => {
    show({ preview: true });
    expect(screen.queryByTestId('review-faq-add')).toBeNull();
    expect(screen.queryByTestId('review-policy-returns-edit')).toBeNull();
  });
});

describe('★★ when there is nothing to check', () => {
  const unavailable = (reason: 'not_learned' | 'unread') =>
    render(
      <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingEn }}>
        <ReviewUnavailable reason={reason} />
      </NextIntlClientProvider>,
    );

  it('not learned: said, with the way back to step 1', () => {
    unavailable('not_learned');
    expect(screen.getByRole('alert')).toHaveTextContent("We haven't learned your site yet");
    expect(screen.getByRole('link')).toHaveAttribute('href', '/onboarding/website');
  });

  it('unread: said as unread, never "nothing learned"', () => {
    unavailable('unread');
    expect(screen.getByRole('alert')).toHaveTextContent(
      "We couldn't read what we learned just now.",
    );
    expect(screen.queryByRole('link')).toBeNull();
  });
});
