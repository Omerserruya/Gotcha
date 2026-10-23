import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { learnedSchema } from '@/api/contracts/onboarding-v2';
import onboardingEn from '@/i18n/messages/en/onboarding.json';

/** Step 4, checking what was learned. Mocked: nothing is rewritten. */
const { edit, upload, router } = vi.hoisted(() => ({
  edit: { editLearned: vi.fn(), readLearned: vi.fn(), addPolicy: vi.fn() },
  upload: { uploadLearned: vi.fn() },
  router: { refresh: vi.fn() },
}));
vi.mock('./learned-actions', () => edit);
vi.mock('./upload-learned', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  uploadLearned: upload.uploadLearned,
}));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => router,
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
  edit.addPolicy.mockReset();
  upload.uploadLearned.mockReset();
});

describe('★★ checking what was learned', () => {
  it('★★ every section, in plain words: the business, products, a policy WITH its terms, FAQ, contact, voice, tools', () => {
    show();
    expect(screen.getByTestId('review-profile')).toHaveTextContent('Aviv & Co. · Fashion');
    expect(screen.getByTestId('review-products-count')).toHaveTextContent(
      /^At least 34 products in the store$/,
    );
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

  it('★★ products come only from the store’s own feed: a store count, "at least" only when paging stopped; none learned is said', () => {
    const { unmount } = show({
      initial: learned({ products: { ...base.products, more: false, source: 'woo_store_api' } }),
    });
    expect(screen.getByTestId('review-products-count')).toHaveTextContent(
      /^34 products in the store$/,
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
    fireEvent.change(within(form).getByLabelText('What the policy says'), {
      target: { value: ' Return within 30 days. ' },
    });
    fireEvent.change(within(form).getByLabelText('Days to return'), { target: { value: '30' } });
    await act(async () => fireEvent.submit(form));
    // The terms travel with the words: one truth, whole objects per key (Backend merges by key).
    expect(edit.editLearned).toHaveBeenCalledWith({
      section: 'policies',
      id: 'returns',
      value: {
        summary: 'Return within 30 days.',
        terms: { windowDays: 30, exchange: { allowed: true, how: 'In store' }, refund: null },
      },
    });
    expect(screen.getByTestId('review-policy-returns-terms')).toHaveTextContent(
      'Returns within 30 days',
    );
    expect(screen.queryByTestId('review-edit-policies-returns')).toBeNull();
  });

  it('★★ a policy’s term fields follow its kind; a term already there is always editable', () => {
    show({
      initial: learned({
        policies: [
          {
            id: 'shipping',
            kind: 'shipping',
            summary: 'Ships fast.',
            terms: { shipping: { times: '3 days', costs: null, freeOver: 200 }, windowDays: 7 },
            sourceUrl: null,
          },
          {
            id: 'privacy',
            kind: 'privacy',
            summary: 'We keep data safe.',
            terms: null,
            sourceUrl: null,
          },
        ],
      }),
    });
    fireEvent.click(screen.getByTestId('review-policy-shipping-edit'));
    const form = screen.getByTestId('review-edit-policies-shipping');
    expect(within(form).getByLabelText('Shipping times')).toHaveValue('3 days');
    expect(within(form).getByLabelText('Free shipping over')).toHaveValue('200');
    expect(within(form).getByLabelText('Days to return')).toHaveValue('7');
    expect(within(form).queryByLabelText('Warranty, in months')).toBeNull();
    // Hebrew values on an English screen: each field takes its own direction.
    for (const field of within(form).getAllByRole('textbox')) {
      expect(field).toHaveAttribute('dir', 'auto');
    }
    fireEvent.click(screen.getByTestId('review-policy-privacy-edit'));
    const words = screen.getByTestId('review-edit-policies-privacy');
    expect(within(words).getAllByRole('textbox')).toHaveLength(1);
    expect(words).not.toHaveTextContent('These terms are what GOTCHA answers from');
  });

  it('★★ free shipping over is an order total, a NUMBER: shown, edited, and sent back as one', async () => {
    const shipping = {
      id: 'shipping',
      kind: 'shipping',
      summary: 'Ships fast.',
      terms: { shipping: { times: null, costs: null, freeOver: 250 } },
      sourceUrl: null,
    };
    const initial = learned({ policies: [shipping] });
    edit.editLearned.mockResolvedValue({ ok: true, learned: initial });
    show({ initial });
    expect(screen.getByTestId('review-policy-shipping-terms')).toHaveTextContent(
      'Free shipping over 250',
    );
    fireEvent.click(screen.getByTestId('review-policy-shipping-edit'));
    const form = screen.getByTestId('review-edit-policies-shipping');
    expect(within(form).getByLabelText('Free shipping over')).toHaveValue('250');
    fireEvent.change(within(form).getByLabelText('Free shipping over'), {
      target: { value: '199.9' },
    });
    await act(async () => fireEvent.submit(form));
    expect(edit.editLearned).toHaveBeenLastCalledWith({
      section: 'policies',
      id: 'shipping',
      value: {
        summary: 'Ships fast.',
        terms: { shipping: { times: null, costs: null, freeOver: 199.9 } },
      },
    });
  });

  it('★ a policy with no terms sends its words only; a cleared term is sent as null', async () => {
    const initial = learned({
      policies: [
        { id: 'privacy', kind: 'privacy', summary: 'Safe.', terms: null, sourceUrl: null },
        {
          id: 'warranty',
          kind: 'warranty',
          summary: '12 months.',
          terms: { warranty: { months: 12 } },
          sourceUrl: null,
        },
      ],
    });
    edit.editLearned.mockResolvedValue({ ok: true, learned: initial });
    show({ initial });
    fireEvent.click(screen.getByTestId('review-policy-privacy-edit'));
    const words = screen.getByTestId('review-edit-policies-privacy');
    fireEvent.change(within(words).getByRole('textbox'), { target: { value: 'Very safe.' } });
    await act(async () => fireEvent.submit(words));
    expect(edit.editLearned).toHaveBeenLastCalledWith({
      section: 'policies',
      id: 'privacy',
      value: { summary: 'Very safe.' },
    });
    fireEvent.click(screen.getByTestId('review-policy-warranty-edit'));
    const warranty = screen.getByTestId('review-edit-policies-warranty');
    fireEvent.change(within(warranty).getByLabelText('Warranty, in months'), {
      target: { value: '' },
    });
    await act(async () => fireEvent.submit(warranty));
    expect(edit.editLearned).toHaveBeenLastCalledWith({
      section: 'policies',
      id: 'warranty',
      value: { summary: '12 months.', terms: { warranty: null } },
    });
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

  beforeEach(() => {
    router.refresh.mockReset();
  });

  it('not learned: "we haven\'t read the site yet", with the way back to learning it; nothing to retry', () => {
    unavailable('not_learned');
    expect(screen.getByRole('alert')).toHaveTextContent("We haven't read the site yet");
    expect(screen.getByTestId('review-back')).toHaveAttribute('href', '/onboarding/website');
    expect(screen.getByTestId('review-back')).toHaveTextContent('Back to learning the site');
    expect(screen.getByTestId('review-back').className).toMatch(/primary/);
    expect(screen.queryByTestId('review-retry')).toBeNull();
  });

  it('★★ unread: said as a failed read, never "nothing learned"; try again reads it again, or go back', () => {
    unavailable('unread');
    expect(screen.getByRole('alert')).toHaveTextContent(
      /^We couldn't read what we learned just now\.$/,
    );
    fireEvent.click(screen.getByTestId('review-retry'));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('review-retry').className).toMatch(/primary/);
    expect(screen.getByTestId('review-back')).toHaveAttribute('href', '/onboarding/website');
    expect(screen.getByTestId('review-back').className).toMatch(/secondary/);
  });
});

/** With a policy learned, the add form waits behind one quiet line. */
const openAdd = () => fireEvent.click(screen.getByTestId('review-add-open'));

describe('★★ adding what the site didn’t give us: paste a policy, or a file', () => {
  it('★★ in the policies card, after the list: one quiet line when some were learned, open when none were', () => {
    const { unmount } = show();
    const card = screen.getByTestId('review-policies');
    expect(within(card).getByTestId('review-add-open')).toHaveTextContent(
      /^A policy missing\? Add from what you have$/,
    );
    expect(screen.queryByTestId('review-paste')).toBeNull();
    const items = card.querySelectorAll(
      '[data-testid^="review-policy-"], [data-testid="review-add-open"]',
    );
    expect(items[items.length - 1]).toHaveAttribute('data-testid', 'review-add-open');
    openAdd();
    expect(within(card).getByTestId('review-paste')).toBeInTheDocument();
    expect(screen.queryByTestId('review-add-open')).toBeNull();
    unmount();
    show({ initial: learned({ policies: [] }) });
    expect(screen.queryByTestId('review-add-open')).toBeNull();
    expect(
      within(screen.getByTestId('review-policies')).getByTestId('review-paste'),
    ).toBeInTheDocument();
  });

  it('★★ paste: only the kinds not learned yet; sent as { section, id: kind, value: { text } }; the screen redraws', async () => {
    edit.addPolicy.mockResolvedValue({
      ok: true,
      learned: learned({
        policies: [
          ...base.policies,
          {
            id: 'shipping',
            kind: 'shipping',
            summary: 'Ships in 3 days.',
            terms: null,
            sourceUrl: 'pasted',
            text: 'We ship in 3 days.',
          },
        ],
      }),
    });
    show();
    openAdd();
    const kinds = [...screen.getByTestId('review-paste-kind').querySelectorAll('option')].map(
      (o) => o.value,
    );
    expect(kinds).not.toContain('returns');
    expect(kinds[0]).toBe('exchange');
    fireEvent.change(screen.getByTestId('review-paste-kind'), { target: { value: 'shipping' } });
    expect(screen.getByTestId('review-paste-add')).toBeDisabled();
    fireEvent.change(screen.getByTestId('review-paste-text'), {
      target: { value: 'We ship in 3 days.' },
    });
    await act(async () => fireEvent.submit(screen.getByTestId('review-paste')));
    expect(edit.addPolicy).toHaveBeenCalledWith('shipping', 'We ship in 3 days.');
    expect(
      within(screen.getByTestId('review-policy-shipping')).getByTestId('review-source'),
    ).toHaveTextContent('From what you pasted');
    expect(screen.getByTestId('review-paste-text')).toHaveValue('');
  });

  it('★ a refused paste is said', async () => {
    edit.addPolicy.mockResolvedValue({ ok: false, reason: 'text_too_long' });
    show();
    openAdd();
    fireEvent.change(screen.getByTestId('review-paste-text'), { target: { value: 'x' } });
    await act(async () => fireEvent.submit(screen.getByTestId('review-paste')));
    expect(screen.getByTestId('review-paste-refused')).toHaveTextContent('The text is too long.');
  });

  it('★★ upload: what the file added is said; its policies say "from your file"', async () => {
    upload.uploadLearned.mockResolvedValue({
      ok: true,
      result: {
        ...learned({
          policies: [
            ...base.policies,
            {
              id: 'warranty',
              kind: 'warranty',
              summary: '12 months.',
              terms: { warranty: { months: 12 } },
              sourceUrl: 'upload:policies.pdf',
            },
          ],
        }),
        added: { policies: ['warranty'], faq: 2, profile: false },
        partial: true,
      },
    });
    show();
    openAdd();
    const file = new File(['%PDF'], 'policies.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('review-upload-file'), { target: { files: [file] } });
    await act(async () => fireEvent.submit(screen.getByTestId('review-upload')));
    expect(upload.uploadLearned).toHaveBeenCalledWith(file);
    expect(screen.getByTestId('review-upload-done')).toHaveTextContent(
      'From the file: 1 policy and 2 questions.',
    );
    expect(screen.getByTestId('review-upload-done')).toHaveTextContent('only its start was read');
    expect(
      within(screen.getByTestId('review-policy-warranty')).getByTestId('review-source'),
    ).toHaveTextContent('From your file policies.pdf');
  });

  it('★ nothing found in the file: said, nothing changes', async () => {
    upload.uploadLearned.mockResolvedValue({ ok: false, reason: 'nothing_found' });
    show();
    openAdd();
    fireEvent.change(screen.getByTestId('review-upload-file'), {
      target: { files: [new File(['x'], 'a.txt')] },
    });
    await act(async () => fireEvent.submit(screen.getByTestId('review-upload')));
    expect(screen.getByTestId('review-upload-refused')).toHaveTextContent('Nothing was added.');
  });

  it('read a file waits for one', () => {
    show();
    openAdd();
    expect(screen.getByTestId('review-upload-go')).toBeDisabled();
  });
});

describe('★ the file control speaks the screen’s language', () => {
  it('our own label, and the chosen file’s name once chosen', () => {
    show();
    openAdd();
    expect(screen.getByTestId('review-upload-name')).toHaveTextContent('No file chosen yet');
    fireEvent.change(screen.getByTestId('review-upload-file'), {
      target: { files: [new File(['x'], 'returns.pdf')] },
    });
    expect(screen.getByTestId('review-upload-name')).toHaveTextContent('returns.pdf');
    expect(screen.getByText('Choose a file')).toBeInTheDocument();
  });
});
