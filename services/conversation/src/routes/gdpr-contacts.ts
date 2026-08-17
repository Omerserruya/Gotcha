import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireRole,
  writeAudit,
  AuditAction,
  withHistoricalRecords,
} from "@chatcenter/shared";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"));

// ─── Helpers ─────────────────────────────────────────────────
// Resolve the full set of contact ids/externalIds that represent the same
// person as the given contact (i.e. all rows sharing its personId, or just
// itself when personId is not set).
async function resolveContactFamily<T extends { id: string; personId: string | null }>(
  tenantId: string,
  contact: T,
): Promise<T[]> {
  if (!contact.personId) {
    return [contact];
  }
  const family = await prisma.contact.findMany({
    where: { tenantId, personId: contact.personId },
  });
  return family.length > 0 ? (family as unknown as T[]) : [contact];
}

// GET /:id/export - Right of access/portability (Art. 15/20)
router.get("/:id/export", async (req: Request, res: Response) => {
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    const family = await resolveContactFamily(req.tenantId!, contact);
    const contactIds = family.map((c) => c.id);
    const externalIds = Array.from(new Set(family.map((c) => c.externalId)));

    // Imported history is the subject's data too.
    //
    // `prisma` narrows Conversation and Message to live rows by default, which
    // is right for every product surface and WRONG here: a subject-access
    // request that silently returned half of somebody's conversations, with no
    // indication the other half existed, would be a compliance failure of
    // exactly the kind Article 15 exists to prevent.
    const { conversations, messages } = await withHistoricalRecords(async () => {
      const convos = await prisma.conversation.findMany({
        where: {
          tenantId: req.tenantId!,
          customerExternalId: { in: externalIds },
        },
      });
      const ids = convos.map((c) => c.id);
      const msgs = ids.length
        ? await prisma.message.findMany({
            where: { tenantId: req.tenantId!, conversationId: { in: ids } },
          })
        : [];
      return { conversations: convos, messages: msgs };
    });

    const consents = await prisma.consentRecord.findMany({
      where: { tenantId: req.tenantId!, subjectType: "contact", subjectId: { in: contactIds } },
      orderBy: { createdAt: "desc" },
    });

    const counts = {
      contacts: family.length,
      conversations: conversations.length,
      messages: messages.length,
      consents: consents.length,
    };

    await prisma.dataSubjectRequest.create({
      data: {
        tenantId: req.tenantId!,
        requestType: "export",
        subjectType: "contact",
        subjectId: req.params.id as string,
        status: "COMPLETED",
        requestedBy: req.user!.userId,
        result: counts,
        completedAt: new Date(),
      },
    });

    await writeAudit({
      tenantId: req.tenantId!,
      actorType: "user",
      actorId: req.user!.userId,
      action: AuditAction.DSR_EXPORT_COMPLETED,
      targetType: "contact",
      targetId: req.params.id as string,
      metadata: counts,
    });

    const exportDoc = {
      exportedAt: new Date().toISOString(),
      subject: contact,
      contacts: family,
      conversations,
      messages,
      consents,
    };

    res.setHeader("Content-Disposition", `attachment; filename="contact-${req.params.id}-export.json"`);
    res.json(exportDoc);
  } catch (err) {
    console.error("GDPR export error:", err);
    res.status(500).json({ error: "Failed to export contact data" });
  }
});

