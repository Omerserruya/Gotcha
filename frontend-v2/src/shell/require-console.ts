import 'server-only';

import { notFound } from 'next/navigation';

import { isSystemAdminRole } from '@/permissions/permission-set';
import { loadPermissions } from './load-permissions';

/**
 * The console's door: SYSTEM_ADMIN, or "not found".
 *
 * Not the product's usual "unread gates nothing" (`permissions-context.tsx`):
 * every other page is a tenant's own, where a refused control costs a click.
 * This one lists every tenant on the platform, so an unread role - the
 * permissions read failed - is a closed door too, and a person who is not an
 * operator learns nothing, not even that the page exists. The backend refuses
 * every call behind it anyway (`requireSystemAdmin`, auth system.ts).
 *
 * Called by the layout AND by each page: they render in parallel, and a page
 * must not start reading the platform's tenants for someone the layout is
 * about to turn away. One read per request (`loadPermissions` is cached).
 */
export async function requireConsole(): Promise<void> {
  const { roleKey } = await loadPermissions();
  if (!isSystemAdminRole(roleKey)) notFound();
}
