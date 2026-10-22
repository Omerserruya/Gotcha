/**
 * Notes about a CUSTOMER: stored here, mirrored to the elected system.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACES, AND WHY IT IS NOT JUST A CRM CALL
 *
 * `GET/POST /api/conversations/:id/notes` were demo stubs. The POST answered
 * 200 with a well-formed note it never wrote, so a client rendered it as saved
 * and nothing recorded the loss. They now answer 501 and name the CRM endpoint.
 *
 * That CRM endpoint works and is not replaced. What it cannot hold is what this
 * design asks for: a visibility flag, an edit history, @mentions, and a note
 * the AI proposed that nobody has accepted. A CRM note body has nowhere to put
 * any of them.
 *
 * ★ SO THIS IS MIRRORING, NOT ROUTING - and the distinction is the design.
 *
 * "Notes live either inside GOTCHA or in the system configured in Business
 * Core" has two readings. Routing would mean: a CRM is elected, so write there
 * INSTEAD - which silently discards visibility, history, mentions and
 * suggestions for exactly the tenants who have a CRM. So a note is always
 * written here, and when a system is elected it also gets a copy of the body.
 *
 * Nothing is silent in either direction. `externalSyncStatus` distinguishes
 * four states, and the two that matter are the ones a single boolean would
 * merge: NOT_APPLICABLE (nobody elected a system - not a failure) and FAILED
 * (there was a target and it refused). A screen must be able to say which.
 *
 * ── The elected system is resolved by ASKING, never by re-deciding ──
 *
 * `getSystemForPart` and `resolveCrmVendor` live in the ai service and the AI
 * already reads them. This does not re-implement that election; it calls the ai
 * service's existing note endpoint, which resolves the CRM through the same
 * resolver and reports its own refusals by name. A second elector here is how a
 * merchant's Business Core choice ends up ignored by half the product.
 *
 * ── A PRIVATE note is never mirrored ──
 *
 * A private note in the merchant's shared CRM is not private. That is enforced
 * here rather than left to the caller.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@chatcenter/shared";

export type NoteVisibility = "TEAM" | "PRIVATE";
export type NoteStatus = "PUBLISHED" | "AI_SUGGESTED" | "REJECTED";

export interface NoteAuthor {
  userId: string | null;
  name: string;
}

/** One entry appended on every edit. Append-only, never rewritten. */
interface EditEntry {
  at: string;
  byUserId: string | null;
  byName: string;
  previousBody: string;
}

export const NOTE_MAX_LENGTH = 5000;

/**
 * Who may see a note.
 *
 * PRIVATE is the author's alone. Built as a WHERE clause rather than a filter
 * on the results, because a post-query filter still loaded the row and any
 * later `count`, export or log that forgets the filter leaks it.
 */
function visibilityScope(viewerUserId: string | null) {
  return {
    OR: [
      { visibility: "TEAM" as const },
      { visibility: "PRIVATE" as const, authorUserId: viewerUserId },
    ],
  };
}

export interface ListArgs {
  tenantId: string;
  contactId: string;
  personId?: string | null;
  viewerUserId: string | null;
  /** AI suggestions are excluded unless asked for: they are not notes yet. */
  includeSuggestions?: boolean;
  includeDeleted?: boolean;
}

export async function listNotes(args: ListArgs) {
  const statuses: NoteStatus[] = args.includeSuggestions
    ? ["PUBLISHED", "AI_SUGGESTED"]
    : ["PUBLISHED"];

  return (prisma as any).customerNote.findMany({
    where: {
      tenantId: args.tenantId,
      // personId as well as contactId, so a note survives a contact merge - the
      // same reason the brief resolves on it.
      ...(args.personId
        ? { OR: [{ contactId: args.contactId }, { personId: args.personId }] }
        : { contactId: args.contactId }),
      status: { in: statuses },
      ...(args.includeDeleted ? {} : { deletedAt: null }),
      ...visibilityScope(args.viewerUserId),
    },
    orderBy: { createdAt: "desc" },
    // `select`, never `include`: three routes have shipped secrets through a
    // spread of a related row.
    select: {
      id: true, body: true, visibility: true, aiUsable: true, status: true,
      authorUserId: true, authorName: true, mentions: true,
      conversationId: true, editHistory: true,
      externalSystem: true, externalNoteId: true,
      externalSyncStatus: true, externalSyncError: true, externalSyncedAt: true,
      deletedAt: true, createdAt: true, updatedAt: true,
    },
  });
}

