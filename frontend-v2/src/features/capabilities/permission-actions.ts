'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  automationCeiling,
  bodyFor,
  capabilitySchema,
  type AdminChoice,
  type Capability,
} from '@/api/contracts/capabilities';
import { capabilityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * Screen 10's write.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS CHANGES WHAT THE AI MAY DO TO CUSTOMERS WITHOUT ANYBODY WATCHING
 * ════════════════════════════════════════════════════════════════════════════
 * Setting a tool to *Do it* means the next call goes through unattended.
 * Omer authorized the control; that is not a reason to make it easy to press
 * by accident, and it is not a reason for anything automated to press it.
 *
 * **No capture calls this**; its tests run it against a mocked client only.
 *
 * ── AND THE CEILING IS RE-CHECKED HERE ──
 * The component withholds *Do it* where the server would refuse it
 * (`automationCeiling`, S2). This checks again, because a server action is an
 * endpoint: anything that can post a form can post `do_it`, and the
 * component's guard does not travel with the request.
 *
 * The PUT enforces the same table itself (`mayBeAlwaysAllowed`, 422
 * `approval_cannot_be_removed`). Should the two ever disagree, that refusal
 * is said as a sentence, not as "didn't save".
 */

export type PermissionWriteResult =
  | { readonly ok: true }
  /** The chosen state is not one this tool may be set to. */
  | { readonly ok: false; readonly reason: 'not_automatable' }
  /** 422 - the server keeps approval on this one (delete, money, settings). */
  | { readonly ok: false; readonly reason: 'approval_cannot_be_removed' }
  /** 409 - the provider is not connected, so there is nothing to enable. */
  | { readonly ok: false; readonly reason: 'not_connected' }
  | { readonly ok: false; readonly reason: 'forbidden' }
  | { readonly ok: false; readonly reason: 'failed' };

export async function setToolPermission(
  capability: Capability,
  choice: AdminChoice,
): Promise<PermissionWriteResult> {
  /*
   * ★★ THE CEILING, ENFORCED ON THE WRITE AND NOT ONLY IN THE MARKUP.
   *
   * A disabled radio is a statement to a person, not a constraint on a
   * request. The same table as the screen, so neither offers what the other
   * refuses.
   */
  if (choice === 'do_it' && automationCeiling(capability) !== null) {
    logger.warn('capabilities.automation_refused', { toolName: capability.toolName });
    return { ok: false, reason: 'not_automatable' };
  }

  try {
    await serverApi().put({
      endpoint: capabilityEndpoints.update(capability.toolName),
      // Both fields, always - see `bodyFor`. The route applies
      // `requiresApproval` only when present.
      body: bodyFor(choice),
      payload: capabilitySchema.partial(),
      raw: true,
    });
    revalidatePath('/[locale]/(app)/studio/capabilities', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      /*
       * The route's own refusal: you cannot enable a tool whose integration
       * is disconnected. Rendered as the repair it is rather than as a
       * failure - the same distinction as screen 10's fourth state, arriving
       * on the write.
       */
      if (cause.status === 409) {
        logger.warn('capabilities.not_connected', { toolName: capability.toolName });
        return { ok: false, reason: 'not_connected' };
      }
      /*
       * The server's own ceiling (`tool-permissions.ts`): `{ error:
       * "approval_cannot_be_removed" }` - the reason is in `error`, not `code`.
       */
      if (cause.status === 422 && cause.developerMessage === 'approval_cannot_be_removed') {
        logger.warn('capabilities.approval_kept', { toolName: capability.toolName });
        return { ok: false, reason: 'approval_cannot_be_removed' };
      }
      if (cause.kind === 'authorization') return { ok: false, reason: 'forbidden' };
    }
    logger.warn('capabilities.permission_write_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}
