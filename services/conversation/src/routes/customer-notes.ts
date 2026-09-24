/**
 * Customer notes: the CRUD the stub only pretended to have.
 *
 * Mounted under `/api/identity`, beside the timeline and insights, because the
 * subject is a CONTACT. The stub these replace was keyed on a conversation,
 * which is the wrong subject - a note is about a person, and the person
 * outlives the thread.
 *
 *   GET    /:contactId/notes
 *   POST   /:contactId/notes
 *   PATCH  /:contactId/notes/:noteId
 *   DELETE /:contactId/notes/:noteId
 *   POST   /:contactId/notes/:noteId/accept | /reject
 *
 * The write path mirrors to the elected system AFTER the local row exists, and
 * the response carries the real sync outcome rather than an optimistic one. See
 * `customer-notes.service.ts` for why it mirrors rather than routes.
 */
import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";
import {
  listNotes, createNote, updateNote, deleteNote, decideSuggestion,
  mirrorToElectedSystem, NoteError, type NoteVisibility, type NoteAuthor,
} from "../services/customer-notes.service";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

/**
 * The surviving contact and its cross-channel identity.
 *
 * Follows the soft-merge pointer, so a note written against a merged-away
 * contact is filed under the person who survived rather than onto a ghost.
 */
async function resolveContact(tenantId: string, contactId: string) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId },
    select: { id: true, mergedIntoId: true, personId: true },
  });
  if (!contact) return null;
  if (!contact.mergedIntoId) return contact;
  return prisma.contact.findFirst({
    where: { id: contact.mergedIntoId, tenantId },
    select: { id: true, mergedIntoId: true, personId: true },
  });
}

/**
 * Who is writing, by name.
 *
 * The display name is denormalised onto the note because a user row can be
 * deleted and an unattributable note is worth less than no note. Falls back to
 * the id rather than to "Unknown", which would read as a note nobody wrote.
 */
async function author(req: Request): Promise<NoteAuthor> {
  const userId = (req as any).user?.userId ?? null;
  if (!userId || userId === "system") return { userId: null, name: "GOTCHA AI" };
  const user = await prisma.user.findFirst({
    where: { id: userId },
    // `name` and `email` are the per-tenant display mirror of Identity; there
    // are no firstName/lastName columns on User.
    select: { name: true, email: true },
  });
  const name = user?.name?.trim() || user?.email || userId;
  return { userId, name };
}

function fail(res: Response, err: any) {
  if (err instanceof NoteError) return res.status(err.status).json({ error: err.code });
  console.error("[customer-notes]", err?.message ?? err);
  return res.status(500).json({ error: "notes_failed" });
}

const asVisibility = (v: unknown): NoteVisibility | undefined =>
  v === "PRIVATE" || v === "TEAM" ? v : undefined;

const asMentions = (m: unknown): string[] | undefined =>
  Array.isArray(m) ? m.filter((x): x is string => typeof x === "string") : undefined;

router.get("/:contactId/notes", async (req: Request, res: Response) => {
  try {
    const contact = await resolveContact(req.tenantId!, String(req.params.contactId));
    if (!contact) return res.status(404).json({ error: "contact_not_found" });

    const notes = await listNotes({
      tenantId: req.tenantId!,
      contactId: contact.id,
      personId: contact.personId,
      viewerUserId: (req as any).user?.userId ?? null,
      includeSuggestions: String(req.query.includeSuggestions ?? "") === "true",
      includeDeleted: String(req.query.includeDeleted ?? "") === "true",
    });

    return res.json({ notes, contactId: contact.id });
  } catch (err) {
    return fail(res, err);
  }
});

router.post("/:contactId/notes", async (req: Request, res: Response) => {
  try {
    const contact = await resolveContact(req.tenantId!, String(req.params.contactId));
    if (!contact) return res.status(404).json({ error: "contact_not_found" });

    const body = typeof req.body?.body === "string" ? req.body.body : "";
    const visibility = asVisibility(req.body?.visibility) ?? "TEAM";
    const status = req.body?.status === "AI_SUGGESTED" ? "AI_SUGGESTED" as const : "PUBLISHED" as const;

    const note = await createNote({
      tenantId: req.tenantId!,
      contactId: contact.id,
      personId: contact.personId,
      conversationId: typeof req.body?.conversationId === "string" ? req.body.conversationId : null,
      body,
      visibility,
      mentions: asMentions(req.body?.mentions),
      status,
      author: await author(req),
    });

    // Mirrored only once it is a real note. A suggestion nobody has accepted
    // must not appear in the merchant's CRM.
    if (status === "PUBLISHED") {
      await mirrorToElectedSystem({
        tenantId: req.tenantId!,
        noteId: note.id,
        conversationId: note.conversationId,
        body: note.body,
        visibility,
        authHeader: req.headers.authorization,
      });
    }

    // Re-read so the response carries the REAL sync outcome. Returning the row
    // as created would report NOT_APPLICABLE for a mirror that has since
    // succeeded or failed - the same defect as the stub answering 200.
    const saved = await (prisma as any).customerNote.findFirst({ where: { id: note.id } });
    return res.status(201).json({ note: saved });
  } catch (err) {
    return fail(res, err);
  }
});

router.patch("/:contactId/notes/:noteId", async (req: Request, res: Response) => {
  try {
    const note = await updateNote({
      tenantId: req.tenantId!,
      noteId: String(req.params.noteId),
      editor: await author(req),
      body: typeof req.body?.body === "string" ? req.body.body : undefined,
      visibility: asVisibility(req.body?.visibility),
      mentions: asMentions(req.body?.mentions),
    });
    return res.json({ note });
  } catch (err) {
    return fail(res, err);
  }
});

router.delete("/:contactId/notes/:noteId", async (req: Request, res: Response) => {
  try {
    const note = await deleteNote(
      req.tenantId!,
      String(req.params.noteId),
      (req as any).user?.userId ?? null,
    );
    // Soft-deleted, and the response says so rather than 204-ing as if the row
    // were gone.
    return res.json({ note: { id: note.id, deletedAt: note.deletedAt } });
  } catch (err) {
    return fail(res, err);
  }
});

for (const decision of ["accept", "reject"] as const) {
  router.post(`/:contactId/notes/:noteId/${decision}`, async (req: Request, res: Response) => {
    try {
      const note = await decideSuggestion(
        req.tenantId!,
        String(req.params.noteId),
        decision,
        await author(req),
      );

      if (decision === "accept" && note.visibility === "TEAM") {
        await mirrorToElectedSystem({
          tenantId: req.tenantId!,
          noteId: note.id,
          conversationId: note.conversationId,
          body: note.body,
          visibility: note.visibility,
          authHeader: req.headers.authorization,
        });
      }

      const saved = await (prisma as any).customerNote.findFirst({ where: { id: note.id } });
      return res.json({ note: saved });
    } catch (err) {
      return fail(res, err);
    }
  });
}

export default router;
