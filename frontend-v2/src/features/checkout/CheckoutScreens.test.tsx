import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CheckoutSummary } from '@/api/contracts/checkout';
import messages from '@/i18n/messages/en/checkout.json';

/* Every action is a spy: nothing here reaches billing. */
const startCheckoutPayment = vi.hoisted(() => vi.fn());
const watchCheckout = vi.hoisted(() => vi.fn());
const resendWelcome = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ startCheckoutPayment, watchCheckout, resendWelcome }));
const replace = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace }),
  Link: ({ children, href: _href, ...rest }: { children: ReactNode; href: unknown }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { PayButton } from './PayButton';
import { POLL_MS, ProcessingWatch } from './ProcessingWatch';
import { ResendWelcome } from './ResendWelcome';
import { SummaryCard } from './SummaryCard';

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
  expiresAt: '2026-11-01T09:00:00.000Z',
  retryEligible: true,
  paymentSetupAvailable: true,
  declineCategory: null,
  awaitingResolution: false,
  ...over,
});

const show = async (node: ReactNode) => {
  render(
    <NextIntlClientProvider locale="en" timeZone="Asia/Jerusalem" messages={{ checkout: messages }}>
      {node}
    </NextIntlClientProvider>,
  );
  await act(async () => {});
};

beforeEach(() => {
  for (const spy of [startCheckoutPayment, watchCheckout, resendWelcome, replace]) {
    spy.mockReset();
  }
});
afterEach(() => vi.useRealTimers());

describe('★★ Set up payment', () => {
  it('held: the unavailable status with its reason - no button, nothing asked', async () => {
    await show(<PayButton reference="chk_1" label="Set up payment" live={false} />);
    const held = screen.getByTestId('checkout-pay');
    expect(held.tagName).toBe('SPAN');
    expect(held).toHaveAttribute('aria-disabled', 'true');
    expect(held).toHaveTextContent('Not available here');
    await userEvent.click(held);
    expect(startCheckoutPayment).not.toHaveBeenCalled();
  });

  it('live: to billing’s page, and the button stays down while the browser leaves', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    startCheckoutPayment.mockResolvedValue({ ok: true, url: 'https://pay.example/s' });
    await show(<PayButton reference="chk_1" label="Set up payment" live />);
    await userEvent.click(screen.getByTestId('checkout-pay'));
    expect(startCheckoutPayment).toHaveBeenCalledWith('chk_1');
    expect(assign).toHaveBeenCalledWith('https://pay.example/s');
    expect(screen.getByTestId('checkout-pay')).toBeDisabled();
    vi.unstubAllGlobals();
  });

  it('refused: said, and the button back', async () => {
    startCheckoutPayment.mockResolvedValue({ ok: false, kind: 'failed' });
    await show(<PayButton reference="chk_1" label="Set up payment" live />);
    await userEvent.click(screen.getByTestId('checkout-pay'));
    expect(screen.getByTestId('checkout-pay-refused')).toHaveTextContent(
      "We couldn't open the payment page.",
    );
    expect(screen.getByTestId('checkout-pay')).toBeEnabled();
  });
});

describe('★★ the waiting page', () => {
  it('asks on arrival, and moves when billing’s answer belongs elsewhere', async () => {
    watchCheckout.mockResolvedValue({ kind: 'ready', summary: summary({ status: 'COMPLETED' }) });
    await show(<ProcessingWatch reference="chk_1" initial={summary({ status: 'PROCESSING' })} />);
    expect(watchCheckout).toHaveBeenCalledWith('chk_1');
    expect(replace).toHaveBeenCalledWith({
      pathname: '/checkout/completed',
      query: { ref: 'chk_1' },
    });
  });

  it('★ back to asking for a card when the provider saw none', async () => {
    watchCheckout.mockResolvedValue({
      kind: 'ready',
      summary: summary({ status: 'AWAITING_PAYMENT_SETUP' }),
    });
    await show(<ProcessingWatch reference="chk_1" initial={summary({ status: 'PROCESSING' })} />);
    expect(replace).toHaveBeenCalledWith({
      pathname: '/checkout/payment-required',
      query: { ref: 'chk_1' },
    });
  });

  it('still in flight: asks again after the interval, not before', async () => {
    vi.useFakeTimers();
    watchCheckout.mockResolvedValue({ kind: 'ready', summary: summary({ status: 'PROCESSING' }) });
    await show(<ProcessingWatch reference="chk_1" initial={summary({ status: 'PROCESSING' })} />);
    expect(watchCheckout).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(POLL_MS - 1));
    expect(watchCheckout).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(watchCheckout).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('checkout-processing')).toHaveTextContent('Confirming your payment');
  });

  it('★ a manual review is said as one, and not polled', async () => {
    vi.useFakeTimers();
    watchCheckout.mockResolvedValue({
      kind: 'ready',
      summary: summary({ status: 'MANUAL_REVIEW' }),
    });
    await show(<ProcessingWatch reference="chk_1" initial={summary({ status: 'PROCESSING' })} />);
    expect(screen.getByTestId('checkout-manualReview')).toHaveTextContent(
      "We're checking one thing",
    );
    await act(async () => vi.advanceTimersByTime(POLL_MS * 3));
    expect(watchCheckout).toHaveBeenCalledTimes(1);
  });

  it('★ an unknown outcome promises no moment and warns against paying again', async () => {
    watchCheckout.mockResolvedValue({
      kind: 'ready',
      summary: summary({ status: 'PROCESSING', awaitingResolution: true }),
    });
    await show(<ProcessingWatch reference="chk_1" initial={summary({ status: 'PROCESSING' })} />);
    const page = screen.getByTestId('checkout-unresolved');
    expect(page).toHaveTextContent("Please don't pay again in the meantime.");
    expect(page).not.toHaveTextContent('a few moments');
  });

  it('unreadable: the unavailable state, no more polling', async () => {
    watchCheckout.mockResolvedValue({ kind: 'unavailable' });
    await show(<ProcessingWatch reference="chk_1" initial={summary({ status: 'PROCESSING' })} />);
    expect(screen.getByTestId('checkout-unavailable')).toBeInTheDocument();
  });
});

