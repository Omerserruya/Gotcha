'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { workspaceEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** What the drawer asks to store. Every field, every time - see below. */
export interface SlaWrite {
  readonly enabled: boolean;
  readonly slaMinutes: number;
  /** `null`: no early warning - only late conversations are marked. */
  readonly warningThreshold: number | null;
  /** Only the departments whose own target changed. */
  readonly departments: readonly {
    readonly id: string;
    readonly enabled: boolean;
    readonly slaMinutes: number | null;
  }[];
}

export type SlaWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'forbidden' | 'invalid' | 'failed' }
  /** The workspace's target saved; these departments did not. */
  | { readonly ok: false; readonly reason: 'departments'; readonly failed: readonly string[] };

const inRange = (value: number, min: number, max: number) =>
  Number.isFinite(value) && value >= min && value <= max;

/**
 * Saves the response target (W2). Owner only on the server.
 *
 * ★ THE WHOLE OBJECT, EVERY TIME. The PUT stores its body as the setting, so
 *   a body without `warningThreshold` erases it. Minutes are kept when the
 *   target is switched off, so switching it back on restores them.
 *
 * The workspace's target first; a department is written only when its own
 * changed, and one that fails is named, not hidden behind "saved".
 */
export async function saveSla(write: SlaWrite): Promise<SlaWriteResult> {
  if (
    !inRange(write.slaMinutes, 1, 1440) ||
    (write.warningThreshold !== null && !inRange(write.warningThreshold, 0, 100)) ||
    write.departments.some(
      (d) => d.enabled && (d.slaMinutes === null || !inRange(d.slaMinutes, 1, 1440)),
    )
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const api = serverApi();
  try {
    await api.put({
      endpoint: workspaceEndpoints.sla(),
      body: {
        enabled: write.enabled,
        slaMinutes: write.slaMinutes,
        ...(write.warningThreshold === null ? {} : { warningThreshold: write.warningThreshold }),
      },
      payload: z.unknown(),
    });
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('workspace.sla_save_failed', { cause });
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    if (isApiError(cause) && cause.kind === 'validation') return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'failed' };
  }
  const failed: string[] = [];
  for (const department of write.departments) {
    try {
      await api.put({
        endpoint: workspaceEndpoints.slaDepartment(department.id),
        body:
          department.enabled && department.slaMinutes !== null
            ? { enabled: true, slaMinutes: department.slaMinutes }
            : { enabled: false },
        payload: z.unknown(),
      });
    } catch (cause) {
      await signInIfSignedOut(cause);
      logger.warn('workspace.department_sla_save_failed', { cause, departmentId: department.id });
      failed.push(department.id);
    }
  }
  revalidatePath('/[locale]/settings/workspace', 'page');
  revalidatePath('/[locale]/inbox', 'page');
  return failed.length > 0 ? { ok: false, reason: 'departments', failed } : { ok: true };
}
