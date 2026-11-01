import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import { loadMessages } from '@/i18n/load-messages';
import { DEFAULT_LOCALE, isLocale } from '@/i18n/locales';
import { CHECKOUT_NAMESPACES } from '@/i18n/namespaces';
import { WithSupportBanner } from '@/features/support/SupportBanner';
import { loadSupport } from '@/support/load-support';
import { SupportProvider } from '@/support/support-context';

/**
 * The customer checkout: where billing's emails and the provider's return
 * URLs land (`/checkout?ref=&token=`, `/checkout/{processing,failed,cancelled}`),
 * and where the product's payment gate sends an unpaid workspace.
 *
 * ★ NOT SIGNED IN BY REQUIREMENT. Someone paying from an emailed link may
 *   never have signed in; a member coming from the gate is. Billing decides
 *   who may read a checkout (the token or membership), so this layout asks
 *   for no session - the proxy lets `/checkout` through signed out (fe/public)
 *   - and hands the browser only the checkout's own copy.
 */
export default async function CheckoutLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const resolved = isLocale(locale) ? locale : DEFAULT_LOCALE;
  /*
   * ★ SUPPORT MODE IS SAID HERE TOO, and pays nothing: the banner, and every
   *   payment control refused (the platform refuses `/api/checkout` writes,
   *   `support_denied:billing`). Signed out there is no support session, and
   *   the checkout's copy alone, as before.
   */
  const support = await loadSupport();
  const namespaces = support ? [...CHECKOUT_NAMESPACES, 'console' as const] : CHECKOUT_NAMESPACES;
  return (
    <NextIntlClientProvider messages={await loadMessages(resolved, namespaces)}>
      <SupportProvider session={support}>
        <WithSupportBanner>{children}</WithSupportBanner>
      </SupportProvider>
    </NextIntlClientProvider>
  );
}
