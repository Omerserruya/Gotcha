import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant,
  requirePermissionOrRole,
  withHistoricalRecords,
  historicalImportStage,
  historicalImportPercent,
  historicalAnalysisCounts,
  hasHistoricalResults,
  HISTORICAL_SOURCE_WINDOW_DAYS,
  writeAudit,
  AuditAction,
  normalizePhone,
  type HistoricalImportStatus,
} from "@chatcenter/shared";
import { processDocument } from "../services/embedding.service";
import { findExistingKnowledge } from "../services/historical-intelligence/candidate-index";
import { BULK_APPROVE_MIN_CONFIDENCE } from "../services/historical-intelligence/knowledge-clustering.stage";
import { rerunIntelligence } from "../services/historical-intelligence";

/**
 * The read and review surface for Historical Intelligence Import.
 *
 * Three audiences, one router:
 *   * the channel card, which polls status;
 *   * the results page, which reads the persisted summary;
 *   * the review queue, where the owner approves, edits or rejects.
 *
 * Every number returned here comes from the import's persisted summary or from
 * a count of rows. Nothing is recomputed per request, so the channel card, the
 * results page and the completion email cannot disagree about how many messages
 * were analyzed.
 */

const router = Router();

router.use(
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  requirePermissionOrRole("ai:knowledge:read", "ADMIN"),
);

// ─── Status ──────────────────────────────────────────────────

/**
 * GET /api/historical-imports
 *
 * The channel card's poll. Deliberately small and cheap: it runs every few
 * seconds while an import is in flight, and it must stay a single indexed read.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const imports = await prisma.historicalImport.findMany({
      where: { tenantId: req.tenantId! },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    res.json({ imports: imports.map(toStatusView) });
  } catch (err: any) {
    console.error("[historical-import] list failed:", err?.message);
    res.status(500).json({ error: "Failed to load import status" });
  }
});

/** GET /api/historical-imports/:id - status plus the full persisted summary. */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const row = await prisma.historicalImport.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });
    if (!row) {
      res.status(404).json({ error: "Import not found" });
      return;
    }
    res.json({
      ...toStatusView(row),
      summary: row.summary ?? null,
      topTopics: row.topTopics ?? [],
    });
  } catch (err: any) {
    console.error("[historical-import] get failed:", err?.message);
    res.status(500).json({ error: "Failed to load import" });
  }
});

/**
 * GET /api/historical-imports/:id/events
 *
 * The operator's view of what happened, for debugging a real customer's import.
 * Counts and safe metadata only - the event rows never contain message bodies.
 */
router.get("/:id/events", async (req: Request, res: Response) => {
  try {
    const row = await prisma.historicalImport.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
      select: { id: true },
    });
    if (!row) {
      res.status(404).json({ error: "Import not found" });
      return;
    }
    const events = await prisma.historicalImportEvent.findMany({
      where: { importId: row.id },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ events });
  } catch (err: any) {
    console.error("[historical-import] events failed:", err?.message);
    res.status(500).json({ error: "Failed to load events" });
  }
});

// ─── Knowledge review ────────────────────────────────────────

/**
 * GET /api/historical-imports/:id/candidates
 *
 * The review queue. Evidence is included but capped: the reviewer needs two or
 * three examples to judge a suggestion, not the two hundred conversations
 * behind it. The full count is reported so the card can say "found in 126
 * conversations" truthfully while showing three.
 */