export interface CreateArgs {
  tenantId: string;
  contactId: string;
  personId?: string | null;
  conversationId?: string | null;
  body: string;
  visibility?: NoteVisibility;
  /** Whether the bot's prompt may include it. Defaults false: fails closed. */
  aiUsable?: boolean;
  mentions?: string[];
  /** AI_SUGGESTED for a proposal a person has not accepted yet. */
  status?: NoteStatus;
  author: NoteAuthor;
}

export async function createNote(args: CreateArgs) {
  const body = args.body.trim();
  if (!body) throw new NoteError(400, "body_required");
  if (body.length > NOTE_MAX_LENGTH) throw new NoteError(400, "body_too_long");

  return (prisma as any).customerNote.create({
    data: {
      tenantId: args.tenantId,
      contactId: args.contactId,
      personId: args.personId ?? null,
      conversationId: args.conversationId ?? null,
      body,
      visibility: args.visibility ?? "TEAM",
      // Prompt-unsafe unless the caller says otherwise. An omitted field must
      // not open the note to the bot.
      aiUsable: args.aiUsable === true,
      status: args.status ?? "PUBLISHED",
      authorUserId: args.author.userId,
      authorName: args.author.name,
      mentions: dedupe(args.mentions ?? []),
      editHistory: [],
    },
  });
}

export interface UpdateArgs {
  tenantId: string;
  noteId: string;
  editor: NoteAuthor;
  body?: string;
  visibility?: NoteVisibility;
  aiUsable?: boolean;
  mentions?: string[];
}

/**
 * Edit a note, recording what it said before.
 *
 * ★ The previous body is appended to `editHistory` BEFORE the new one is
 * written. A note that can be corrected silently is only a record of whatever
 * it currently says, which is worth less than no record for anything anyone
 * might later dispute.
 */
export async function updateNote(args: UpdateArgs) {
  const existing = await requireOwnEditable(args.tenantId, args.noteId, args.editor.userId);

  const bodyChanged = typeof args.body === "string" && args.body.trim() !== existing.body;
  if (typeof args.body === "string") {
    const next = args.body.trim();
    if (!next) throw new NoteError(400, "body_required");
    if (next.length > NOTE_MAX_LENGTH) throw new NoteError(400, "body_too_long");
  }

  const history = Array.isArray(existing.editHistory) ? (existing.editHistory as EditEntry[]) : [];
  const appended: EditEntry[] = bodyChanged
    ? [...history, {
        at: new Date().toISOString(),
        byUserId: args.editor.userId,
        byName: args.editor.name,
        previousBody: existing.body,
      }]
    : history;

  return (prisma as any).customerNote.update({
    where: { id: args.noteId },
    data: {
      ...(typeof args.body === "string" ? { body: args.body.trim() } : {}),
      ...(args.visibility ? { visibility: args.visibility } : {}),
      // Only when stated. Omitting it leaves the note as it was, rather than
      // resetting a deliberate choice - the business-hours defaults trap.
      ...(typeof args.aiUsable === "boolean" ? { aiUsable: args.aiUsable } : {}),
      ...(args.mentions ? { mentions: dedupe(args.mentions) } : {}),
      editHistory: appended,
    },
  });
}

/**
 * Soft delete.
 *
 * The row stays. A customer's history should not develop holes, and a deleted
 * note is still evidence of what somebody believed at the time. It leaves every
 * default read via `deletedAt: null`.
 */
