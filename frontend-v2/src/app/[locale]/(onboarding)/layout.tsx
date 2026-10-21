import { NextIntlClientProvider } from 'next-intl';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { signInHere } from '@/api/client/signed-out';
import { RETURN_TO_HEADER } from '@/auth/return-to';
import { activeSession } from '@/auth/session-store';
import { loadMessages } from '@/i18n/load-messages';
import { isLocale, DEFAULT_LOCALE } from '@/i18n/locales';
import { redirect as localeRedirect } from '@/i18n/navigation';
import { paymentPath, readWorkspaceGate } from '@/shell/load-workspace-gate';
import { asksForPreview } from '@/shell/workspace-gate';
import { WorkspaceGate } from '@/shell/WorkspaceGate';

/**
 * 00d-00h - onboarding, after the workspace exists (design 6). Its own shell:
 * the dark column with the five steps beside a light work surface, and none
 * of the product's rail - nothing there works for a workspace still being set
 * up. Signed in, as the app is.
 *
 * ★ `?preview=1` (Omer, 2026-10-07): a LIVE workspace's admin walks these
 *   screens read-only - the pages draw every write as a status and never
 *   finish. The layout cannot read the query, so it reads the proxy's
 *   return-to header, which carries it.
 *
 * The same gate as the product's, from the other side: only an admin of a
 * workspace being set up is here; a live workspace has nothing to set up
 * (Home); anyone else gets the gate's screen.
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
  const { route, setupAdmin, mayPreview } = await readWorkspaceGate();
  if (route === 'signed_out') redirect(await signInHere());
  const previewing =
    route === 'product' && mayPreview && asksForPreview((await headers()).get(RETURN_TO_HEADER));
  if (route === 'product' && !previewing) localeRedirect({ href: '/home', locale: resolved });
  return (
    <NextIntlClientProvider messages={await loadMessages(resolved)}>
      {route === 'onboarding' || previewing ? (
        children
      ) : route === 'product' ? null : (
        <WorkspaceGate
          route={route}
          paymentPath={route === 'payment' ? await paymentPath(resolved) : null}
          setupAdmin={setupAdmin}
        />
      )}
    </NextIntlClientProvider>
  );
}
