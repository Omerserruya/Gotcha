import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import common from '@/i18n/messages/en/common.json';
import onboardingMessages from '@/i18n/messages/en/onboarding.json';

import { WorkspaceGate } from './WorkspaceGate';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const show = (setupAdmin: string | null) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingMessages }}>
      <WorkspaceGate route="waiting" setupAdmin={setupAdmin} />
    </NextIntlClientProvider>,
  );

describe('★ the waiting screen names who is setting it up - when the server does', () => {
  it('named', () => {
    show('Maya Levi');
    expect(screen.getByTestId('gate-lead')).toHaveTextContent('Maya Levi is setting up GOTCHA');
  });

  it('not named: the sentence without a name - never a made-up one', () => {
    show(null);
    expect(screen.getByTestId('gate-lead')).toHaveTextContent('An admin is setting up GOTCHA');
  });
});

describe('★★ the payment gate inside the app: no way to the checkout (App Store 3.1.1)', () => {
  const pay = (inApp: boolean) =>
    render(
      <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingMessages }}>
        <WorkspaceGate
          route="payment"
          paymentPath="/en/checkout/payment-required?ref=x"
          inApp={inApp}
        />
      </NextIntlClientProvider>,
    );
  const replace = vi.fn();
  const native = () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
  };

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    replace.mockReset();
    vi.unstubAllGlobals();
  });

  const stubLocation = () =>
    vi.stubGlobal('location', { ...window.location, replace } as unknown as Location);

  it('★★ /m in the app: no Pay, no redirect, and the lead does not promise one', () => {
    native();
    stubLocation();
    pay(true);
    expect(screen.queryByTestId('gate-pay')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId('gate-lead')).toHaveTextContent(
      onboardingMessages.gate.payment.leadApp,
    );
    expect(screen.getByTestId('gate-lead')).not.toHaveTextContent('Taking you to payment');
  });

  it('★ the web /m: Pay, and the redirect', () => {
    stubLocation();
    pay(true);
    expect(screen.getByTestId('gate-pay')).toHaveAttribute(
      'href',
      '/en/checkout/payment-required?ref=x',
    );
    expect(replace).toHaveBeenCalledWith('/en/checkout/payment-required?ref=x');
  });

  it('★ the website is untouched, whatever the platform reports', () => {
    native();
    stubLocation();
    pay(false);
    expect(screen.getByTestId('gate-pay')).toBeInTheDocument();
    expect(replace).toHaveBeenCalled();
  });
});

describe('★★ unread: Try again is a person’s, and rests after each try (prod, 2026-11-16)', () => {
  it('a press re-renders on the server once; it never reloads the page', () => {
    router.refresh.mockReset();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    try {
      render(
        <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingMessages, common }}>
          <WorkspaceGate route="unavailable" />
        </NextIntlClientProvider>,
      );
      const retry = screen.getByTestId('gate-retry');
      expect(retry).toHaveTextContent('Try again');
      expect(router.refresh).not.toHaveBeenCalled();
      fireEvent.click(retry);
      expect(router.refresh).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      expect(retry).toBeDisabled();
      expect(retry).toHaveTextContent('Try again in 5s');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
