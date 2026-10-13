'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { TOOL_LEVELS, type ToolLevel } from '@/api/contracts/employees';
import { employeeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type ToolLevelResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'looser' | 'forbidden' | 'failed' };

/**
 * E5: one action's level for one employee. `null` is "like the workspace".
 * The server refuses a level looser than the workspace's (422
 * LOOSER_THAN_WORKSPACE): said, never retried.
 */
export async function setEmployeeToolLevel(
  employeeId: string,
  toolName: string,
  level: ToolLevel | null,
): Promise<ToolLevelResult> {
  if (!employeeId || !toolName || (level !== null && !TOOL_LEVELS.includes(level))) {
    return { ok: false, reason: 'failed' };
  }
  try {
    await serverApi().put({
      endpoint: employeeEndpoints.toolLevel(employeeId, toolName),
      body: { level },
      payload: z.unknown(),
    });
    revalidatePath('/[locale]/studio/employees', 'layout');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('employees.tool_level_failed', { cause, toolName });
    if (isApiError(cause)) {
      if (cause.status === 422) return { ok: false, reason: 'looser' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}
