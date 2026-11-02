'use server';

import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  currentSupportSessionSchema,
  supportSessionSchema,
  type SupportSession,
} from '@/api/contracts/console';
import { consoleEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { clearSupport, readSupport, writeSupport } from '@/support/support-cookie';

/**
 * Entering and leaving support mode (Omer, 2026-11-01): a GOTCHA admin works
 * inside a customer's workspace as its admin, for a reason they give, for at
 * most two hours. Backend `routes/support-sessions.ts`; mocked in every test.
 *
 * Every call here is `/api/system/*`, so it goes out as the admin even while
 * a session is live (`support-headers.ts`). The session itself is the
 * platform's; this app keeps only its id, in a sealed cookie bound to this
 * login (`support-cookie.ts`).
 *
 * They return a result rather than throwing, and navigate nowhere: the
 * console opens the workspace with a document load once the cookie is set,
 * so nothing drawn for the admin survives into the workspace.
 */
export type SupportRefusal =
  /** The validator refused the reason: blank, or over 500 characters. */
  | 'reason_invalid'
  /** `not_system_admin`, or any other 403. */
  | 'forbidden'
  /** `mfa_required`: this login has not passed two-step verification. */
  | 'mfa_required'
  /** `tenant_not_found`. */
  | 'not_found'
  /** `support_system_tenant`: the System workspace, or the admin's own. */
  | 'system_tenant'
  /** `support_session_active`: this login is already in a session (`activeName`). */
  | 'active'
  /**
   * `support_requires_session`: the platform found no session for this login
   * to bind to. Never said as "sign in again" - a new sign-in is the same kind
   * of login, and it answered the same (prod, 2026-11-02).
   */
  | 'no_session'
  /** The session started but this browser could not keep it (it expired at once). */
  | 'not_kept'
  | 'failed';

export type SupportResult<T extends object = object> =
  | ({ readonly ok: true } & T)
  | {
      readonly ok: false;
      readonly reason: SupportRefusal;
      /** `active`: the workspace that session is in, when it could be read. */
      readonly activeName?: string | null;
    };

/* End's body is not read: a 200 is ended, whatever this build can parse of it. */
const anything = z.unknown();

const BY_CODE: Readonly<Record<string, SupportRefusal>> = {
  not_system_admin: 'forbidden',
  mfa_required: 'mfa_required',
  tenant_not_found: 'not_found',
  support_system_tenant: 'system_tenant',
  support_session_active: 'active',
  support_requires_session: 'no_session',
};

/** After `signInIfSignedOut` in the catch: a 401 never reaches here. */
function refusalOf(cause: unknown, event: string): SupportRefusal {
  if (isApiError(cause)) {
    const known = cause.code ? BY_CODE[cause.code] : undefined;
    if (known) {
      // Said on screen in words; the code is kept here, where it can be read.
      logger.warn(event, { code: cause.code, status: cause.status });
      return known;
    }
    if (cause.kind === 'validation') return 'reason_invalid';
    if (cause.kind === 'authorization') return 'forbidden';
    if (cause.kind === 'not_found') return 'not_found';
  }
  logger.warn(event, { cause });
  return 'failed';
}

/** This login's live session, or `null`. Throws when it could not be read. */
async function current(): Promise<SupportSession | null> {
  return serverApi().get({
    endpoint: consoleEndpoints.currentSupportSession(),
    payload: currentSupportSessionSchema,
  });
}

/**
 * Starts a session in `tenantId` and keeps it in this browser. The reason is
 * the platform's to check (1-500 after trim); it is recorded in the
 * workspace's own history and in System's.
 */
export async function startSupport(
  tenantId: string,
  reason: string,
): Promise<SupportResult<{ readonly session: SupportSession }>> {
  let session: SupportSession;
  try {
    session = await serverApi().post({
      endpoint: consoleEndpoints.supportSessions(),
      body: { tenantId, reason: reason.trim() },
      payload: supportSessionSchema,
    });
  } catch (cause) {
    await signInIfSignedOut(cause);
    const refusal = refusalOf(cause, 'support.start_failed');
    if (refusal !== 'active') return { ok: false, reason: refusal };
    return { ok: false, reason: 'active', activeName: await activeName() };
  }
  if (!(await writeSupport(session))) {
    logger.warn('support.cookie_not_kept', { sessionId: session.id });
    return { ok: false, reason: 'not_kept' };
  }
  return { ok: true, session };
}

/** The workspace this login's live session is in - for "already in a session". */
async function activeName(): Promise<string | null> {
  try {
    return (await current())?.tenantName ?? null;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('support.current_failed', { cause });
    return null;
  }
}

/**
 * Picks up this login's live session again - a 409 `support_session_active`
 * from another tab, or a browser that lost the cookie. `none` when there is
 * no live session to return to.
 */
export async function resumeSupport(): Promise<
  | SupportResult<{ readonly session: SupportSession }>
  | { readonly ok: false; readonly reason: 'none' }
> {
  try {
    const session = await current();
    if (!session) return { ok: false, reason: 'none' };
    if (!(await writeSupport(session))) return { ok: false, reason: 'not_kept' };
    return { ok: true, session };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return { ok: false, reason: refusalOf(cause, 'support.resume_failed') };
  }
}

/**
 * Ends this login's session: the one this browser holds, otherwise the live
 * one the platform names. Idempotent - ending an ended session is done.
 *
 * ★ THE COOKIE GOES ONLY ONCE THE PLATFORM HAS SAID SO (or there was nothing
 *   to end). A failed end keeps it, so the banner and its Exit stay: dropping
 *   it would leave a live session the admin can no longer see.
 */
export async function endSupport(): Promise<SupportResult<{ readonly tenantId: string | null }>> {
  try {
    const held = await readSupport();
    const id = held?.id ?? (await current())?.id ?? null;
    const tenantId = held?.tenantId ?? null;
    if (id) {
      try {
        await serverApi().post({
          endpoint: consoleEndpoints.endSupportSession(id),
          payload: anything,
        });
      } catch (cause) {
        await signInIfSignedOut(cause);
        // Not this admin's, or gone: nothing of theirs is live under that id.
        if (!(isApiError(cause) && cause.code === 'support_session_not_found')) throw cause;
      }
    }
    await clearSupport();
    return { ok: true, tenantId };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return { ok: false, reason: refusalOf(cause, 'support.end_failed') };
  }
}