router.get("/:id/candidates", async (req: Request, res: Response) => {
  try {
    const status = String(req.query.status ?? "PENDING").toUpperCase();
    const allowed = new Set(["PENDING", "APPROVED", "REJECTED", "SUPERSEDED"]);
    if (!allowed.has(status)) {
      res.status(400).json({ error: "Unknown status filter" });
      return;
    }

    const candidates = await prisma.knowledgeCandidate.findMany({
      where: {
        tenantId: req.tenantId!,
        importId: req.params.id as string,
        status: status as any,
      },
      orderBy: [{ conflict: "desc" }, { confidence: "desc" }, { occurrenceCount: "desc" }],
      take: 200,
      include: {
        evidence: {
          where: { representative: true },
          take: 3,
          orderBy: { occurredAt: "desc" },
        },
        duplicateOf: { select: { id: true, title: true } },
      },
    });

    const counts = await prisma.knowledgeCandidate.groupBy({
      by: ["status"],
      where: { tenantId: req.tenantId!, importId: req.params.id as string },
      _count: { _all: true },
    });

    res.json({
      candidates: candidates.map((c) => ({
        id: c.id,
        topic: c.topic,
        question: c.question,
        answer: c.editedAnswer ?? c.answer,
        originalAnswer: c.answer,
        status: c.status,
        confidence: c.confidence,
        // The label the UI shows. "High" here means only that we observed this
        // consistently, and the UI says so in words next to it.
        confidenceLabel: confidenceLabel(c.confidence),
        occurrenceCount: c.occurrenceCount,
        customerCount: c.customerCount,
        conflict: c.conflict,
        variants: c.conflict ? c.variants : null,
        alreadyCoveredBy: c.duplicateOf ? { id: c.duplicateOf.id, title: c.duplicateOf.title } : null,
        firstSeenAt: c.firstSeenAt,
        lastSeenAt: c.lastSeenAt,
        examples: c.evidence.map((e) => ({
          question: e.questionText,
          answer: e.answerText,
          occurredAt: e.occurredAt,
          variantKey: e.variantKey,
        })),
        // Conflicted and low-confidence items are never sweepable. Stated by
        // the API rather than only by the UI, so the bulk endpoint and the
        // button can never disagree about what "safe" means.
        bulkApprovable: !c.conflict && c.confidence >= BULK_APPROVE_MIN_CONFIDENCE,
      })),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      bulkApproveMinConfidence: BULK_APPROVE_MIN_CONFIDENCE,
    });
  } catch (err: any) {
    console.error("[historical-import] candidates failed:", err?.message);
    res.status(500).json({ error: "Failed to load suggestions" });
  }
});

/**
 * GET /api/historical-imports/candidates/:candidateId/evidence
 *
 * Every conversation behind one suggestion, for the reviewer who wants to check
 * rather than trust. Capped, and scoped to the tenant like everything else.
 */
router.get("/candidates/:candidateId/evidence", async (req: Request, res: Response) => {
  try {
    const candidate = await prisma.knowledgeCandidate.findFirst({
      where: { id: req.params.candidateId as string, tenantId: req.tenantId! },
      select: { id: true },
    });
    if (!candidate) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }
    const evidence = await prisma.knowledgeCandidateEvidence.findMany({
      where: { candidateId: candidate.id, tenantId: req.tenantId! },
      orderBy: { occurredAt: "desc" },
      take: 50,
    });
    res.json({
      evidence: evidence.map((e) => ({
        question: e.questionText,
        answer: e.answerText,
        occurredAt: e.occurredAt,
        variantKey: e.variantKey,
        conversationId: e.conversationId,
      })),
    });
  } catch (err: any) {
    console.error("[historical-import] evidence failed:", err?.message);
    res.status(500).json({ error: "Failed to load examples" });
  }
});

const writeGuard = requirePermissionOrRole("ai:knowledge:write", "ADMIN");

/**
 * POST /api/historical-imports/candidates/:candidateId/approve
 *
 * The only path from a suggestion into production knowledge, and it requires a
 * human on the other end of it. The body may carry an edited answer, which is
 * stored separately from the observed one so the original stays auditable.
 */
