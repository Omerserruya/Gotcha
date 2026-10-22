'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { builderEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type ToolGrantResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_provisioned' | 'forbidden' | 'failed' };

/**
 * Give one integration action to an employee, or take it away (Backend
 * 9339ca26): an integration's action reaches an employee only when given.
 * Used by the employee page and by the hire, after its draft exists. A name
 * without an integration (a built-in) needs no grant: nothing is sent.
 */
export async function setEmployeeToolGrant(
  employeeId: string,
  toolName: string,
  granted: boolean,
): Promise<ToolGrantResult> {
  if (!employeeId || !toolName.includes('.')) return { ok: false, reason: 'failed' };
  try {
    await serverApi().post({
      endpoint: builderEndpoints.tool(employeeId),
      body: granted ? { toolName } : { toolName, attach: false },
      payload: z.unknown(),
    });
    revalidatePath('/[locale]/studio/employees', 'layout');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('employees.tool_grant_failed', { cause, toolName });
    if (isApiError(cause)) {
      if (cause.code === 'TOOL_NOT_PROVISIONED') return { ok: false, reason: 'not_provisioned' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}
