import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CheckoutSummary } from '@/api/contracts/checkout';
import messages from '@/i18n/messages/en/checkout.json';

/**
 * The checkout's status pages (processing, completed, failed, cancelled,
 * expired), rendered directly - as the proxy will serve them
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
vi.mock('@/features/checkout/ProcessingWatch', () => ({
  ProcessingWatch: (p: { reference: string; initial: CheckoutSummary }) => (
    <p data-testid="watch" data-reference={p.reference} data-status={p.initial.status} />
  ),
}));
vi.mock('@/features/checkout/ResendWelcome', () => ({
  ResendWelcome: () => <p data-testid="resend" />,
}));

const { default: Processing } = await import('./processing/page');
const { default: Completed } = await import('./completed/page');
const { default: Failed } = await import('./failed/page');
const { default: Cancelled } = await import('./cancelled/page');
const { default: Expired } = await import('./expired/page');

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

describe('★★ the provider’s returns', () => {
  it('processing: the watcher, with what was read - not moved by the first read', async () => {
    ready({ status: 'AWAITING_PAYMENT_SETUP' });
    await open(Processing as Page, { ref: 'chk_1' });
    expect(screen.getByTestId('watch')).toHaveAttribute('data-status', 'AWAITING_PAYMENT_SETUP');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('processing, unreadable: unavailable', async () => {
    loadCheckout.mockResolvedValue({ kind: 'unavailable' });
    await open(Processing as Page, { ref: 'chk_1' });
    expect(screen.getByTestId('checkout-unavailable')).toBeInTheDocument();
  });

  it('failed: retry where billing allows it, and support', async () => {
    ready({ status: 'FAILED' });
    await open(Failed as Page, { ref: 'chk_1' });
    expect(screen.getByTestId('checkout-failed')).toHaveTextContent(
      "That payment didn't go through",
    );
    expect(screen.getByTestId('pay')).toHaveTextContent('Try again');
    expect(screen.getByTestId('checkout-support')).toHaveAttribute(
      'href',
      'mailto:support@gotcha.co.il',
    );
  });

  it.each([[{ retryEligible: false }], [{ paymentSetupAvailable: false }]])(
    'failed, %j: no retry',
    async (over) => {
      ready({ status: 'FAILED', ...over });
      await open(Failed as Page, { ref: 'chk_1' });
      expect(screen.queryByTestId('pay')).toBeNull();
    },
  );

  it('cancelled: nothing happened, and the way back to payment', async () => {
    ready({ status: 'AWAITING_PAYMENT_SETUP' });
    await open(Cancelled as Page, { ref: 'chk_1' });
    expect(screen.getByTestId('checkout-cancelled')).toHaveTextContent('Nothing was charged');
    expect(screen.getByTestId('checkout-back-to-payment')).toHaveAttribute(
      'data-href',
      JSON.stringify({ pathname: '/checkout/payment-required', query: { ref: 'chk_1' } }),
    );
  });

  it('★ cancelled, but billing says it went further: moved to where it stands', async () => {
    ready({ status: 'PROCESSING' });
    await expect(open(Cancelled as Page, { ref: 'chk_1' })).rejects.toThrow('REDIRECT');
    expect(redirectedTo()?.href).toEqual({
      pathname: '/checkout/processing',
      query: { ref: 'chk_1' },
    });
  });
});

describe('★★ completed and expired', () => {
  it('completed: into the product, and the email again', async () => {
    ready({ status: 'COMPLETED' });
    await open(Completed as Page, { ref: 'chk_1' });
    expect(screen.getByTestId('checkout-completed')).toHaveTextContent('Your plan is active');
    expect(screen.getByTestId('checkout-continue')).toHaveAttribute('data-href', '"/home"');
    expect(screen.getByTestId('resend')).toBeInTheDocument();
  });

  it('completed is reachable only when billing says so', async () => {
    ready({ status: 'PAYMENT_REQUIRED' });
    await expect(open(Completed as Page, { ref: 'chk_1' })).rejects.toThrow('REDIRECT');
    expect(redirectedTo()?.href).toEqual({
      pathname: '/checkout/payment-required',
      query: { ref: 'chk_1' },
    });
  });

  it('expired: said, and the way to ask for a new link', async () => {
    ready({ status: 'EXPIRED' });
    await open(Expired as Page, { ref: 'chk_1' });
    expect(screen.getByTestId('checkout-expired')).toHaveTextContent('This link has expired');
    expect(screen.getByTestId('checkout-new-link')).toHaveAttribute(
      'href',
      'mailto:support@gotcha.co.il',
    );
  });

  it('expired without a reference (the member’s, from /checkout/mine): said, nothing read', async () => {
    await open(Expired as Page);
    expect(screen.getByTestId('checkout-expired')).toBeInTheDocument();
    expect(loadCheckout).not.toHaveBeenCalled();
  });

  it('expired, with a reference billing will not show: unavailable', async () => {
    loadCheckout.mockResolvedValue({ kind: 'unavailable' });
    await open(Expired as Page, { ref: 'chk_1' });
    expect(screen.getByTestId('checkout-unavailable')).toBeInTheDocument();
  });
});
