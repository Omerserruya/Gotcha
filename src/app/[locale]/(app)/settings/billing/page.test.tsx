import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/billing.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'billing') =>
    createTranslator({ locale: 'en', messages: { billing: messages }, namespace }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ children, fill }: { children: ReactNode; fill?: boolean }) => (
    <div data-testid="settings-section" data-fill={fill ? 'yes' : 'no'}>
      {children}
    </div>
  ),
}));
/* The billing record, per test: none unless one says otherwise. */
const billing = vi.hoisted(() => ({ profile: null as unknown }));
vi.mock('@/features/billing/load-billing', () => ({
  loadBilling: async () => ({
    subscription: null,
    plans: [],
    invoices: null,
    breakdown: null,
    autoPurchase: null,
    profile: billing.profile,
    paymentMethods: null,
    credits: null,
    // A failed read - the shape `loadBilling` returns for one: null, not [].
    packages: null,
  }),
}));
const { stub } = vi.hoisted(() => ({
  stub: (id: string) => () => <div data-testid={id} />,
}));
vi.mock('@/features/billing/Overview', () => ({
  PlanHero: stub('hero'),
  CreditsWent: stub('went'),
  RunningLow: stub('low'),
  BillingCard: stub('billing'),
  CycleValue: stub('value'),
  BuyUnavailable: stub('buy-unavailable'),
}));
vi.mock('@/features/billing/Credits', () => ({ CreditsSection: stub('credits') }));
/* What the page hands the dialog: the charge only when writes are on. */
const writes = vi.hoisted(() => ({ on: false }));
vi.mock('@/api/client/billing-writes', () => ({ billingWritesEnabled: () => writes.on }));
vi.mock('@/features/billing/actions', () => ({ buyCreditPack: async () => ({ ok: true }) }));
vi.mock('@/features/billing/BuyCredits', () => ({
  BuyCredits: ({ charge }: { charge: unknown }) => (
    <div data-testid="buy" data-charge={charge ? 'yes' : 'no'} />
  ),
}));
vi.mock('@/features/billing/Pricing', () => ({ CreditPackagesSection: stub('packages-why') }));
vi.mock('@/features/billing/AutoPurchase', () => ({ AutoPurchase: stub('auto-purchase') }));
vi.mock('@/features/billing/BillingProfile', () => ({
  BillingProfileSection: stub('profile'),
}));
vi.mock('@/features/billing/BillingOverlay', () => ({
  BillingOverlay: ({
    kind,
    children,
    footer,
  }: {
    kind: string;
    children: ReactNode;
    footer?: ReactNode;
  }) => (
    <div data-testid="overlay" data-kind={kind}>
      {children}
      {footer}
    </div>
  ),
}));

import Page from './page';

const open = async (panel?: string) =>
  render(await Page({ searchParams: Promise.resolve(panel ? { panel } : {}) }));

describe('★ 17 - 02’s screen, and 17c/d/e over it', () => {
  it('17 alone: the hero, both columns, no overlay', async () => {
    await open();
    for (const id of ['hero', 'credits', 'went', 'low', 'billing', 'value']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('overlay')).toBeNull();
    expect(screen.queryByTestId('buy')).toBeNull();
  });

  it.each([
    ['buy', 'dialog', 'buy'],
    ['low', 'drawer', 'auto-purchase'],
    ['details', 'drawer', 'profile'],
  ])('?panel=%s opens a %s holding %s, over 17', async (panel, kind, inside) => {
    await open(panel);
    expect(screen.getByTestId('overlay')).toHaveAttribute('data-kind', kind);
    expect(screen.getByTestId(inside)).toBeInTheDocument();
    expect(screen.getByTestId('hero')).toBeInTheDocument();
  });
});

describe('★ 17 - the left column runs to the frame’s bottom', () => {
  it('the section fills', async () => {
    await open();
    expect(screen.getByTestId('settings-section')).toHaveAttribute('data-fill', 'yes');
  });
});

describe('★ 17d - nothing to buy says why, rather than a blank dialog', () => {
  it('a failed packages read draws the dialog’s shape, not the shelf’s reasons', async () => {
    await open('buy');
    expect(screen.getByTestId('buy-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('packages-why')).toBeNull();
  });
});

describe('★★ 17e Save - live where there is a record to save into', () => {
  it('a record: Save is a submit button for the details form', async () => {
    billing.profile = { billingName: 'Aviv', state: 'present' };
    await open('details');
    const save = screen.getByTestId('details-save');
    expect(save.tagName).toBe('BUTTON');
    expect(save).toHaveAttribute('type', 'submit');
    expect(save).toHaveAttribute('form', 'billing-profile-form');
    billing.profile = null;
  });

  it('no record yet: Save is a status that says why - never a button that 409s', async () => {
    billing.profile = { state: 'no_billing_profile' };
    await open('details');
    const save = screen.getByTestId('details-save');
    expect(save.tagName).toBe('SPAN');
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveAttribute(
      'title',
      "There's no billing record to save these to yet - one is made when a card is added.",
    );
    billing.profile = null;
  });
});

describe('★★ the purchase reaches the dialog only where billing writes are on', () => {
  it('off (dev): no charge handed in; on: the action', async () => {
    writes.on = false;
    const one = await open('buy');
    expect(screen.getByTestId('buy')).toHaveAttribute('data-charge', 'no');
    one.unmount();
    writes.on = true;
    await open('buy');
    expect(screen.getByTestId('buy')).toHaveAttribute('data-charge', 'yes');
    writes.on = false;
  });
});

describe('★ 17c Save opens the auto-purchase confirm (held inside the form)', () => {
  it('a submit button for the form - not a dead span', async () => {
    await open('low');
    const save = screen.getByTestId('low-save');
    expect(save.tagName).toBe('BUTTON');
    expect(save).toHaveAttribute('form', 'auto-purchase-form');
  });
});
