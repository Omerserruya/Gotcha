import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/checkout.json';

/* The action is a spy: nothing here reaches billing. */
const openCheckout = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ openCheckout }));
const replace = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ replace }) }));

import { CheckoutOpen } from './CheckoutOpen';

const show = async (node: ReactNode) => {
  render(
    <NextIntlClientProvider locale="en" timeZone="Asia/Jerusalem" messages={{ checkout: messages }}>
      {node}
    </NextIntlClientProvider>,
  );
  await act(async () => {});
};

beforeEach(() => {
  openCheckout.mockReset();
  replace.mockReset();
});

describe('★★ the emailed link', () => {
  beforeEach(() => window.history.replaceState(null, '', '/en/checkout?ref=chk_1&token=tok_123'));

  it('★ the token leaves the address bar, the reference stays', async () => {
    openCheckout.mockReturnValue(new Promise(() => {}));
    await show(<CheckoutOpen reference="chk_1" token="tok_123" />);
    expect(window.location.search).toBe('?ref=chk_1');
    expect(screen.getByTestId('checkout-opening')).toHaveTextContent('Opening your payment');
  });

  it('opened: to the page billing names, with only the reference', async () => {
    openCheckout.mockResolvedValue({ ok: true, page: 'processing' });
    await show(<CheckoutOpen reference="chk_1" token="tok_123" />);
    expect(openCheckout).toHaveBeenCalledWith('chk_1', 'tok_123');
    expect(replace).toHaveBeenCalledWith({
      pathname: '/checkout/processing',
      query: { ref: 'chk_1' },
    });
  });

  it('refused: the uniform unavailable state', async () => {
    openCheckout.mockResolvedValue({ ok: false });
    await show(<CheckoutOpen reference="chk_1" token="tok_bad" />);
    expect(screen.getByTestId('checkout-unavailable')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
