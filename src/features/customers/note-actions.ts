'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { noteDeleteSchema, noteWriteSchema, NOTE_MAX_LENGTH } from '@/api/contracts/customer-notes';
import { customerEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * Screen 04f's writes.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A NOTE CAN LEAVE THIS PRODUCT, AND THAT IS THE POINT OF `aiUsable`
 * ════════════════════════════════════════════════════════════════════════════
 * `POST` mirrors the note into the merchant's elected CRM when - and only
 * when - `aiUsable` is true. The service's own comment says why the push is
 * the only place that can stop it:
 *
 *   note → elected CRM → crmBundle.notes → bundle.recent_crm_notes
 *        → "## Recent CRM notes" in the brief → the model's context
 *        → a reply to the customer
 *
 * So the toggle is not a preference about our own database. It decides
 * whether a sentence a merchant typed can come back out of the bot's mouth,
 * and it **defaults off** for that reason. Nothing here may default it on.
 *
 * ── AND NOTHING AUTOMATED MAY CALL THESE ──
 * A note is real tenant data: it appears on a real person's record in a real
 * workspace, and a synced one is written into the merchant's own CRM where
 * we cannot correct it. No capture and no test presses these. The screen's
 * behaviour is unit-tested against the contract instead.
 */

export type NoteWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'too_long' }
  | { readonly ok: false; readonly reason: 'empty' }
  /** 403 `not_the_author` - a permission fact, not a fault. */
  | { readonly ok: false; readonly reason: 'not_the_author' }
  | { readonly ok: false; readonly reason: 'failed' };

function classify(cause: unknown): Extract<NoteWriteResult, { ok: false }> {
  if (isApiError(cause) && cause.kind === 'authorization') {
    return { ok: false, reason: 'not_the_author' };
  }
  return { ok: false, reason: 'failed' };
}

/** Length and emptiness, checked here so a 400 is never the user interface. */
function validate(body: string): Extract<NoteWriteResult, { ok: false }> | null {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > NOTE_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  return null;
}

export async function createNote(
  contactId: string,
  body: string,
  aiUsable: boolean,
): Promise<NoteWriteResult> {
  const invalid = validate(body);
  if (invalid) return invalid;
  try {
    await serverApi().post({
      endpoint: customerEndpoints.notes(contactId),
      /*
       * `visibility` is deliberately NOT sent. The route defaults it to TEAM,
       * and 04f under Omer's "classic notes only" ruling offers no control
       * for it - so sending a value would be this screen deciding an axis it
       * does not show. The column keeps its own default.
       */
      body: { body: body.trim(), aiUsable },
      payload: noteWriteSchema,
    });
    revalidatePath('/[locale]/(app)/customers/[id]', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('customer.note_create_failed', { cause });
    return classify(cause);
  }
}

export async function editNote(
  contactId: string,
  noteId: string,
  body: string,
): Promise<NoteWriteResult> {
  const invalid = validate(body);
  if (invalid) return invalid;
  try {
    await serverApi().patch({
      endpoint: customerEndpoints.note(contactId, noteId),
      /*
       * Body only. `aiUsable` is omitted rather than resent, because the
       * route applies it *"only when stated"* - and resending the value we
       * happen to be holding would overwrite a change somebody else made
       * between the read and the edit. The business-hours defaults trap,
       * which the service's own comment names.
       */
      body: { body: body.trim() },
      payload: noteWriteSchema,
    });
    revalidatePath('/[locale]/(app)/customers/[id]', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('customer.note_edit_failed', { cause });
    return classify(cause);
  }
}

/**
 * Soft delete. The row stays.
 *
 * *"A customer's history should not develop holes, and a deleted note is
 * still evidence of what somebody believed at the time."* It leaves every
 * default read, so the screen simply stops showing it - but the control is
 * still worth confirming, because the author cannot bring it back.
 */
export async function removeNote(contactId: string, noteId: string): Promise<NoteWriteResult> {
  try {
    /*
     * Its own schema: the delete answers `{ note: { id, deletedAt } }` and
     * `noteWriteSchema` requires a whole row. No `raw` - this body has no
     * top-level `data`, checked at the route rather than assumed in either
     * direction, which is what the two envelope bugs today were about.
     */
    await serverApi().delete({
      endpoint: customerEndpoints.note(contactId, noteId),
      payload: noteDeleteSchema,
    });
    revalidatePath('/[locale]/(app)/customers/[id]', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('customer.note_delete_failed', { cause });
    return classify(cause);
  }
}
