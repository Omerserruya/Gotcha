import 'server-only';

import { notFound } from 'next/navigation';

import { isSystemAdminRole } from '@/permissions/permission-set';
import { loadPermissions } from './load-permissions';

/**
 * The console's door: SYSTEM_ADMIN, or "not found" - and "unread" when the
 * role could not be read at all.
 *
 * Not the product's usual "unread gates nothing" (`permissions-context.tsx`):
 * every other page is a tenant's own, where a refused control costs a click.
 * This one lists every tenant on the platform, so an unread role never opens
 * it. The backend refuses every call behind it anyway (`requireSystemAdmin`,
 * auth system.ts).
 *
 * ★★ BUT AN UNREAD ROLE IS NOT A REFUSAL (prod, 2026-11-16). It used to be
 *   `notFound()` too. The read fails when the platform is busy (429) or down
 *   (5xx), and then an operator was told the console does not exist. Now the
 *   answer is `'unread'`: the layout draws "couldn't check your access" with
 *   a Try again that a person presses (`ConsoleUnread`, `BackoffRetry`), and
 *   nothing that retries, reloads or redirects on its own. A role that WAS
 *   read and is not SYSTEM_ADMIN is still "not found".
 *
 * Called by the layout AND by each page: they render in parallel, and a page
 * must not start reading the platform's tenants for someone the layout is
 * about to turn away. A page draws nothing unless the door is `'open'`.
 * One read per request (`loadPermissions` is cached).
 */
export type ConsoleDoor = 'open' | 'unread';

export async function requireConsole(): Promise<ConsoleDoor> {
  const { roleKey, status } = await loadPermissions();
  if (isSystemAdminRole(roleKey)) return 'open';
  if (status === 'unavailable') return 'unread';
  notFound();
}
