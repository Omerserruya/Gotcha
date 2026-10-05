'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { z } from 'zod';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * The three routes answer `{ data: conversation }` and nothing here reads it:
 * the screen re-renders from `revalidatePath`, which re-reads the list and
 * the stream, so a shape parsed here would be a second, unused contract for
 * the same object.
 *
 * `z.unknown()` rather than a real schema is a deliberate, greppable
 * admission of that — **and it is only safe because no value is taken from
 * it.** The moment something reads a field, it needs a contract.
 */
const unchecked = z.unknown();

/**
 * Screen 02's three verbs.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ CLAIM AND TRANSFER CAN SEND A MESSAGE TO THE CUSTOMER
 * ════════════════════════════════════════════════════════════════════════════
 * `claim()` and `reassign()` both end in `sendAutoGreeting(...)`, which — if
 * the tenant has an `autoGreeting` setting — enqueues a real outbound message
 * on the customer's channel. On claim **and on reclaim**: its own comment
 * says *"send on both claim and reclaim"*, so pressing twice greets twice.
 *
 * So no test and no capture presses any of these. `Verbs.test.tsx` mocks this
 * module to throw.
 *
 * ── AND THERE IS NO "PUT BACK IN THE QUEUE" ──
 * `POST /:id/release` exists. Omer ruled it out: a human who has taken a
 * conversation hands it to the AI or to a named colleague, never drops it.
 * The platform agrees by accident — `release()` clears the assignment and
 * leaves `isHandedOver` set, so the conversation has no human and the AI is
 * still latched off it. Nobody drives it and no screen says so.
 */

export type VerbResult =
  | { readonly ok: true }
  /** 409 on claim — a colleague holds it. */
  | { readonly ok: false; readonly reason: 'already_claimed' }
  /** 409 on return-to-ai — no AI employee is bound to this conversation. */
  | { readonly ok: false; readonly reason: 'no_ai_employee' }
  /** 403 on transfer — not yours, and you are not an admin. */
  | { readonly ok: false; readonly reason: 'not_yours' }
  /** 404 — the conversation, or the colleague, is not there. */
  | { readonly ok: false; readonly reason: 'not_found' }
  /** 403 from delete: the viewer is not an admin. The menu hides it for them. */
  | { readonly ok: false; readonly reason: 'not_allowed' }
  | { readonly ok: false; readonly reason: 'failed' };

function refresh() {
  revalidatePath('/[locale]/(app)/inbox', 'page');
}

/**
 * Take control of a conversation the AI is handling.
 *
 * Sets `isHandedOver`, writes an `agent_claimed` divider, and greets the
 * customer if the workspace has a greeting configured.
 */