router.post("/candidates/:candidateId/approve", writeGuard, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const candidate = await prisma.knowledgeCandidate.findFirst({
      where: { id: req.params.candidateId as string, tenantId },
    });
    if (!candidate) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }
    if (candidate.status === "APPROVED") {
      // Idempotent: a double-clicked approve returns the document it already
      // made rather than creating a second copy of the same knowledge.
      res.json({ ok: true, documentId: candidate.approvedDocumentId, alreadyApproved: true });
      return;
    }

    const editedAnswer =
      typeof req.body?.answer === "string" && req.body.answer.trim().length > 0
        ? String(req.body.answer).trim().slice(0, 4000)
        : null;
    const finalAnswer = editedAnswer ?? candidate.answer;
    const questionOverride =
      typeof req.body?.question === "string" && req.body.question.trim().length > 0
        ? String(req.body.question).trim().slice(0, 500)
        : candidate.question;

    // A conflicted suggestion cannot be approved as it stands. There is no
    // "the" answer to approve - that is what conflicted means - so the owner
    // has to say which one is right, and the API refuses rather than silently
    // enshrining whichever variant happened to be most common.
    if (candidate.conflict && !editedAnswer) {
      res.status(400).json({
        error: "conflict_requires_answer",
        message:
          "This suggestion has more than one observed answer. Choose or write the correct one before approving.",
      });
      return;
    }

    const target = await resolveTargetKnowledgeBase(tenantId, req.body?.knowledgeBaseId);
    if (!target) {
      res.status(400).json({
        error: "no_knowledge_base",
        message: "Create a knowledge base before approving suggestions into it.",
      });
      return;
    }

    // The duplicate check runs AGAIN here, not only at clustering time. A
    // document can be added by hand in between, and approving into a knowledge
    // base that already answers this question is how it starts contradicting
    // itself.
    const existing = await findExistingKnowledge({
      tenantId,
      question: questionOverride,
      answer: finalAnswer,
    });
    if (existing && !req.body?.force) {
      await prisma.knowledgeCandidate.updateMany({
        where: { id: candidate.id, tenantId },
        data: { duplicateOfDocumentId: existing.documentId },
      });
      res.status(409).json({
        error: "already_covered",
        message: "Your knowledge base already answers this.",
        existing: { documentId: existing.documentId, title: existing.title },
      });
      return;
    }

    const document = await prisma.knowledgeDocument.create({
      data: {
        knowledgeBaseId: target.id,
        tenantId,
        title: questionOverride.slice(0, 200),
        content: `${questionOverride}\n\n${finalAnswer}`,
        sourceType: "historical_conversations",
        status: "pending",
        // Provenance travels with the document. Months later, "where did this
        // policy come from" has an answer, and a wrong one can be traced to the
        // conversations that produced it.
        metadata: {
          origin: "historical_import",
          sourceType: "historical_conversations",
          topic: candidate.topic,
        },
      },
    });

    await prisma.knowledgeCandidate.updateMany({
      where: { id: candidate.id, tenantId },
      data: {
        status: "APPROVED",
        editedAnswer,
        approvedDocumentId: document.id,
        decidedAt: new Date(),
        decidedBy: req.user!.userId,
      },
    });

    // Embedding is what makes the document retrievable. Awaited rather than
    // fired and forgotten, so an approval that reports success is an approval
    // the AI can actually use.
    try {
      await processDocument(document.id);
    } catch (err: any) {
      console.error(`[historical-import] embedding failed for ${document.id}: ${err?.message}`);
    }

    await writeAudit({
      tenantId,
      actorType: "user",
      actorId: req.user!.userId,
      action: AuditAction.KNOWLEDGE_HISTORICAL_APPROVED,
      targetType: "knowledge_document",
      targetId: document.id,
      metadata: {
        source: "historical_conversations",
        sourceProvider: "whatsapp_business_app",
        candidateId: candidate.id,
        edited: !!editedAnswer,
        occurrenceCount: candidate.occurrenceCount,
        customerCount: candidate.customerCount,
      },
    });

    res.json({ ok: true, documentId: document.id });
  } catch (err: any) {
    console.error("[historical-import] approve failed:", err?.message);
    res.status(500).json({ error: "Failed to approve suggestion" });
  }
});

/** POST /api/historical-imports/candidates/:candidateId/reject */
router.post("/candidates/:candidateId/reject", writeGuard, async (req: Request, res: Response) => {
  try {
    const updated = await prisma.knowledgeCandidate.updateMany({
      where: { id: req.params.candidateId as string, tenantId: req.tenantId!, status: "PENDING" },
      data: {
        status: "REJECTED",
        decidedAt: new Date(),
        decidedBy: req.user!.userId,
      },
    });
    if (updated.count === 0) {
      res.status(404).json({ error: "Suggestion not found or already decided" });
      return;
    }
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[historical-import] reject failed:", err?.message);
    res.status(500).json({ error: "Failed to reject suggestion" });
  }
});

/**
 * POST /api/historical-imports/:id/bulk-approve
 *
 * Only ever touches items the API itself classified as safe: no conflicts, and
 * confidence at or above the shared threshold. The set is recomputed
 * server-side rather than taken from the client, so a stale page cannot sweep
 * in a candidate that has since been flagged.
 */
