import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CheckoutSummary } from '@/api/contracts/checkout';
import messages from '@/i18n/messages/en/checkout.json';

/**
 * /checkout and /checkout/payment-required, rendered directly - as the proxy will serve them
 * signed out once `/checkout` is on its allowlist (fe/public). Billing is
 * never reached: its reads are spies, and the client controls are markers
 * carrying the props the page decided.
 */
const loadCheckout = vi.hoisted(() => vi.fn());
const loadMine = vi.hoisted(() => vi.fn());
const writes = vi.hoisted(() => ({ on: true }));
vi.mock('server-only', () => ({}));
vi.mock('@/features/checkout/load-checkout', () => ({ loadCheckout, loadMine }));
vi.mock('@/api/client/billing-writes', () => ({ billingWritesEnabled: () => writes.on }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { checkout: messages },
      namespace: namespace as 'checkout',
    }),
}));
const redirect = vi.hoisted(() =>
  vi.fn((to: { href: unknown; locale: string }) => {
    throw new Error(`REDIRECT ${JSON.stringify(to)}`);
  }),
);
vi.mock('@/i18n/navigation', () => ({
  redirect,
  Link: ({ children, href, ...rest }: { children: ReactNode; href: unknown }) => (
    <a data-href={JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/features/checkout/PayButton', () => ({
  PayButton: (p: { reference: string; label: string; live: boolean }) => (
    <p data-testid="pay" data-live={String(p.live)} data-reference={p.reference}>
      {p.label}
    </p>
  ),
}));
vi.mock('@/features/checkout/CheckoutOpen', () => ({
  CheckoutOpen: (p: { reference: string; token: string }) => (
    <p data-testid="open" data-reference={p.reference} data-token={p.token} />
  ),
}));

const { default: Entry } = await import('./page');
const { default: PaymentRequired } = await import('./payment-required/page');

type Page = (props: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | undefined>>;
}) => Promise<ReactNode>;

const summary = (over: Partial<CheckoutSummary> = {}): CheckoutSummary => ({
  reference: 'chk_1',
  status: 'PAYMENT_REQUIRED',
  organizationName: 'Acme',
  planName: 'Growth',
  includedCredits: 20000,
  amount: '499',
  currency: 'USD',
  charge: null,
  billingInterval: 'MONTHLY',
  expiresAt: null,
  retryEligible: true,
  paymentSetupAvailable: true,
  declineCategory: null,
  awaitingResolution: false,
  ...over,
});
const ready = (over: Partial<CheckoutSummary> = {}) =>
  loadCheckout.mockResolvedValue({ kind: 'ready', summary: summary(over) });

const open = async (page: Page, query: Record<string, string> = {}, locale = 'en') => {
  const node = await page({
    params: Promise.resolve({ locale }),
    searchParams: Promise.resolve(query),
  });
  render(
    <NextIntlClientProvider locale="en" timeZone="Asia/Jerusalem" messages={{ checkout: messages }}>
      {node}
    </NextIntlClientProvider>,
  );
};
const redirectedTo = () => redirect.mock.calls[0]?.[0];

beforeEach(() => {
  loadCheckout.mockReset();
  loadMine.mockReset();
  redirect.mockClear();
  writes.on = true;
});

describe('★★ /checkout - the emailed link, and the product’s fallback', () => {
  it('ref + token: handed to the opener, nothing read here', async () => {
    await open(Entry as Page, { ref: 'chk_1', token: 'tok_123' });
    expect(screen.getByTestId('open')).toHaveAttribute('data-token', 'tok_123');
    expect(loadCheckout).not.toHaveBeenCalled();
  });

  it('ref alone: to the page billing names', async () => {
    ready({ status: 'FAILED' });
    await expect(open(Entry as Page, { ref: 'chk_1' }, 'he')).rejects.toThrow('REDIRECT');
    expect(redirectedTo()).toEqual({
      href: { pathname: '/checkout/failed', query: { ref: 'chk_1' } },
      locale: 'he',
    });
  });

  it('ref alone, not readable: unavailable', async () => {
    loadCheckout.mockResolvedValue({ kind: 'unavailable' });
    await open(Entry as Page, { ref: 'chk_1' });
    expect(screen.getByTestId('checkout-unavailable')).toBeInTheDocument();
  });

  it('★ nothing: a signed-in member’s own outstanding checkout', async () => {
    loadMine.mockResolvedValue({ kind: 'open', reference: 'chk_9' });
    await expect(open(Entry as Page)).rejects.toThrow('REDIRECT');
    expect(redirectedTo()?.href).toEqual({
      pathname: '/checkout/payment-required',
      query: { ref: 'chk_9' },
    });
  });

  it('nothing, and none open: unavailable', async () => {
    loadMine.mockResolvedValue({ kind: 'none' });
    await open(Entry as Page);
    expect(screen.getByTestId('checkout-unavailable')).toBeInTheDocument();
  });
});

describe('★★ /checkout/payment-required', () => {
  it('the plan and the way to pay, live', async () => {
    ready();
    await open(PaymentRequired as Page, { ref: 'chk_1' });
    expect(screen.getByTestId('checkout-payment-required')).toHaveTextContent('One step left');
    expect(screen.getByTestId('checkout-summary')).toHaveTextContent('Growth');
    expect(screen.getByTestId('pay')).toHaveAttribute('data-live', 'true');
    expect(screen.getByTestId('pay')).toHaveTextContent('Set up payment');
  });

  it('★ BILLING_WRITES off: the control is handed down held', async () => {
    writes.on = false;
    ready();
    await open(PaymentRequired as Page, { ref: 'chk_1' });
    expect(screen.getByTestId('pay')).toHaveAttribute('data-live', 'false');
  });

  it('★ a declined card is said first, and the button offers another card', async () => {
    ready({ declineCategory: 'INSUFFICIENT_FUNDS' });
    await open(PaymentRequired as Page, { ref: 'chk_1' });
    expect(screen.getByTestId('checkout-declined')).toHaveTextContent(
      'The payment was declined for insufficient funds. Try a different card.',
    );
    expect(screen.getByTestId('pay')).toHaveTextContent('Try a different card');
  });

  it('payment cannot be set up: said, no button, and no "try another card"', async () => {
    ready({ paymentSetupAvailable: false, declineCategory: 'DECLINED' });
    await open(PaymentRequired as Page, { ref: 'chk_1' });
    expect(screen.queryByTestId('pay')).toBeNull();
    expect(screen.getByTestId('checkout-not-yet')).toHaveTextContent(
      "Secure payment isn't available yet.",
    );
    expect(screen.getByTestId('checkout-declined')).not.toHaveTextContent('Try a different card');
  });

  it('★ a paid checkout is not asked for a card: moved to completed', async () => {
    ready({ status: 'COMPLETED' });
    await expect(open(PaymentRequired as Page, { ref: 'chk_1' })).rejects.toThrow('REDIRECT');
    expect(redirectedTo()?.href).toEqual({
      pathname: '/checkout/completed',
      query: { ref: 'chk_1' },
    });
  });

  it('★ from the product’s gate with no reference: the member’s own', async () => {
    loadMine.mockResolvedValue({ kind: 'open', reference: 'chk_9' });
    await expect(open(PaymentRequired as Page)).rejects.toThrow('REDIRECT');
    expect(redirectedTo()?.href).toEqual({
      pathname: '/checkout/payment-required',
      query: { ref: 'chk_9' },
    });
  });

  it('no reference, the member’s offer ran out: expired', async () => {
    loadMine.mockResolvedValue({ kind: 'expired' });
    await expect(open(PaymentRequired as Page)).rejects.toThrow('REDIRECT');
    expect(redirectedTo()?.href).toBe('/checkout/expired');
  });

  it('a link that is not this visitor’s: unavailable', async () => {
    loadCheckout.mockResolvedValue({ kind: 'unavailable' });
    await open(PaymentRequired as Page, { ref: 'chk_1' });
    expect(screen.getByTestId('checkout-unavailable')).toBeInTheDocument();
  });
});