// DELETE /:id - Right to erasure (Art. 17)
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    const family = await resolveContactFamily(req.tenantId!, contact);
    const familyIds = family.map((c) => c.id);
    const externalIds = Array.from(new Set(family.map((c) => c.externalId)));

    // Include any rows that were soft-merged INTO one of these contacts so
    // no orphan ghost rows remain after the person's rows are deleted.
    const mergedInRows = await prisma.contact.findMany({
      where: { tenantId: req.tenantId!, mergedIntoId: { in: familyIds } },
    });
    const allContactIds = Array.from(new Set([...familyIds, ...mergedInRows.map((c) => c.id)]));

    // Erasure must reach imported history as well.
    //
    // The live-by-default filter is deliberately suspended for both the lookup
    // and the deletes: an erasure that removed the live conversations and left
    // 180 days of imported ones behind would report success while the person's
    // data was still there - the worst possible outcome for this endpoint,
    // because nothing would ever surface the remainder.
    //
    // Deleting the conversations also removes the historical_customers rows
    // that point at them and the candidate evidence beneath, by cascade.
    const counts = await withHistoricalRecords(async () => {
      const conversations = await prisma.conversation.findMany({
        where: { tenantId: req.tenantId!, customerExternalId: { in: externalIds } },
      });
      const conversationIds = conversations.map((c) => c.id);

      return prisma.$transaction(async (tx) => {
        const deletedMessages = conversationIds.length
          ? await tx.message.deleteMany({
              where: { tenantId: req.tenantId!, conversationId: { in: conversationIds } },
            })
          : { count: 0 };

        const deletedConversations = conversationIds.length
          ? await tx.conversation.deleteMany({
              where: { tenantId: req.tenantId!, id: { in: conversationIds } },
            })
          : { count: 0 };

        const deletedConsents = await tx.consentRecord.deleteMany({
          where: { tenantId: req.tenantId!, subjectType: "contact", subjectId: { in: allContactIds } },
        });

        const deletedContacts = await tx.contact.deleteMany({
          where: { tenantId: req.tenantId!, id: { in: allContactIds } },
        });

        // Everything the import learned ABOUT this person, which lives outside
        // the message tables and would otherwise survive their erasure.
        const deletedMemory = await tx.customerHistoricalMemory.deleteMany({
          where: { tenantId: req.tenantId!, customerExternalId: { in: externalIds } },
        });

        return {
          messages: deletedMessages.count,
          conversations: deletedConversations.count,
          consents: deletedConsents.count,
          contacts: deletedContacts.count,
          historicalMemory: deletedMemory.count,
        };
      });
    });

    await prisma.dataSubjectRequest.create({
      data: {
        tenantId: req.tenantId!,
        requestType: "erasure",
        subjectType: "contact",
        subjectId: req.params.id as string,
        status: "COMPLETED",
        requestedBy: req.user!.userId,
        result: counts,
        completedAt: new Date(),
      },
    });

    await writeAudit({
      tenantId: req.tenantId!,
      actorType: "user",
      actorId: req.user!.userId,
      action: AuditAction.DSR_ERASURE_COMPLETED,
      targetType: "contact",
      targetId: req.params.id as string,
      metadata: counts,
    });

    res.json({ deleted: true, counts });
  } catch (err) {
    console.error("GDPR erasure error:", err);
    res.status(500).json({ error: "Failed to erase contact data" });
  }
});

// POST /:id/consent - record consent (Art. 7 proof)
router.post("/:id/consent", async (req: Request, res: Response) => {
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    const { purpose, granted, source, evidence } = req.body;
    if (typeof purpose !== "string" || purpose.trim().length === 0) {
      res.status(400).json({ error: "purpose is required" });
      return;
    }
    if (typeof granted !== "boolean") {
      res.status(400).json({ error: "granted must be a boolean" });
      return;
    }

    const record = await prisma.consentRecord.create({
      data: {
        tenantId: req.tenantId!,
        subjectType: "contact",
        subjectId: req.params.id as string,
        purpose,
        granted,
        source: source ?? null,
        evidence: evidence ?? undefined,
      },
    });

    await writeAudit({
      tenantId: req.tenantId!,
      actorType: "user",
      actorId: req.user!.userId,
      action: granted ? AuditAction.CONSENT_GRANTED : AuditAction.CONSENT_WITHDRAWN,
      targetType: "contact",
      targetId: req.params.id as string,
      metadata: { purpose, source: source ?? null },
    });

    res.status(201).json({ data: record });
  } catch (err) {
    console.error("Record consent error:", err);
    res.status(500).json({ error: "Failed to record consent" });
  }
});

// GET /:id/consent - list consent records for the contact
router.get("/:id/consent", async (req: Request, res: Response) => {
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    const records = await prisma.consentRecord.findMany({
      where: { tenantId: req.tenantId!, subjectType: "contact", subjectId: req.params.id as string },
      orderBy: { createdAt: "desc" },
    });

    res.json({ data: records });
  } catch (err) {
    console.error("List consent error:", err);
    res.status(500).json({ error: "Failed to list consent records" });
  }
});

export default router;