export async function claimConversation(conversationId: string): Promise<VerbResult> {
  try {
    await serverApi().post({
      endpoint: inboxEndpoints.claim(conversationId),
      body: {},
      payload: unchecked,
      raw: true,
    });
    refresh();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      /*
       * "Conversation already assigned" — somebody else got there. Not a
       * fault and not a retry: the repair is to ask them, and the screen says
       * so rather than offering the button again.
       */
      if (cause.status === 409) return { ok: false, reason: 'already_claimed' };
      if (cause.status === 404) return { ok: false, reason: 'not_found' };
    }
    logger.warn('inbox.claim_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Stop the AI on a conversation, assigning nobody. `returnToAi` undoes it.
 */
export async function stopAi(conversationId: string): Promise<VerbResult> {
  try {
    await serverApi().post({
      endpoint: inboxEndpoints.stopAi(conversationId),
      body: {},
      payload: unchecked,
      raw: true,
    });
    refresh();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.status === 404) return { ok: false, reason: 'not_found' };
    logger.warn('inbox.stop_ai_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Hand it back to the AI employee.
 *
 * The only call that clears `isHandedOver`, so it is the only way a
 * conversation a human took ever goes back to being answered automatically.
 */
export async function returnToAi(conversationId: string): Promise<VerbResult> {
  try {
    await serverApi().post({
      endpoint: inboxEndpoints.returnToAi(conversationId),
      body: {},
      payload: unchecked,
      raw: true,
    });
    refresh();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      /*
       * ★ THE 409 HERE MEANS SOMETHING ELSE ENTIRELY.
       * `returnToAi` refuses when `assignedAiAgentId` is null: there is no AI
       * employee on this conversation to hand back to. Same status as
       * claim's, opposite meaning, so they never share a sentence.
       */
      if (cause.status === 409) return { ok: false, reason: 'no_ai_employee' };
      if (cause.status === 404) return { ok: false, reason: 'not_found' };
    }
    logger.warn('inbox.return_to_ai_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Transfer to a named colleague.
 *
 * `agentId` only. The route also takes `departmentId`, and this product does
 * not send it: Omer ruled transfers go to a person. Sending both is not
 * possible here by construction rather than by care — the route branches on
 * `departmentId` FIRST, so a body carrying both would silently transfer to
 * the department and ignore the person named on screen.
 */
export async function transferConversation(
  conversationId: string,
  agentId: string,
): Promise<VerbResult> {
  if (!agentId.trim()) return { ok: false, reason: 'failed' };
  try {
    await serverApi().post({
      endpoint: inboxEndpoints.reassign(conversationId),
      body: { agentId },
      payload: unchecked,
      raw: true,
    });
    refresh();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      // "You can only transfer conversations assigned to you." A permission
      // with a precondition, not a fault: taking it first makes it possible.
      if (cause.kind === 'authorization') return { ok: false, reason: 'not_yours' };
      // The route 404s for a conversation OR an agent it cannot find. One
      // sentence for both, because the screen cannot tell them apart and
      // guessing which would be worse than naming neither.
      if (cause.status === 404) return { ok: false, reason: 'not_found' };
    }
    logger.warn('inbox.transfer_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Put a conversation back in the queue — the design's *"requeue"*.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ ONE OF FIVE THE PLATFORM CAN DO, OUT OF THE SEVEN THE DESIGN NAMES
 * ════════════════════════════════════════════════════════════════════════════
 * 02: *"Right-click gives assign, pause AI, requeue, unread, resolve, archive,
 * delete."* Measured against the platform's own OpenAPI:
 *
 *     assign (to me)    /claim        ✓ already here
 *     assign (someone)  /reassign     ✓ already here
 *     pause the AI      /claim        ✓ taking over IS the pause
 *     requeue           /release      ← this
 *     resolve           /close        ← below
 *     mark unread       NO ENDPOINT ANYWHERE
 *     archive           NO ENDPOINT ANYWHERE
 *     delete            NO ENDPOINT ANYWHERE
 *
 * ⚠ The last three are not "not wired yet". There is no route for them in the
 *   platform's API at all, so a menu item for them would be a control that
 *   cannot work — the thirty-days label and the resend button again, three at
 *   once and on a destructive action.
 */
export async function releaseConversation(conversationId: string): Promise<VerbResult> {
  try {
    await serverApi().post({
      endpoint: inboxEndpoints.release(conversationId),
      body: {},
      payload: unchecked,
      raw: true,
    });
    refresh();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      /*
       * ⚠ 409 IS NOT GIVEN THE SAME MEANING AS claim's OR returnToAi's.
       *   Those two have documented conflicts — already claimed, no AI
       *   employee. This route's conflict condition is not described in the
       *   schema, so it reports the generic failure rather than inventing a
       *   sentence about a state nobody has observed.
       */
      if (cause.status === 404) return { ok: false, reason: 'not_found' };
    }
    logger.warn('inbox.release_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}

/** Mark a conversation resolved — the design's *"resolve"*. */
export async function closeConversation(conversationId: string): Promise<VerbResult> {
  try {
    await serverApi().post({
      endpoint: inboxEndpoints.close(conversationId),
      body: {},
      payload: unchecked,
      raw: true,
    });
    refresh();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.status === 404) return { ok: false, reason: 'not_found' };
    }
    logger.warn('inbox.close_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Delete a conversation and its messages — the queue menu's last item.
 *
 * ⚠⚠ IRREVERSIBLE. The menu asks first, every time, and names how many.
 *
 * `force` for anything not CLOSED: the route refuses an active conversation
 * without it, and Omer ruled that deleting an active one forces.
 */
export async function deleteConversation(
  conversationId: string,
  force: boolean,
): Promise<VerbResult> {
  try {
    await serverApi().delete({
      endpoint: inboxEndpoints.remove(conversationId),
      query: force ? { force: 'true' } : undefined,
      payload: unchecked,
      raw: true,
    });
    refresh();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.status === 404) return { ok: false, reason: 'not_found' };
      if (cause.status === 403) return { ok: false, reason: 'not_allowed' };
    }
    logger.warn('inbox.delete_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}
