import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import errors from '@/i18n/messages/en/errors.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: { errors }, namespace: namespace as 'errors' }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { TenantGateNotice } from './TenantGateNotice';

/** The lock-out notice's action goes to the checkout: not inside the app (App Store 3.1.1). */
const gate = {
  code: 'TENANT_PAYMENT_REQUIRED',
  checkoutPath: '/checkout/payment-required',
} as never;

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe("★★ the checkout action is the website's, not the app's", () => {
  it('★ the website draws it', async () => {
    render(await TenantGateNotice({ gate }));
    expect(screen.getByRole('link', { name: errors.tenantGate.action })).toHaveAttribute(
      'href',
      '/checkout/payment-required',
    );
  });

  it('★ the web /m draws it too', async () => {
    render(await TenantGateNotice({ gate, inApp: true }));
    expect(screen.getByRole('link', { name: errors.tenantGate.action })).toBeInTheDocument();
  });

  it('★★ the app: the words, and no action', async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    render(await TenantGateNotice({ gate, inApp: true }));
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(errors.tenantGate.TENANT_PAYMENT_REQUIRED.title)).toBeInTheDocument();
  });
});
