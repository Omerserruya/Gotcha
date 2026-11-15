import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import en from '@/i18n/messages/en/home.json';
import he from '@/i18n/messages/he/home.json';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/i18n/navigation', () => ({ Link: 'a', useRouter: () => ({}) }));

import { Problem } from './MobileAsk';

/** "No credits" on the phone (App Store 3.1.1, 2026-11-15). */
const show = (locale: 'en' | 'he') =>
  render(
    <NextIntlClientProvider locale={locale} messages={{ home: locale === 'he' ? he : en }}>
      <Problem problem={{ kind: 'credits' } as never} />
    </NextIntlClientProvider>,
  );

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('★★ no credits: the web links billing, the app says what happened and links nothing', () => {
  it('★ the web /m: the sentence and its link to billing', () => {
    show('en');
    expect(screen.getByRole('link', { name: 'Settings · Billing' })).toHaveAttribute(
      'href',
      expect.stringContaining('/en/settings/billing'),
    );
  });

  it.each(['en', 'he'] as const)(
    '★★ the app (%s): no link, and no pointer to billing',
    (locale) => {
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
      };
      show(locale);
      expect(screen.queryByRole('link')).toBeNull();
      const words = locale === 'he' ? he : en;
      expect(screen.getByRole('alert')).toHaveTextContent(words.conversation.problem.creditsApp);
      expect(screen.getByRole('alert').textContent).not.toMatch(/Billing|חיוב/);
    },
  );
});