describe('the welcome email again', () => {
  it('sent: said', async () => {
    resendWelcome.mockResolvedValue({ sent: true });
    await show(<ResendWelcome reference="chk_1" />);
    await userEvent.click(screen.getByTestId('checkout-resend-button'));
    expect(resendWelcome).toHaveBeenCalledWith('chk_1');
    expect(screen.getByTestId('checkout-resend')).toHaveTextContent(
      'Sent. Check your inbox again in a moment.',
    );
  });

  it('not sent: said', async () => {
    resendWelcome.mockResolvedValue({ sent: false });
    await show(<ResendWelcome reference="chk_1" />);
    await userEvent.click(screen.getByTestId('checkout-resend-button'));
    expect(screen.getByTestId('checkout-resend')).toHaveTextContent(
      "We couldn't send it just now.",
    );
  });
});

describe('★ the summary is billing’s, never computed', () => {
  it('priced in dollars, charged in shekels: both, and the rate as indicative', async () => {
    await show(
      <SummaryCard
        summary={summary({
          charge: { amount: '1846.30', currency: 'ILS', exchangeRate: '3.7000', settled: false },
        })}
      />,
    );
    expect(screen.getByTestId('checkout-summary')).toHaveTextContent('$499.00');
    expect(screen.getByTestId('checkout-charged')).toHaveTextContent('₪1,846.30');
    expect(screen.getByTestId('checkout-rate')).toHaveTextContent(
      'Your card is charged in shekels, at 3.7000 ILS per USD.',
    );
  });

  it('settled: the rate applied', async () => {
    await show(
      <SummaryCard
        summary={summary({
          charge: { amount: '1846.30', currency: 'ILS', exchangeRate: '3.7000', settled: true },
        })}
      />,
    );
    expect(screen.getByTestId('checkout-rate')).toHaveTextContent(
      'Converted at 3.7000 ILS per USD',
    );
  });

  it('the same currency: no second figure', async () => {
    await show(
      <SummaryCard
        summary={summary({
          currency: 'ILS',
          amount: '1800',
          charge: { amount: '1800', currency: 'ILS', exchangeRate: '1.0000', settled: false },
        })}
      />,
    );
    expect(screen.queryByTestId('checkout-charged')).toBeNull();
    expect(screen.queryByTestId('checkout-rate')).toBeNull();
  });

  it('★ a missing price is left out, never drawn as zero', async () => {
    await show(<SummaryCard summary={summary({ amount: '' })} />);
    const card = screen.getByTestId('checkout-summary');
    expect(card).not.toHaveTextContent('Recurring');
    expect(card).not.toHaveTextContent('$0');
  });

  it('the offer’s end, 24-hour, in the workspace’s zone', async () => {
    // 15:00Z on 1 November is 17:00 in Jerusalem (UTC+2 once summer time ends).
    await show(<SummaryCard summary={summary({ expiresAt: '2026-11-01T15:00:00.000Z' })} />);
    const card = screen.getByTestId('checkout-summary');
    expect(card).toHaveTextContent('Offer valid until');
    expect(card).toHaveTextContent('17:00');
    expect(card).not.toHaveTextContent(/AM|PM/);
  });
});
