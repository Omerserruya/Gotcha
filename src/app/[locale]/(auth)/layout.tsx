import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import { loadMessages } from '@/i18n/load-messages';
import { CREDENTIAL_SURFACE_NAMESPACES } from '@/i18n/namespaces';
import { isLocale, DEFAULT_LOCALE } from '@/i18n/locales';

/**
 * The pre-authentication surface.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ IT EXISTS TO BOUND WHAT THIS PAGE SENDS TO A STRANGER
 * ════════════════════════════════════════════════════════════════════════════
 * Everything else about sign-in already worked without a layout here. What did
 * not work is that the page shipped the product's whole translation catalogue
 * - feature names, queue warnings, refund copy - to anyone who opened it.
 *
 * `NextIntlClientProvider` serialises whatever it is handed, so the fix is to
 * hand it less. `CREDENTIAL_SURFACE_NAMESPACES` is the measured set: the
 * namespaces the auth components actually ask for, asserted against their call
 * sites rather than trusted.
 *
 * ★ This matters more, not less, once sign-in is served from its own origin.
 *   Moving a page that carries the product to an origin meant to exclude the
 *   product gets the address right and the contents wrong.
 */
export default async function CredentialSurfaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const resolved = isLocale(locale) ? locale : DEFAULT_LOCALE;

  return (
    <NextIntlClientProvider messages={await loadMessages(resolved, CREDENTIAL_SURFACE_NAMESPACES)}>
      {children}
    </NextIntlClientProvider>
  );
}