export async function deleteNote(tenantId: string, noteId: string, editorUserId: string | null) {
  await requireOwnEditable(tenantId, noteId, editorUserId);
  return (prisma as any).customerNote.update({
    where: { id: noteId },
    data: { deletedAt: new Date() },
  });
}

/** Accept or decline a note the AI proposed. */
export async function decideSuggestion(
  tenantId: string,
  noteId: string,
  decision: "accept" | "reject",
  decider: NoteAuthor,
) {
  const note = await (prisma as any).customerNote.findFirst({
    where: { id: noteId, tenantId },
    select: { id: true, status: true },
  });
  if (!note) throw new NoteError(404, "note_not_found");
  if (note.status !== "AI_SUGGESTED") throw new NoteError(409, "not_a_suggestion");

  return (prisma as any).customerNote.update({
    where: { id: noteId },
    data: decision === "accept"
      // Accepting makes it a real note and attributes it to the PERSON who
      // accepted, not to the AI that drafted it: a team note nobody agreed to
      // is the defect the AI_SUGGESTED state exists to prevent.
      ? { status: "PUBLISHED", authorUserId: decider.userId, authorName: decider.name }
      : { status: "REJECTED" },
  });
}

/**
 * Mirror a note's body to the system elected for this business.
 *
 * Delegates to the ai service's existing CRM note endpoint, which resolves the
 * vendor through the same resolver the AI uses. The caller's own Authorization
 * header is forwarded, so the CRM endpoint's permission checks apply to the
 * person who wrote the note rather than to a service identity.
 *
 * ★ NEVER THROWS, and never reports a success it did not get. Every outcome
 * lands in `externalSyncStatus`:
 *
 *   NOT_APPLICABLE  no CRM configured or linked, or the note is PRIVATE
 *   SYNCED          the provider accepted it
 *   FAILED          there was a target and it refused, with the reason kept
 */
export async function mirrorToElectedSystem(args: {
  tenantId: string;
  noteId: string;
  conversationId: string | null;
  body: string;
  visibility: NoteVisibility;
  /** Gates the push. See the comment below: this is the only chokepoint. */
  aiUsable: boolean;
  authHeader?: string;
}): Promise<void> {
  const set = (data: Record<string, unknown>) =>
    (prisma as any).customerNote.update({ where: { id: args.noteId }, data }).catch(() => undefined);

  // A private note in the merchant's shared CRM is not private.
  if (args.visibility === "PRIVATE") {
    return void (await set({ externalSyncStatus: "NOT_APPLICABLE", externalSyncError: "private" }));
  }

  // ★ A NOTE THE BOT MAY NOT USE MUST NOT BE MIRRORED, AND THIS IS THE ONLY
  // PLACE THAT CAN STOP IT.
  //
  // `aiUsable` on our row is worthless against the real leak path, because the
  // model never reads our row:
  //
  //   note -> elected CRM -> crmBundle.notes -> bundle.recent_crm_notes
  //        -> "## Recent CRM notes" in the brief (customer-brief.service.ts:390)
  //        -> the model's context -> a reply to the customer
  //
  // Verified end to end. So gating the READ of `customer_notes` cannot help: by
  // then the note is in HubSpot and comes back as somebody else's data. The push
  // is the only chokepoint.
  //
  // The cost is real and deliberate: a note not marked AI-usable does NOT reach
  // the merchant's CRM. `externalSyncError` says why, so a screen can tell them
  // rather than leaving it looking like a sync that quietly did not happen.
  if (args.aiUsable !== true) {
    return void (await set({ externalSyncStatus: "NOT_APPLICABLE", externalSyncError: "not_ai_usable" }));
  }
  // The ai endpoint is conversation-keyed. Without one there is nothing to
  // resolve a CRM contact from, which is a real "nothing to do", not an error.
  if (!args.conversationId) {
    return void (await set({ externalSyncStatus: "NOT_APPLICABLE", externalSyncError: null }));
  }
  if (!args.authHeader) {
    return void (await set({ externalSyncStatus: "NOT_APPLICABLE", externalSyncError: null }));
  }

  await set({ externalSyncStatus: "PENDING" });

  const base = (process.env.AI_SERVICE_URL ?? "http://ai:4006").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/crm/conversation/${args.conversationId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: args.authHeader },
      body: JSON.stringify({ body: args.body }),
    });
    const payload: any = await res.json().catch(() => ({}));

    if (res.ok) {
      return void (await set({
        externalSyncStatus: "SYNCED",
        externalSystem: payload?.data?.vendor ?? null,
        externalNoteId: payload?.data?.note_id ?? null,
        externalSyncedAt: new Date(),
        externalSyncError: null,
      }));
    }

    // The CRM endpoint's own vocabulary for "there is no target", which is a
    // normal state for a tenant that has not connected or linked one.
    if (payload?.error === "no_crm_link" || payload?.error === "no_crm_configured") {
      return void (await set({ externalSyncStatus: "NOT_APPLICABLE", externalSyncError: payload.error }));
    }

    return void (await set({
      externalSyncStatus: "FAILED",
      externalSyncError: String(payload?.error ?? `http_${res.status}`),
    }));
  } catch (err: any) {
    // A transport failure is FAILED, not NOT_APPLICABLE. Collapsing them would
    // make an outage look like a tenant without a CRM.
    return void (await set({
      externalSyncStatus: "FAILED",
      externalSyncError: String(err?.message ?? "request_failed").slice(0, 300),
    }));
  }
}

