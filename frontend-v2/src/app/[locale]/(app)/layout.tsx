import { NextIntlClientProvider } from 'next-intl';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { signInHere } from '@/api/client/signed-out';
import { activeSession } from '@/auth/session-store';
import { loadPermissions } from '@/shell/load-permissions';
import { loadMessages } from '@/i18n/load-messages';
import { isLocale, DEFAULT_LOCALE } from '@/i18n/locales';
import { AppProviders } from '@/shell/AppProviders';
import { AppShell } from '@/shell/AppShell';
import { paymentPath, readWorkspaceGate } from '@/shell/load-workspace-gate';
import { WorkspaceGate } from '@/shell/WorkspaceGate';
import { redirect as localeRedirect } from '@/i18n/navigation';

/**
 * The authenticated area.
 *
 * Session and permissions are resolved once, here, and handed down. Two
 * consequences worth stating: the first paint already knows what the user may
 * see, so the navigation never flickers; and there is exactly one place that
 * decides the current tenant, so nothing further down can disagree about it.
 */
export default async function AuthenticatedLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  /*
   * `activeSession`, not `readSession`. The latter only unseals the cookie and
   * checks the ABSOLUTE expiry, so a session whose access token has expired
   * and whose refresh was refused still passes it - and the whole page then
   * renders around 401s, showing an empty product instead of a sign-in.
   * Everything below this line calls the platform API.
   */
  const session = await activeSession();
  if (!session) redirect(await signInHere());

  /*
    ★★ ONBOARDING IS A GATE (Omer, 2026-10-07). The workspace's status is the
    server's (`/api/auth/me`): an admin of a workspace being set up goes to
    onboarding, resumed; anyone else waits; an unpaid one goes to payment;
    unread is a Retry - never the product. ACTIVE (and anything else) is the
    product as before. No rail and no ⌘K behind the closed door.
  */
  const resolved = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const { route, setupAdmin, tenantId } = await readWorkspaceGate();
  if (route === 'signed_out') redirect(await signInHere());
  if (route === 'onboarding') localeRedirect({ href: '/onboarding', locale: resolved });
  if (route === 'waiting' || route === 'unavailable' || route === 'payment') {
    return (
      <NextIntlClientProvider messages={await loadMessages(resolved)}>
        <WorkspaceGate
          route={route}
          paymentPath={route === 'payment' ? await paymentPath(resolved) : null}
          setupAdmin={setupAdmin}
        />
      </NextIntlClientProvider>
    );
  }

  const { permissions, roleKey, status } = await loadPermissions();
  /*
    ★★ A 401 IS "SIGN IN AGAIN", NEVER A SCREEN OF "COULDN'T READ" (Omer,
    2026-10-04). Every page waits behind this layout, and its first read uses
    the same token the page's reads do - so a token the platform refuses is
    caught here, once, and the visitor goes to sign-in with the way back.
    A 403 is not this: no permission is not signed out.
  */
  if (status === 'signed_out') redirect(await signInHere());

  /*
   * ★★ THE FULL CATALOGUE, AND ONLY BEHIND THE SESSION CHECK ABOVE.
   * The locale layout now provides only what the error boundary needs, so the
   * product's vocabulary is attached here - inside the authenticated area -
   * rather than to every page in the app including sign-in.
   */
  return (
    <NextIntlClientProvider messages={await loadMessages(resolved)}>
      <AppProviders
        locale={locale}
        tenantId={session.tid ?? tenantId}
        permissions={permissions}
        roleKey={roleKey}
        permissionsStatus={status}
      >
        <AppShell>{children}</AppShell>
      </AppProviders>
    </NextIntlClientProvider>
  );
}
