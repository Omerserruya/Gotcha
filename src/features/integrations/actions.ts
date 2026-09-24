'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { electionResultSchema, type ElectionResult } from '@/api/contracts/business-core';
import { integrationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The write behind screen 14c.
 *
 * A server action rather than a browser call, for the same reason as screen
 * 11's: this is a write, and routing it through the server keeps the BFF's
 * origin check and the session cookie doing their jobs without the control
 * knowing either exists.
 *
 * ── THE FAILURES ARE ANSWERS, NOT EXCEPTIONS ──
 * Every one of these is a sentence the screen has to render. `not_connected`
 * in particular is not a bug: the read reports a candidate from a
 * `TenantIntegration` row, and the write requires `status: CONNECTED`, so a
 * system can be offered and refused in the same breath if it breaks between
 * the page loading and somebody choosing. Backend found exactly that live.
 */
export type ElectResult =
  | { readonly ok: true; readonly data: ElectionResult }
  /**
   * The system stopped being CONNECTED between the read and the write. The
   * screen says so and reloads, rather than reporting a generic failure for
   * something the merchant can actually see and fix.
   */
  | { readonly ok: false; readonly reason: 'not_connected' }
  /**
   * Elected on its own screen. TWO of these now — the CRM has
   * `config.useAsCrm` and returns has `config.returnProvider` — and they
   * point at different places, so they are different answers rather than one
   * "not here". Sending somebody to the CRM screen to change returns is a
   * wrong instruction that looks like a right one.
   */
  | { readonly ok: false; readonly reason: 'crm_elsewhere' }
  | { readonly ok: false; readonly reason: 'returns_elsewhere' }
  | { readonly ok: false; readonly reason: 'failed' };

function classify(cause: unknown): ElectResult {
  if (isApiError(cause)) {
    /*
     * Matched on the server's own codes rather than on status. A 409 here
     * means two entirely different things, and telling somebody "that system
     * isn't connected" when the real answer is "the CRM is set elsewhere"
     * sends them to reconnect something that is working.
     */
    const code = cause.code ?? '';
    if (code === 'CRM_ELECTED_ELSEWHERE') return { ok: false, reason: 'crm_elsewhere' };
    if (code === 'RETURNS_ELECTED_ELSEWHERE') return { ok: false, reason: 'returns_elsewhere' };
    if (code === 'INTEGRATION_NOT_CONNECTED') return { ok: false, reason: 'not_connected' };
  }
  return { ok: false, reason: 'failed' };
}

/**
 * Elect `slug` to play `role`.
 *
 * ★ AND THIS NOW CHANGES WHAT THE AI DOES.
 * It did not, for most of a day: `config.roles` was read in exactly one
 * place — the displacement logic inside this very write. Backend landed the
 * read at 2d1abf88 and the live bot path consumes it
 * (`ai-bot.service.ts:1705` → `prompt-builder.service.ts:463`), so the
 * caveat this screen carried has been deleted rather than left to rot.
 *
 * `config.roles` holds only **ecommerce** and **payments**. The CRM and
 * returns have their own electors and this endpoint refuses both.
 */
export async function electRole(role: string, slug: string): Promise<ElectResult> {
  try {
    const data = await serverApi().put({
      endpoint: integrationEndpoints.electRole(),
      body: { role, slug },
      payload: electionResultSchema,
    });
    revalidatePath('/[locale]/(app)/settings/systems', 'page');
    return { ok: true, data };
  } catch (cause: unknown) {
    logger.warn('business_core.elect_failed', { cause, role });
    return classify(cause);
  }
}