export class NoteError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

/**
 * A note exists, is not deleted, and this person may change it.
 *
 * Only the author edits or deletes. Anyone else with access can read a TEAM
 * note, and letting them rewrite it would make `authorName` a claim about
 * somebody who did not write what it now says.
 */
async function requireOwnEditable(tenantId: string, noteId: string, editorUserId: string | null) {
  const note = await (prisma as any).customerNote.findFirst({
    where: { id: noteId, tenantId },
    select: { id: true, body: true, editHistory: true, authorUserId: true, deletedAt: true },
  });
  if (!note) throw new NoteError(404, "note_not_found");
  if (note.deletedAt) throw new NoteError(409, "note_deleted");
  if (note.authorUserId !== editorUserId) throw new NoteError(403, "not_the_author");
  return note;
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids.map((s) => String(s).trim()).filter(Boolean))];
}


/**
 * The ONLY read of `customer_notes` that may reach a model.
 *
 * One accessor rather than a filter at each call site, for the reason
 * `applyLiveByDefault` exists: a default that must be remembered is a default
 * that will be forgotten. Two conditions, and both are easy to omit by accident:
 *
 *   status: PUBLISHED   a note the AI proposed is not a note until a person
 *                       agreed with it, so it must not feed itself back in
 *   aiUsable: true      fails closed - a note is prompt-unsafe unless somebody
 *                       said otherwise
 *
 * Deleted notes are excluded too. PRIVATE notes are NOT excluded here on
 * purpose: `aiUsable` already decides this question, and adding a second
 * condition that happens to agree would hide which one is doing the work.
 *
 * ⚠️ This does not protect a note that was MIRRORED to the merchant's CRM. The
 * model reads those back as `recent_crm_notes`, which is somebody else's table
 * by then - which is why `mirrorToElectedSystem` refuses to push a note that is
 * not `aiUsable`, and why that refusal is the real control rather than this.
 */
export async function promptSafeNotes(args: {
  tenantId: string;
  contactId: string;
  personId?: string | null;
  limit?: number;
}) {
  return (prisma as any).customerNote.findMany({
    where: {
      tenantId: args.tenantId,
      ...(args.personId
        ? { OR: [{ contactId: args.contactId }, { personId: args.personId }] }
        : { contactId: args.contactId }),
      status: "PUBLISHED",
      aiUsable: true,
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(args.limit ?? 10, 50),
    // Only what a prompt needs. Author identity and edit history are not the
    // model's business and would be tokens spent on nothing.
    select: { id: true, body: true, createdAt: true },
  });
}
