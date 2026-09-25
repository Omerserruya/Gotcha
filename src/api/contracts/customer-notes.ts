import { z } from 'zod';

/**
 * Screen 04f — what your team wrote about this person.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CONTACT-KEYED, WHICH IS THE WHOLE REASON THE STUB WAS REPLACED
 * ════════════════════════════════════════════════════════════════════════════
 *   GET    /api/identity/:contactId/notes
 *   POST   /api/identity/:contactId/notes
 *   PATCH  /api/identity/:contactId/notes/:noteId
 *   DELETE /api/identity/:contactId/notes/:noteId
 *
 * The route's own header: the stub these replace *"was keyed on a
 * conversation, which is the wrong subject — a note is about a person, and
 * the person outlives the thread."* So `readKeyFor` is NOT used here, and the
 * write prohibition recorded in `conversation-key.ts` does not apply: there
 * is no conversation in the key at all.
 *
 * ── THE LIST ANSWERS `{ notes, contactId }` — NO ENVELOPE ──
 * Checked, not assumed. There is no top-level `data`, so the transport
 * passes the body through and **`raw: true` is neither needed nor correct**.
 * The two sibling-`data` bugs found today were the opposite case.
 *
 * ── AND THE ROUTER HAS NO PERMISSION GATE ──
 * `authenticate, resolveTenant, requireActiveTenant()` and nothing else.
 * Anyone in the tenant who can reach the screen can read and write notes.
 * Recorded because building permission handling for a gate that is not there
 * would be inventing a rule, the same correction 04e needed pointing the
 * other way.
 */

/* ── The two axes, which are NOT the same question ───────────────────────── */

/**
 * WHO MAY READ IT. The schema's own words: *"Orthogonal to `aiUsable`, and
 * conflating the two is a bug either way round: a note can be readable by the
 * whole team and still be something the bot must never repeat to a customer."*
 *
 * `PRIVATE` is the author's alone, enforced as a WHERE clause rather than a
 * filter — so this screen never receives somebody else's private note.
 */
export const NOTE_VISIBILITIES = ['TEAM', 'PRIVATE'] as const;
export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];

/**
 * Read from the enum, not from a grep: **three**, not two.
 *
 * `REJECTED` is a suggestion a person declined, kept so the AI stops
 * re-proposing it. 04f asks for none of the suggestion flow, so this screen
 * requests only `PUBLISHED` — but the domain is named in full, because a
 * `z.enum` missing one member rejects the whole response.
 */
