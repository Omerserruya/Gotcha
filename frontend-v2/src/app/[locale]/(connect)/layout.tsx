import { NextIntlClientProvider } from 'next-intl';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { signInHere } from '@/api/client/signed-out';
import { activeSession } from '@/auth/session-store';
import { loadMessages } from '@/i18n/load-messages';
import { DEFAULT_LOCALE, isLocale } from '@/i18n/locales';

/**
 * Pages another product opens in GOTCHA and gets back from - today the
 * WooCommerce plugin's "Connect to GOTCHA" (woocommerce-plugin-v1 §2). Signed
 * in, as the app is, and without its rail: the visitor came from WordPress
 * for one thing, and goes back there when it is done.
 */
export default async function ConnectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // Signed out: sign in, and back here with the whole query (the proxy keeps it).
  if (!(await activeSession())) redirect(await signInHere());
  const resolved = isLocale(locale) ? locale : DEFAULT_LOCALE;
  return (
    <NextIntlClientProvider messages={await loadMessages(resolved)}>
      {children}
    </NextIntlClientProvider>
  );
}
