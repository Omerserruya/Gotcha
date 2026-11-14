import 'server-only';

import { cache } from 'react';
import { headers } from 'next/headers';

import { RETURN_TO_HEADER } from '@/auth/return-to';
import { isConsolePath } from '@/shell/workspace-gate';
import { TENANT_HEADER } from '@/tenant/tenant-header';

import { isConsoleRoute, SUPPORT_SESSION_HEADER } from './support-codes';
import { readSupport } from './support-cookie';

/**
 * What a call to the platform adds in support mode: the session and the
 * workspace it is for. Nothing when there is no live session, and nothing on
 * the console's own calls.
 *
 * ★★ TWO WAYS A CALL IS THE CONSOLE'S, and both go out as the admin:
 *   · its route is `/api/system/*` - `requireSystemAdmin` refuses a support
 *     principal, so start, current and end could never be called otherwise;
 *   · the PAGE is the console (`/system`, the proxy's return-to header) - its
 *     layout reads `/me` and the permissions to open the door, and read as
 *     the workspace's ADMIN they would close it on the admin: the console
 *     would 404 in the very tab the banner says to return to.
 *   The header is the proxy's on every page and server action; anywhere else
 *   (a route handler) it is absent, and only the route decides. It can only
 *   ever REMOVE the support session from a call, never add one.
 */
export async function supportHeaders(route: string | undefined): Promise<Record<string, string>> {
  if (route !== undefined && isConsoleRoute(route)) return {};
  if (await onConsolePage()) return {};
  const support = await readSupport();
  if (!support) return {};
  return { [SUPPORT_SESSION_HEADER]: support.id, [TENANT_HEADER]: support.tenantId };
}

const onConsolePage = cache(async (): Promise<boolean> => {
  try {
    const at = (await headers()).get(RETURN_TO_HEADER);
    return at !== null && isConsolePath(at);
  } catch {
    // Outside a request: there is no page, and no support cookie to read either.
    return false;
  }
});
