import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import enBilling from '@/i18n/messages/en/billing.json';
import heBilling from '@/i18n/messages/he/billing.json';
import enNavigation from '@/i18n/messages/en/navigation.json';
import heNavigation from '@/i18n/messages/he/navigation.json';

const lang = vi.hoisted(() => ({ locale: 'en' as 'en' | 'he' }));
const MESSAGES = {
  en: { billing: enBilling, navigation: enNavigation },
  he: { billing: heBilling, navigation: heNavigation },
};
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: lang.locale,
      messages: MESSAGES[lang.locale] as never,
      namespace: namespace as never,
    }),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h1 data-testid="title">{title}</h1>
      {children}
    </section>
  ),
}));
vi.mock('@/shell/page-metadata', () => ({ pageMetadata: () => () => ({}) }));
vi.mock('@/features/billing/load-pricing', () => ({
  loadPricing: async () => ({
    subscription: null,
    currency: null,
    tax: null,
    disclaimer: null,
    paymentMethods: null,
    catalog: [],
  }),
}));
vi.mock('@/api/client/server-api', () => ({
  serverApi: () => ({ get: async () => ({ plans: [] }) }),
}));
const stub = vi.hoisted(() => (id: string) => {
  const Stub = () => <div data-testid={id} />;
  Stub.displayName = id;
  return Stub;
});
vi.mock('@/features/billing/PlanChoice', () => ({
  PlanCards: stub('cards'),
  SwitchActions: stub('actions'),
  SwitchSummary: stub('summary'),
}));
vi.mock('@/features/billing/Pricing', () => ({ CurrentPlanSection: stub('current') }));
vi.mock('@/features/billing/ChangePlanGate', () => ({ ChangePlanGate: stub('gate') }));

describe.each([
  [
    'en',
    'Change GOTCHA Core plan',
    'This changes GOTCHA Core only. It does not include the Shopify Connector.',
  ],
  [
    'he',
    'שינוי תוכנית GOTCHA Core',
    'השינוי הזה חל על GOTCHA Core בלבד. הוא לא כולל את Shopify Connector.',
  ],
] as const)(
  '★★ 17b is "Change GOTCHA Core plan", Core only (132211) - %s',
  (locale, title, sentence) => {
    it('the title, and the Core-only sentence before the plans', async () => {
      lang.locale = locale;
      const { default: Page } = await import('./page');
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.getByTestId('title')).toHaveTextContent(new RegExp(`^${title}$`));
      const line = screen.getByTestId('core-only');
      expect(line).toHaveTextContent(new RegExp(`^${sentence.replace(/\./g, '\\.')}$`));
      expect(
        line.compareDocumentPosition(screen.getByTestId('cards')) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  },
);