router.post("/:id/bulk-approve", writeGuard, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const eligible = await prisma.knowledgeCandidate.findMany({
      where: {
        tenantId,
        importId: req.params.id as string,
        status: "PENDING",
        conflict: false,
        confidence: { gte: BULK_APPROVE_MIN_CONFIDENCE },
      },
      select: { id: true },
      take: 100,
    });

    const results: Array<{ id: string; ok: boolean; reason?: string }> = [];
    for (const candidate of eligible) {
      try {
        const r = await approveOne(tenantId, candidate.id, req.user!.userId);
        results.push({ id: candidate.id, ok: r.ok, reason: r.reason });
      } catch (err: any) {
        results.push({ id: candidate.id, ok: false, reason: err?.message ?? "failed" });
      }
    }

    res.json({
      approved: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => !r.ok).length,
      results,
    });
  } catch (err: any) {
    console.error("[historical-import] bulk approve failed:", err?.message);
    res.status(500).json({ error: "Failed to approve suggestions" });
  }
});

/** POST /api/historical-imports/:id/bulk-reject */
router.post("/:id/bulk-reject", writeGuard, async (req: Request, res: Response) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : [];
    const updated = await prisma.knowledgeCandidate.updateMany({
      where: {
        tenantId: req.tenantId!,
        importId: req.params.id as string,
        status: "PENDING",
        ...(ids.length > 0 ? { id: { in: ids } } : {}),
      },
      data: { status: "REJECTED", decidedAt: new Date(), decidedBy: req.user!.userId },
    });
    res.json({ rejected: updated.count });
  } catch (err: any) {
    console.error("[historical-import] bulk reject failed:", err?.message);
    res.status(500).json({ error: "Failed to reject suggestions" });
  }
});

/**
 * POST /api/historical-imports/:id/rerun-intelligence
 *
 * Wipe the derived artifacts (memories, candidates, vectors) and run the
 * intelligence stages again over the already-imported conversations. For when
 * the analysis was wrong but the data is fine - the imported messages are the
 * one thing Meta will never send twice, and they are untouched.
 */
router.post("/:id/rerun-intelligence", writeGuard, async (req: Request, res: Response) => {
  try {
    const result = await rerunIntelligence({
      tenantId: req.tenantId!,
      importId: req.params.id as string,
    });
    if (!result.ok) return res.status(409).json({ error: result.reason });
    res.json(result);
  } catch (err: any) {
    console.error("[historical-import] rerun failed:", err?.message);
    res.status(500).json({ error: "Failed to rerun analysis" });
  }
});

/**
 * GET /api/historical-imports/customer-context?externalId=<phone>
 *
 * What we learned about THIS person, for the live inbox - keyed by the
 * customer's own identifier rather than an import-internal id.
 *
 * The import already produced this (a summary and durable facts per customer)
 * but only the AI could see it: the memory went into the bot prompt and
 * nowhere else, so a human agent opening the same chat saw nothing and the
 * import looked like it had done nothing. This is the endpoint the
 * conversation panel reads.
 */
router.get("/customer-context", async (req: Request, res: Response) => {
  try {
    const raw = String(req.query.externalId ?? "").trim();
    if (!raw) return res.json({ context: null });

    // Same both-shapes probe as the prompt block: a conversation carries
    // whatever the channel handed us, the memory row is keyed normalized.
    const normalized = normalizePhone(raw);
    const keys = Array.from(new Set([raw, normalized].filter(Boolean) as string[]));

    const memory = await prisma.customerHistoricalMemory.findFirst({
      where: { tenantId: req.tenantId!, customerExternalId: { in: keys } },
      select: { summary: true, facts: true, messageCount: true, source: true, updatedAt: true, importId: true },
    });
    if (!memory) return res.json({ context: null });

    const facts = Array.isArray(memory.facts) ? (memory.facts as Array<Record<string, unknown>>) : [];
    res.json({
      context: {
        summary: memory.summary,
        facts: facts
          .filter((f) => typeof f.text === "string" && String(f.text).trim())
          .map((f) => ({
            text: String(f.text).trim(),
            category: typeof f.category === "string" ? f.category : null,
            confidence: typeof f.confidence === "string" ? f.confidence : null,
          })),
        messageCount: memory.messageCount,
        source: memory.source,
        learnedAt: memory.updatedAt,
      },
    });
  } catch (err: any) {
    // Context is an enhancement; never let it break the panel.
    console.warn("[historical-import] customer-context failed:", err?.message);
    res.json({ context: null });
  }
});

