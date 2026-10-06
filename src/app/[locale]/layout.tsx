import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '@/design-system/styles/global.css';

import { fontVariables } from '@/design-system/tokens/fonts';
import { directionOf, LOCALE_CODES } from '@/i18n/locales';
import { loadMessages } from '@/i18n/load-messages';
import { SHELL_NAMESPACES } from '@/i18n/namespaces';
import { routing } from '@/i18n/routing';

export function generateStaticParams() {
  return LOCALE_CODES.map((locale) => ({ locale }));
}

/**
 * Document metadata.
 *
 * `title.template` puts the page first and the product second, because that is
 * the order that helps: with a dozen GOTCHA tabs open, the tab strip truncates
 * from the end, and a row of tabs all reading "GOTCHA · …" is unusable.
 *
 * `title.default` covers routes that set no title of their own.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'common' });

  return {
    title: {
      template: '%s · GOTCHA',
      default: 'GOTCHA',
    },
    description: t('productDescription'),
    applicationName: 'GOTCHA',
    robots: { index: false, follow: false },
  };
}

/**
 * Browser chrome.
 *
 * `themeColor` belongs to the viewport export, not to metadata - Next warns on
 * every page otherwise, and the value is silently ignored.
 *
 * The tab strip and mobile browser chrome take the frame's own ink, so the
 * browser furniture continues the product rather than framing it.
 */
export const viewport: Viewport = {
  themeColor: '#121212',
};

/**
 * The document.
 *
 * `lang` and `dir` are set here, from locale metadata, and this is the only
 * place either is decided. Every logical property in the stylesheets resolves
 * against `dir`, which is what makes Hebrew a real right-to-left layout rather
 * than a mirrored left-to-right one.
 *
 * There is no theme bootstrap script. The design is one committed direction -
 * a dark frame around a warm work surface - not a light theme with a dark
 * twin, so there is no stored preference to apply before first paint.
 */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  // Lets the rest of the tree be statically rendered where possible.
  setRequestLocale(locale);

  return (
    <html lang={locale} dir={directionOf(locale)} className={fontVariables}>
      <body>
        {/*
          ════════════════════════════════════════════════════════════════════
          ★★ SCOPED, BECAUSE THIS PROVIDER SERIALISES WHAT IT IS GIVEN
          ════════════════════════════════════════════════════════════════════
          With no `messages` prop it hands the client EVERY namespace in the
          request config. Measured on the deployed sign-in page: 143,757 bytes
          and 1,097 message-shaped strings - "Approvals", "Studio",
          "conversation" x121, "refund" x20 - the product's entire vocabulary,
          on a page nobody has authenticated to reach.

          What survives here is only what the route error boundary needs, since
          `error.tsx` is a client component living above both route groups.
          Each group then provides its own: `(auth)` the panel's namespace,
          `(app)` the product's.

          ★ A gateway allowlist cannot fix this. It governs which routes
            answer; this was not another route, it was this route's payload.
        */}
        <NextIntlClientProvider messages={await loadMessages(locale, SHELL_NAMESPACES)}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
