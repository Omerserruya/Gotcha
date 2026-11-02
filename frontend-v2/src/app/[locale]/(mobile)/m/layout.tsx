import { NextIntlClientProvider } from 'next-intl';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { signInHere } from '@/api/client/signed-out';
import { RETURN_TO_HEADER } from '@/auth/return-to';
import { activeSession } from '@/auth/session-store';
import { loadPermissions } from '@/shell/load-permissions';
import { loadMessages } from '@/i18n/load-messages';
import { isLocale, DEFAULT_LOCALE } from '@/i18n/locales';
import { AppProviders } from '@/shell/AppProviders';
import { MobileShell } from '@/shell/mobile/MobileShell';
import { paymentPath, readWorkspaceGate } from '@/shell/load-workspace-gate';
import { WorkspaceGate } from '@/shell/WorkspaceGate';
import { WithSupportBanner } from '@/features/support/SupportBanner';
import { loadSupport } from '@/support/load-support';
import { SupportProvider } from '@/support/support-context';
import { isConsolePath } from '@/shell/workspace-gate';
import { redirect as localeRedirect } from '@/i18n/navigation';

/**
 * The mobile app's authenticated area: `/<locale>/m/*`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE SAME CHAIN AS `(app)/layout.tsx`, WITH ONE DIFFERENCE: THE FRAME
 * ════════════════════════════════════════════════════════════════════════════
 * Session, workspace gate, support banner and permissions are decided exactly
 * as on the desktop, because a second door that skipped any of them would let
 * an admin act in a customer's workspace without the banner, or show the
 * product behind an unpaid gate. Only the frame differs: a phone has no room
 * for the rail, so `MobileShell` draws a top bar and four tabs instead.
 *
 * Kept as a copy rather than a shared function so the desktop layout, which
 * another team owns, is not touched. A change to one should be read against
 * the other.
 *
 * What follows is the desktop layout's own account of that chain.
 *
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
  const { route, setupAdmin, tenantId, consoleOnly } = await readWorkspaceGate();
  if (route === 'signed_out') redirect(await signInHere());
  if (route === 'onboarding') localeRedirect({ href: '/onboarding', locale: resolved });
  /*
    ★★ A system admin whose own tenant is not live (prod's "System"
    placeholder, 2026-10-23) works in the console only: that tenant has no
    plan, so its product pages are 402s. Every other path goes to /system.
    No header (never on a page the proxy served) is left alone rather than
    risk a loop.
  */
  const at = consoleOnly ? (await headers()).get(RETURN_TO_HEADER) : null;
  if (at !== null && !isConsolePath(at)) localeRedirect({ href: '/system', locale: resolved });
  /*
    ★★ SUPPORT MODE, said on every page this layout draws - the gate's
    screens and the console's included (Omer, 2026-11-01).
  */
  const support = await loadSupport();
  if (route === 'waiting' || route === 'unavailable' || route === 'payment') {
    return (
      <NextIntlClientProvider messages={await loadMessages(resolved)}>
        <SupportProvider session={support}>
          <WithSupportBanner>
            <WorkspaceGate
              route={route}
              paymentPath={route === 'payment' ? await paymentPath(resolved) : null}
              setupAdmin={setupAdmin}
            />
          </WithSupportBanner>
        </SupportProvider>
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
        support={support}
      >
        <WithSupportBanner>
          <MobileShell>{children}</MobileShell>
        </WithSupportBanner>
      </AppProviders>
    </NextIntlClientProvider>
  );
}
