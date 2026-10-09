'use client';

import type { ReactNode } from 'react';

import { TooltipProvider } from '@/design-system/primitives/overlay/Tooltip';
import { DirectionProvider } from '@/i18n/direction-context';
import { PermissionsProvider, type PermissionsStatus } from '@/permissions/permissions-context';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import { QueryProvider } from '@/server-state/query-provider';
import { TenantProvider } from '@/tenant/tenant-context';

import { ScrollFades } from './ScrollFades';
import { SessionExpiryWatcher } from './SessionExpiryWatcher';

/**
 * Every client-side provider, composed once, in a deliberate order.
 *
 * Direction is outermost because the primitives inside it need to know it
 * before they render. Tenant precedes the query cache and realtime, both of
 * which are scoped by it. Permissions precede the shell, which uses them to
 * decide what navigation exists.
 *
 * Values come from the server as props rather than being fetched here, so the
 * first render is already correct - no flash of an empty sidebar while
 * permissions load.
 */
export function AppProviders({
  locale,
  tenantId,
  permissions,
  roleKey,
  permissionsStatus,
  children,
}: {
  locale: string;
  tenantId: string | null;
  permissions: readonly string[];
  roleKey?: string;
  permissionsStatus?: PermissionsStatus;
  children: ReactNode;
}) {
  return (
    <DirectionProvider locale={locale}>
      <TenantProvider tenantId={tenantId}>
        <QueryProvider tenantId={tenantId}>
          <PermissionsProvider
            permissions={permissions}
            roleKey={roleKey}
            status={permissionsStatus}
            tenantId={tenantId}
          >
            <RealtimeProvider tenantId={tenantId}>
              <TooltipProvider delayDuration={400} skipDelayDuration={200}>
                <SessionExpiryWatcher />
                <ScrollFades />
                {children}
              </TooltipProvider>
            </RealtimeProvider>
          </PermissionsProvider>
        </QueryProvider>
      </TenantProvider>
    </DirectionProvider>
  );
}