// ─── Imported conversations ──────────────────────────────────

/**
 * GET /api/historical-imports/:id/customers
 *
 * The imported customers and what we managed to link them to. Used by the
 * results page and, more often, by an operator checking a real import.
 */
router.get("/:id/customers", async (req: Request, res: Response) => {
  try {
    const customers = await prisma.historicalCustomer.findMany({
      where: { tenantId: req.tenantId!, importId: req.params.id as string },
      orderBy: { messageCount: "desc" },
      take: 100,
      select: {
        id: true,
        externalId: true,
        normalizedPhone: true,
        displayName: true,
        contactId: true,
        conversationId: true,
        sourceOfTruthVendor: true,
        sourceOfTruthCustomerId: true,
        messageCount: true,
        inboundCount: true,
        firstMessageAt: true,
        lastMessageAt: true,
        learningStatus: true,
      },
    });
    res.json({ customers });
  } catch (err: any) {
    console.error("[historical-import] customers failed:", err?.message);
    res.status(500).json({ error: "Failed to load imported customers" });
  }
});

/**
 * GET /api/historical-imports/customers/:customerId/memory
 *
 * What GOTCHA learned about one customer. No dedicated UI for this in V1 - it
 * is here so an operator can verify that memory is durable rather than
 * transient, which is the property most worth checking on the first real
 * import.
 */
router.get("/customers/:customerId/memory", async (req: Request, res: Response) => {
  try {
    const customer = await prisma.historicalCustomer.findFirst({
      where: { id: req.params.customerId as string, tenantId: req.tenantId! },
      select: { externalId: true, normalizedPhone: true },
    });
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const memory = await prisma.customerHistoricalMemory.findFirst({
      where: {
        tenantId: req.tenantId!,
        customerExternalId: customer.normalizedPhone || customer.externalId,
      },
    });
    res.json({ memory: memory ?? null });
  } catch (err: any) {
    console.error("[historical-import] memory failed:", err?.message);
    res.status(500).json({ error: "Failed to load customer memory" });
  }
});

/**
 * GET /api/historical-imports/conversations/:conversationId/messages
 *
 * One imported thread. Explicitly opts out of the live-only default, because
 * reading imported history is the entire purpose of the endpoint.
 */
router.get("/conversations/:conversationId/messages", async (req: Request, res: Response) => {
  try {
    const result = await withHistoricalRecords(async () => {
      const conversation = await prisma.conversation.findFirst({
        where: {
          id: req.params.conversationId as string,
          tenantId: req.tenantId!,
          origin: "HISTORICAL_IMPORT",
        },
        select: { id: true, customerExternalId: true, customerName: true },
      });
      if (!conversation) return null;
      const messages = await prisma.message.findMany({
        where: { tenantId: req.tenantId!, conversationId: conversation.id },
        orderBy: { createdAt: "asc" },
        take: 500,
        select: {
          id: true,
          direction: true,
          body: true,
          messageType: true,
          createdAt: true,
        },
      });
      return { conversation, messages };
    });

    if (!result) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.json(result);
  } catch (err: any) {
    console.error("[historical-import] messages failed:", err?.message);
    res.status(500).json({ error: "Failed to load conversation" });
  }
});

// ─── Helpers ─────────────────────────────────────────────────

/**
 * The shape the channel card and results page consume.
 *
 * Stage and percentage are derived by the SHARED helper rather than here, so
 * the backend, the frontend mirror and the tests all agree on what
 * "analyzing" means and when a percentage is honest.
 */
