import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { subscriptionSchema } from '@/api/contracts/billing';
import { paymentMethodSchema } from '@/api/contracts/billing-profile';
import { catalogPlans } from '@/api/contracts/pricing';
import messages from '@/i18n/messages/en/billing.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'billing.choice') =>
    createTranslator({ locale: 'en', messages: { billing: messages }, namespace }),
  getLocale: async () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children: ReactNode;
    scroll?: boolean;
  }) => (
    <a
      href={
        typeof href === 'string'
          ? href
          : `${href.pathname}${href.query ? `?${new URLSearchParams(href.query)}` : ''}`
      }
      {...rest}
    >
      {children}
    </a>
  ),
}));

import { PlanCards, SwitchActions, SwitchSummary } from './PlanChoice';

const plan = (
  key: string,
  name: string,
  amount: string,
  credits: number,
  chats: number,
  basis: 'CREDIT_RATIO' | 'DECLARED_VOLUME' = 'CREDIT_RATIO',
) => ({
  key,
  name,
  billingInterval: 'MONTHLY',
  basePrice: { display: { amount, currency: 'USD', formatted: `$${amount}` } },
  includedCredits: credits,
  features: [
    { key: 'a', nameEn: 'One AI employee', included: true },
    { key: 'b', nameEn: 'Phone calls', included: false },
  ],
  estimate: { chat: { monthly: chats, basis } },
});

/** The catalog this tenant is offered, as `/billing/pricing` sends it. */
const CATALOG = catalogPlans([
  plan('foundation', 'Foundation', '39.00', 750, 94),
  plan('ai_workforce', 'AI Workforce', '97.00', 2000, 250, 'DECLARED_VOLUME'),
  plan('ai_voice', 'AI Voice', '1499.00', 7000, 875),
  { key: 'broken' }, // one plan the contract cannot read costs only its card
]);

const SUB = subscriptionSchema.parse({
  planKey: 'ai_voice',
  status: 'ACTIVE',
  currentPeriodEnd: '2027-09-08T14:19:24.353Z',
});

describe('★ 17b — the plans on offer, side by side', () => {
  it('reads the catalog plan by plan', () => {
    expect(CATALOG.map((p) => p.key)).toEqual(['foundation', 'ai_workforce', 'ai_voice']);
  });

  it('yours is the dark card and not a link; the picked one is selected', async () => {
    render(
      await PlanCards({ catalog: CATALOG, currentKey: 'ai_voice', selectedKey: 'foundation' }),
    );
    const mine = screen.getByTestId('plan-card-ai_voice');
    expect(mine).toHaveAttribute('data-kind', 'current');
    expect(mine.tagName).not.toBe('A');
    expect(mine).toHaveTextContent('Your plan');
    const picked = screen.getByTestId('plan-card-foundation');
    expect(picked).toHaveAttribute('data-kind', 'selected');
    expect(picked).toHaveTextContent('Selected');
    expect(screen.getByTestId('plan-card-ai_workforce')).toHaveAttribute(
      'href',
      '/settings/billing/plan?plan=ai_workforce',
    );
  });

  it('a card is price / month, credits and conversations, and only included features', async () => {
    render(await PlanCards({ catalog: CATALOG, currentKey: 'ai_voice', selectedKey: null }));
    const card = screen.getByTestId('plan-card-foundation');
    expect(card).toHaveTextContent('$39/ month');
    expect(card).toHaveTextContent('750 credits · ≈ 94 conversations');
    expect(card).toHaveTextContent('One AI employee');
    expect(card).not.toHaveTextContent('Phone calls');
  });
});

describe('★ 17b — what happens if you switch today', () => {
  const [foundation, , voice] = CATALOG;

  it('moving down costs nothing now and lands at renewal', async () => {
    render(await SwitchSummary({ target: foundation!, current: voice!, subscription: SUB }));
    expect(screen.getByTestId('switch-summary')).toHaveAttribute('data-direction', 'down');
    expect(screen.getByTestId('switch-charged')).toHaveTextContent('Nothing');
    expect(screen.getByTestId('switch-from')).toHaveTextContent(
      'From September 8, 2027$39 a month750 credits each cycle',
    );
  });

  it('moving up: the charge is the server’s to work out, so "—" — never a guess', async () => {
    render(await SwitchSummary({ target: voice!, current: foundation!, subscription: SUB }));
    const charged = screen.getByTestId('switch-charged');
    expect(charged).toHaveTextContent('Charged now—');
    expect(screen.getByTestId('switch-credits')).toHaveTextContent('+ 6,250');
  });

  it('nothing picked asks for a pick', async () => {
    render(await SwitchSummary({ target: null, current: voice!, subscription: SUB }));
    expect(screen.getByTestId('switch-summary')).toHaveTextContent('Pick a plan');
  });
});

describe('★ 17b — the switch is drawn, and not live', () => {
  it('names the plan, is not a button, and names the card it would charge', async () => {
    const [foundation, , voice] = CATALOG;
    render(
      await SwitchActions({
        target: foundation!,
        current: voice!,
        methods: [paymentMethodSchema.parse({ id: 'pm', brand: 'Visa', last4: '4417' })],
      }),
    );
    const button = screen.getByTestId('switch-button');
    expect(button).toHaveTextContent('Switch to Foundation');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button.closest('a,button')).toBeNull();
    expect(screen.getByTestId('switch-keep')).toHaveTextContent('Keep AI Voice');
    expect(screen.getByTestId('switch-fine')).toHaveTextContent('Charged to Visa · 4417.');
  });

  it('an unread payment method claims no card and no absence', async () => {
    render(await SwitchActions({ target: null, current: null, methods: null }));
    expect(screen.getByTestId('switch-fine')).not.toHaveTextContent(/Charged to|No payment/);
  });
});

describe('★ 17b — conversations beside credits only when they come FROM the credits', () => {
  it('the default sold volume (250 on every plan) is not drawn as what the credits buy', async () => {
    render(await PlanCards({ catalog: CATALOG, currentKey: 'ai_voice', selectedKey: null }));
    const card = screen.getByTestId('plan-card-ai_workforce');
    expect(card).toHaveTextContent('2,000 credits');
    expect(card).not.toHaveTextContent(/conversations/);
  });
});
