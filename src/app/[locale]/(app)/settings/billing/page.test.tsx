import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/billing.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'billing') =>
    createTranslator({ locale: 'en', messages: { billing: messages }, namespace }),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/features/billing/load-billing', () => ({
  loadBilling: async () => ({
    subscription: null,
    plans: [],
    invoices: null,
    breakdown: null,
    autoPurchase: null,
    profile: null,
    paymentMethods: null,
    credits: null,
    packages: [],
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
}));
vi.mock('@/features/billing/Credits', () => ({ CreditsSection: stub('credits') }));
vi.mock('@/features/billing/BuyCredits', () => ({ BuyCredits: stub('buy') }));
vi.mock('@/features/billing/AutoPurchase', () => ({ AutoPurchase: stub('auto-purchase') }));
vi.mock('@/features/billing/BillingProfile', () => ({
  BillingProfileSection: stub('profile'),
}));
vi.mock('@/features/billing/BillingOverlay', () => ({
  BillingOverlay: ({ kind, children }: { kind: string; children: ReactNode }) => (
    <div data-testid="overlay" data-kind={kind}>
      {children}
    </div>
  ),
}));

import Page from './page';

const open = async (panel?: string) =>
  render(await Page({ searchParams: Promise.resolve(panel ? { panel } : {}) }));

describe('★ 17 — 02’s screen, and 17c/d/e over it', () => {
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
