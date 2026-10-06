import { NextIntlClientProvider } from 'next-intl';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { signInHere } from '@/api/client/signed-out';
import { activeSession } from '@/auth/session-store';
import { loadMessages } from '@/i18n/load-messages';
import { isLocale, DEFAULT_LOCALE } from '@/i18n/locales';

/**
 * 00d-00h - onboarding, after the workspace exists (design 6). Its own shell:
 * the dark column with the five steps beside a light work surface, and none
 * of the product's rail - nothing there works for a workspace still being set
 * up. Signed in, as the app is.
 */
export default async function OnboardingLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await activeSession();
  if (!session) redirect(await signInHere());
  const resolved = isLocale(locale) ? locale : DEFAULT_LOCALE;
  return (
    <NextIntlClientProvider messages={await loadMessages(resolved)}>
      {children}
    </NextIntlClientProvider>
  );
}
