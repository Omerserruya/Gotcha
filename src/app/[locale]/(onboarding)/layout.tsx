import { NextIntlClientProvider } from 'next-intl';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { signInHere } from '@/api/client/signed-out';
import { activeSession } from '@/auth/session-store';
import { loadMessages } from '@/i18n/load-messages';
import { isLocale, DEFAULT_LOCALE } from '@/i18n/locales';
import { redirect as localeRedirect } from '@/i18n/navigation';
import { paymentPath, readWorkspaceGate } from '@/shell/load-workspace-gate';
import { WorkspaceGate } from '@/shell/WorkspaceGate';

/**
 * 00d-00h - onboarding, after the workspace exists (design 6). Its own shell:
 * the dark column with the five steps beside a light work surface, and none
 * of the product's rail - nothing there works for a workspace still being set
 * up. Signed in, as the app is.
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
  const { route, setupAdmin } = await readWorkspaceGate();
  if (route === 'signed_out') redirect(await signInHere());
  if (route === 'product') localeRedirect({ href: '/home', locale: resolved });
  return (
    <NextIntlClientProvider messages={await loadMessages(resolved)}>
      {route === 'onboarding' ? (
        children
      ) : route === 'product' ? null : (
        <WorkspaceGate
          route={route}
          paymentPath={route === 'payment' ? await paymentPath() : null}
          setupAdmin={setupAdmin}
        />
      )}
    </NextIntlClientProvider>
  );
}
