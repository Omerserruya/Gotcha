import { NextIntlClientProvider } from 'next-intl';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { permissionEndpoints } from '@/api/endpoints/registry';
import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { effectivePermissionsSchema } from '@/api/contracts/identity';
import { signInHere } from '@/api/client/signed-out';
import { activeSession } from '@/auth/session-store';
import { logger } from '@/observability/logger';
import type { PermissionsStatus } from '@/permissions/permissions-context';
import { loadMessages } from '@/i18n/load-messages';
import { isLocale, DEFAULT_LOCALE } from '@/i18n/locales';
import { AppProviders } from '@/shell/AppProviders';
import { AppShell } from '@/shell/AppShell';

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
  const resolved = isLocale(locale) ? locale : DEFAULT_LOCALE;

  return (
    <NextIntlClientProvider messages={await loadMessages(resolved)}>
      <AppProviders
        locale={locale}
        tenantId={session.tid ?? null}
        permissions={permissions}
        roleKey={roleKey}
        permissionsStatus={status}
      >
        <AppShell>{children}</AppShell>
      </AppProviders>
    </NextIntlClientProvider>
  );
}

/**
 * Fetches the caller's effective permissions.
 *
 * A failure does NOT degrade to an empty set. With exact matching an empty set
 * hides every gated destination, which is indistinguishable from having had
 * access revoked - an operator would be left staring at a product with no
 * navigation and no explanation.
 *
 * Instead the status is `unavailable` and the interface stops gating. The
 * backend remains the security authority, so nothing is actually granted; the
 * worst case is a control that turns out to be refused, with an error that
 * says so.
 */
async function loadPermissions(): Promise<{
  permissions: readonly string[];
  roleKey?: string;
  status: PermissionsStatus | 'signed_out';
}> {
  try {
    const result = await serverApi().get({
      endpoint: permissionEndpoints.mine(),
      payload: effectivePermissionsSchema,
    });
    return {
      // `features` is the legacy list; it is only a fallback for a tenant the
      // canonical set has not been migrated for.
      permissions: result.permissions.length > 0 ? result.permissions : result.features,
      roleKey: result.roleKey,
      status: 'loaded',
    };
  } catch (cause) {
    if (isApiError(cause) && cause.status === 401) return { permissions: [], status: 'signed_out' };
    logger.warn('permissions.load_failed', { cause });
    // Not an empty set. An empty set means "you hold nothing" and would hide
    // the entire product; `unavailable` means "we could not find out", and the
    // interface stops gating rather than pretending to know.
    return { permissions: [], status: 'unavailable' };
  }
}