export const NOTE_STATUSES = ['PUBLISHED', 'AI_SUGGESTED', 'REJECTED'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/** `CustomerNoteSyncStatus`, read from the enum. Four. */
export const NOTE_SYNC_STATUSES = ['NOT_APPLICABLE', 'PENDING', 'SYNCED', 'FAILED'] as const;
export type NoteSyncStatus = (typeof NOTE_SYNC_STATUSES)[number];

export const noteSchema = z.object({
  id: z.string(),
  body: z.string(),
  visibility: z.enum(NOTE_VISIBILITIES).default('TEAM'),
  /**
   * ★ MAY THE AI'S PROMPT INCLUDE IT. Default false on the column, and
   * default false here for the same reason: *"a note is prompt-unsafe until
   * somebody says otherwise."*
   *
   * It is also the only thing that decides whether the note leaves our
   * database — see `destinationOf`.
   */
  aiUsable: z.boolean().default(false),
  status: z.enum(NOTE_STATUSES).default('PUBLISHED'),
  /**
   * Null when the AI wrote it. **This is the edit and delete gate**:
   * `requireOwnEditable` compares it against the caller's user id and throws
   * `not_the_author` otherwise, so the screen must compare the same two
   * values or it will offer a control that 403s.
   */
  authorUserId: z.string().nullable().default(null),
  /**
   * Denormalised on purpose: *"a user row can be deleted, and an
   * unattributable note is worth less than no note."* Required — a note with
   * no author name is not a note this screen can render.
   */
  authorName: z.string(),
  conversationId: z.string().nullable().default(null),
  /** Append-only. 04f shows THAT it was edited, never the previous bodies. */
  editHistory: z.array(z.unknown()).default([]),
  externalSystem: z.string().nullable().default(null),
  externalSyncStatus: z.enum(NOTE_SYNC_STATUSES).default('NOT_APPLICABLE'),
  /** The provider's own words when it refused. *"Shown, not just logged."* */
  externalSyncError: z.string().nullable().default(null),
  externalSyncedAt: z.string().nullable().default(null),
  deletedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Note = z.infer<typeof noteSchema>;

/**
 * `GET` answers `{ notes, contactId }`.
 *
 * Both required. An absent `notes` defaulting to `[]` would render *"nobody
 * has written anything about this person"* from a response that said nothing
 * — the `customerAuditSchema` defect, and this screen makes the same claim.
 */
export const noteListSchema = z.object({
  notes: z.array(noteSchema),
  contactId: z.string(),
});
export type NoteList = z.infer<typeof noteListSchema>;

/** `POST` and `PATCH` answer `{ note }` — the whole row. */
export const noteWriteSchema = z.object({ note: noteSchema });

/**
 * `DELETE` answers `{ note: { id, deletedAt } }` and nothing else.
 *
 * ★ ITS OWN SCHEMA, because `noteWriteSchema` would reject this body: the
 * full note requires `body`, `authorName` and `createdAt`, and the delete
 * response carries none of them. Reusing it with `.partial()` would not have
 * helped either — that makes `note` optional, not its contents.
 *
 * `deletedAt` is required and non-null: the route soft-deletes and *"says so
 * rather than 204-ing as if the row were gone"*, so a response without a
 * timestamp is not a delete we can report as done.
 */
export const noteDeleteSchema = z.object({
  note: z.object({ id: z.string(), deletedAt: z.string() }),
});

/* ── Where the note actually lives ───────────────────────────────────────── */

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ SEVEN OUTCOMES, AND THE SCREEN READS THE SERVER'S VERDICT FOR ALL OF THEM
 * ════════════════════════════════════════════════════════════════════════════
 * A note may be mirrored into the merchant's own CRM, and the merchant has to
 * be told which. `NOT_APPLICABLE` alone cannot say — the route reaches it by
 * **five different paths**, each a different sentence and two of them a
 * different repair:
 *
 *   private          the note is PRIVATE, and *"a private note in the
 *                    merchant's shared CRM is not private"*
 *   not_ai_usable    not marked for the AI, and the push is the ONLY
 *                    chokepoint — see the note below
 *   null             no conversation to resolve a CRM contact from, or no
 *                    forwarded authorization. Indistinguishable on the wire,
 *                    and the same fact to a merchant: nothing to push through
 *   no_crm_configured   no CRM is connected
 *   no_crm_link      a CRM IS connected and THIS PERSON is not linked to a
 *                    record in it
 *
 * ★ THE LAST TWO ARE THE DISTINCTION THIS PROJECT HAS MADE ON FIVE SCREENS.
 * Telling somebody to connect a CRM they already connected is the 14c/04d
 * mistake exactly, and collapsing these two would make it for a sixth time.
 *
 * ── AND THE VERDICT IS READ, NEVER RE-DERIVED ──
 * The obvious shortcut is to compute this from the `aiUsable` toggle we just
 * sent. That is wrong for the reason 04d renders the provider's own chips:
 * the server has five reasons and we know one of them, so a locally derived
 * sentence would confidently say "not marked for the AI" about a note that
 * was actually refused by HubSpot. **The screen says what came back.**
 */
export type NoteDestination =
  | 'synced'
  | 'pending'
  | 'failed'
  | 'private'
  | 'not_ai_usable'
  | 'no_crm'
  | 'not_linked'
  | 'nothing_to_push';

export function destinationOf(note: Note): NoteDestination {
  switch (note.externalSyncStatus) {
    case 'SYNCED':
      return 'synced';
    /*
     * ★ A REAL OBSERVABLE STATE, NOT A TRANSIENT TO IGNORE.
     *
     * `PENDING` is written before the fetch. A reader can see it mid-push —
     * and if the process died between the two writes it stays PENDING for
     * good. Either way we do not know where the note is, and that is the
     * honest sentence rather than guessing at the more likely one.
     */
    case 'PENDING':
      return 'pending';
    case 'FAILED':
      return 'failed';
    default:
      break;
  }
  switch (note.externalSyncError) {
    case 'private':
      return 'private';
    case 'not_ai_usable':
      return 'not_ai_usable';
    case 'no_crm_configured':
      return 'no_crm';
    case 'no_crm_link':
      return 'not_linked';
    default:
      return 'nothing_to_push';
  }
}

/**
 * Did the push fail in a way somebody must see?
 *
 * ★ *"never render a failed push as saved"* — the lesson of the stub that
 * answered 200 and persisted nothing. `FAILED` means there WAS a target and
 * it refused, which is different from every `NOT_APPLICABLE` reason and is
 * the one the merchant may need to act on.
 */
export function pushFailed(note: Note): boolean {
  return note.externalSyncStatus === 'FAILED';
}

/**
 * May this viewer edit or delete it?
 *
 * Mirrors `requireOwnEditable` exactly: the author only, and not once it is
 * deleted. *"Letting anyone else rewrite it would make `authorName` a claim
 * about somebody who did not write what it now says."*
 *
 * `viewerUserId` is `User.id` from `/api/auth/me` — the same id the route
 * compares against. **Not the session's `sub`**, which is the Authentik
 * subject and would never match.
 */
export function canEdit(note: Note, viewerUserId: string | null): boolean {
  if (!viewerUserId || note.deletedAt) return false;
  return note.authorUserId === viewerUserId;
}

/** Edited after it was written, so the body is not what was first said. */
export function wasEdited(note: Note): boolean {
  return note.editHistory.length > 0;
}

/** `NOTE_MAX_LENGTH` in the service. Enforced here so a 400 is not the UI. */
export const NOTE_MAX_LENGTH = 5000;