function toStatusView(row: {
  id: string;
  source: string;
  channelAccountId: string | null;
  status: string;
  sourceProgress: number;
  customersAnalyzed: number;
  customersTotal: number;
  importedMessages: number;
  importedCustomers: number;
  knowledgeCandidateCount: number;
  knowledgeConflictCount: number;
  failureReason: string | null;
  failedStage: string | null;
  startedAt: Date;
  sourceCompletedAt: Date | null;
  completedAt: Date | null;
  sourceDeadlineAt: Date | null;
}) {
  const status = row.status as HistoricalImportStatus;
  return {
    id: row.id,
    source: row.source,
    channelAccountId: row.channelAccountId,
    status,
    stage: historicalImportStage(status),
    percent: historicalImportPercent({ status, sourceProgress: row.sourceProgress }),
    analysisCounts: historicalAnalysisCounts({
      status,
      customersAnalyzed: row.customersAnalyzed,
      customersTotal: row.customersTotal,
    }),
    hasResults: hasHistoricalResults(status),
    importedMessages: row.importedMessages,
    importedCustomers: row.importedCustomers,
    knowledgeCandidateCount: row.knowledgeCandidateCount,
    knowledgeConflictCount: row.knowledgeConflictCount,
    failureReason: row.failureReason,
    failedStage: row.failedStage,
    startedAt: row.startedAt,
    sourceCompletedAt: row.sourceCompletedAt,
    completedAt: row.completedAt,
    sourceDeadlineAt: row.sourceDeadlineAt,
    windowDays: HISTORICAL_SOURCE_WINDOW_DAYS,
  };
}

function confidenceLabel(confidence: number): "high" | "medium" | "low" {
  if (confidence >= BULK_APPROVE_MIN_CONFIDENCE) return "high";
  if (confidence >= 0.45) return "medium";
  return "low";
}

/**
 * Where an approved suggestion lands.
 *
 * The explicitly chosen base if the caller named one, otherwise the tenant's
 * first active general-scope base. Never creates one: a knowledge base is a
 * deliberate object with a name and a scope, and manufacturing one as a side
 * effect of an approval would put the customer's knowledge somewhere they never
 * chose.
 */
async function resolveTargetKnowledgeBase(
  tenantId: string,
  requestedId?: unknown,
): Promise<{ id: string } | null> {
  if (typeof requestedId === "string" && requestedId) {
    const explicit = await prisma.knowledgeBase.findFirst({
      where: { id: requestedId, tenantId, isActive: true },
      select: { id: true },
    });
    if (explicit) return explicit;
  }
  return prisma.knowledgeBase.findFirst({
    where: { tenantId, isActive: true, scope: "all" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
}

/**
 * The single-candidate approval used by the bulk path.
 *
 * Shares the duplicate check and the provenance stamping with the single
 * endpoint above, so a bulk approve cannot take a shortcut the individual one
 * refuses.
 */
async function approveOne(
  tenantId: string,
  candidateId: string,
  userId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const candidate = await prisma.knowledgeCandidate.findFirst({
    where: { id: candidateId, tenantId, status: "PENDING", conflict: false },
  });
  if (!candidate) return { ok: false, reason: "not eligible" };

  const target = await resolveTargetKnowledgeBase(tenantId);
  if (!target) return { ok: false, reason: "no knowledge base" };

  const existing = await findExistingKnowledge({
    tenantId,
    question: candidate.question,
    answer: candidate.answer,
  });
  if (existing) {
    await prisma.knowledgeCandidate.updateMany({
      where: { id: candidate.id, tenantId },
      data: { status: "SUPERSEDED", duplicateOfDocumentId: existing.documentId },
    });
    return { ok: false, reason: "already covered" };
  }

  const document = await prisma.knowledgeDocument.create({
    data: {
      knowledgeBaseId: target.id,
      tenantId,
      title: candidate.question.slice(0, 200),
      content: `${candidate.question}\n\n${candidate.answer}`,
      sourceType: "historical_conversations",
      status: "pending",
      metadata: {
        origin: "historical_import",
        sourceType: "historical_conversations",
        topic: candidate.topic,
      },
    },
  });

  await prisma.knowledgeCandidate.updateMany({
    where: { id: candidate.id, tenantId },
    data: {
      status: "APPROVED",
      approvedDocumentId: document.id,
      decidedAt: new Date(),
      decidedBy: userId,
    },
  });

  try {
    await processDocument(document.id);
  } catch (err: any) {
    console.error(`[historical-import] embedding failed for ${document.id}: ${err?.message}`);
  }

  await writeAudit({
    tenantId,
    actorType: "user",
    actorId: userId,
    action: AuditAction.KNOWLEDGE_HISTORICAL_APPROVED,
    targetType: "knowledge_document",
    targetId: document.id,
    metadata: {
      source: "historical_conversations",
      sourceProvider: "whatsapp_business_app",
      candidateId: candidate.id,
      bulk: true,
    },
  });

  return { ok: true };
}

export default router;
