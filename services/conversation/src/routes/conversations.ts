import { Router, Request, Response } from "express";
import { authenticate, resolveTenant, requireRole, requireActiveTenant, prisma, latestHandover } from "@chatcenter/shared";
import { requireVisibleConversation } from "../lib/require-visible-conversation";
import * as conversationService from "../services/conversation.service";

async function generateAndSaveSummary(tenantId: string, conversationId: string, authHeader?: string) {
  if (!authHeader) return;

  const aiServiceUrl = process.env.AI_SERVICE_URL || `http://ai:${process.env.AI_PORT || 4006}`;

  try {
    const response = await fetch(`${aiServiceUrl}/api/ai-assist/${conversationId}/summary`, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) return;

    const data = await response.json() as any;
    const summary = data?.data?.summary;

    if (summary && summary.trim()) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { aiSummary: summary },
      });
    }
  } catch (err) {
    console.error("Summary generation failed:", err);
  }
}

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());
// Every /:id route below answers only for a conversation this viewer may
// see; 404 otherwise. See lib/require-visible-conversation.ts.
router.param("id", requireVisibleConversation);

/**
 * The tenant's most recent change of handler.
 *
 * `null` when nothing has been recorded, and the card must render that as
 * absence rather than as zero: a tenant deployed this morning and a tenant
 * whose AI has never needed help both have no handovers, and they do not mean
 * the same thing.
 *
 * Any tenant member. Whether the AI recently gave up is exactly what an agent
 * wants to know before picking the next conversation. Declared before "/:id",
 * which would otherwise read "handovers" as a conversation id.
 */
router.get("/handovers/latest", async (req: Request, res: Response) => {
  try {
    const data = await latestHandover(req.tenantId!);
    res.json({ data });
  } catch (err) {
    console.error("Latest handover error:", err);
    res.status(500).json({ error: "Failed to get latest handover" });
  }
});

router.get("/stats/workload", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const workload = await conversationService.getAgentWorkload(req.tenantId!);
    res.json({ data: workload });
  } catch (err) {
    console.error("Workload error:", err);
    res.status(500).json({ error: "Failed to get workload" });
  }
});

router.get("/", async (req: Request, res: Response) => {
  try {
    const { status, assignedAgentId, channel, departmentId, search, page, limit, cursor, includeAutomated, automatedOnly } = req.query;
    const result = await conversationService.list(req.tenantId!, {
      status: status as string | undefined,
      assignedAgentId: assignedAgentId as string | undefined,
      channel: channel as string | undefined,
      departmentId: departmentId as string | undefined,
      search: search as string | undefined,
      page: page ? parseInt(page as string, 10) : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      // Presence switches the list to keyset paging; an empty string means
      // "first keyset page" and is distinct from absent, which means offset.
      cursor: typeof cursor === "string" ? cursor : undefined,
      includeAutomated: includeAutomated === "true",
      automatedOnly: automatedOnly === "true",
      userRole: req.user!.role,
      userId: req.user!.userId,
      userDepartmentId: req.user!.departmentId,
    });
    res.json(result);
  } catch (err: any) {
    if (err?.status === 400) { res.status(400).json({ error: err.message }); return; }
    console.error("List conversations error:", err);
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

router.get("/history/:customerExternalId", async (req: Request, res: Response) => {
  try {
    const customerExternalId = req.params.customerExternalId as string;
    // Optional anchor conversation - when provided, the walk also queries
    // the linked CRM record for cross-platform identifiers (phone, email,
    // gotcha_psid_*). The frontend's History panel already passes this; the
    // legacy single-key behavior still works when conversationId is omitted.
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : undefined;
    const data = await conversationService.getHistoryByCustomerExternalId(
      req.tenantId!,
      customerExternalId,
      conversationId,
      { userId: req.user!.userId, role: req.user!.role, departmentId: (req.user as any)?.departmentId },
    );
    res.json({ data });
  } catch (err) {
    console.error("Conversation history error:", err);
    res.status(500).json({ error: "Failed to get conversation history" });
  }
});

/**
 * Conversation notes are NOT stored by this service, and these say so.
 *
 * They used to be demo stubs: the GET answered `{ data: [] }` and the POST
 * answered 200 with `{ id, text, createdAt }` - a well-formed note that was
 * never written anywhere. That is the worst shape a stub can take. A client
 * renders it as saved, the person who typed it believes it saved, and nothing
 * records that it did not. An empty 200 from the GET has the same defect one
 * level down: "no notes" and "notes are not kept here" are different facts and
 * an empty array reads as the first.
 *
 * ★ NOTES DO EXIST, AND THEY ARE KEYED ON A CUSTOMER. `/api/identity/:contactId/notes`
 * stores them (`customer-notes.service.ts`) and mirrors the body to whatever
 * system the merchant elected in Business Core, reporting that push's real
 * outcome. A conversation is at most WHERE a note was written, never its
 * subject - the person outlives the thread.
 *
 * Which is why this answers 501 and NAMES that endpoint rather than 404ing:
 * the next person to want notes here should use the customer-keyed ones, not
 * build a second note store in the conversation service.
 */
const NOTES_NOT_STORED = {
  error: "notes_not_stored_here",
  message:
    "Notes are keyed on a CUSTOMER, not a conversation. Use /api/identity/:contactId/notes (GET, POST, PATCH, DELETE), which stores the note and mirrors it to the system elected in Business Core.",
} as const;

router.get("/:id/notes", async (_req: Request, res: Response) => {
  res.status(501).json(NOTES_NOT_STORED);
});

router.post("/:id/notes", async (_req: Request, res: Response) => {
  // Refused BEFORE reading the body: accepting input we will not keep is the
  // whole defect, and a 501 that still parses the note invites a caller to
  // believe some of it was used.
  res.status(501).json(NOTES_NOT_STORED);
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const conversation = await conversationService.getById(req.tenantId!, req.params.id as string);
    if (!conversation) { res.status(404).json({ error: "Conversation not found" }); return; }
    res.json({ data: conversation });
  } catch (err) {
    console.error("Get conversation error:", err);
    res.status(500).json({ error: "Failed to get conversation" });
  }
});

router.post("/:id/claim", async (req: Request, res: Response) => {
  try {
    const conversation = await conversationService.claim(req.tenantId!, req.params.id as string, req.user!.userId);
    res.json({ data: conversation });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "Failed to claim conversation" });
  }
});

router.post("/:id/release", async (req: Request, res: Response) => {
  try {
    const conversation = await conversationService.release(req.tenantId!, req.params.id as string);
    res.json({ data: conversation });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "Failed to release conversation" });
  }
});

// Hand a conversation back to the AI employee (clears the one-way
// isHandedOver latch). 409 when no AI employee is bound.
router.post("/:id/return-to-ai", async (req: Request, res: Response) => {
  try {
    const conversation = await conversationService.returnToAi(req.tenantId!, req.params.id as string);
    res.json({ data: conversation });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "Failed to return conversation to AI" });
  }
});

// Stop the AI without assigning anyone: the conversation waits for a person.
// The inverse of return-to-ai, with the same access.
router.post("/:id/stop-ai", async (req: Request, res: Response) => {
  try {
    const conversation = await conversationService.stopAi(req.tenantId!, req.params.id as string, req.user?.userId);
    res.json({ data: conversation });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "Failed to stop the AI" });
  }
});

// Allow both ADMIN and the assigned agent to transfer/reassign
/*
 * ARCHIVE AND MARK-UNREAD - the two context-menu actions the server could not do.
 *
 * The queue's right-click menu specifies seven actions. Five had routes. These
 * two did not: archive had nothing at all, and "mark as unread" lived only as a
 * `chatcenter:markedUnread` set in the browser's localStorage, so it was lost on
 * another device, lost when site data was cleared, and invisible to the team.
 *
 * ★ They are deliberately different shapes. Archiving is a fact about the
 *   CONVERSATION and everyone sees it. Marking unread is a fact about the
 *   PERSON - a column would mean one agent marking unread marks it unread for
 *   the whole team, which is neither what the old product did nor what anyone
 *   would expect.
 */

/** Both archive routes need the same check: it exists, and it is ours. */
async function findInTenant(tenantId: string, conversationId: string) {
  return prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
}

router.post("/:id/archive", async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.id as string;
    const existing = await findInTenant(req.tenantId!, conversationId);
    if (!existing) { res.status(404).json({ error: "Conversation not found" }); return; }

    // Already archived is not an error: the menu can be opened twice, and the
    // second click should leave the FIRST archive time standing rather than
    // moving it.
    if (existing.archivedAt) { res.json({ data: existing }); return; }

    const conversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: { archivedAt: new Date() },
    });
    res.json({ data: conversation });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "Failed to archive conversation" });
  }
});

router.delete("/:id/archive", async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.id as string;
    const existing = await findInTenant(req.tenantId!, conversationId);
    if (!existing) { res.status(404).json({ error: "Conversation not found" }); return; }

    const conversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: { archivedAt: null },
    });
    res.json({ data: conversation });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "Failed to unarchive conversation" });
  }
});

router.post("/:id/unread", async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.id as string;
    const userId = req.user!.userId;
    const existing = await findInTenant(req.tenantId!, conversationId);
    if (!existing) { res.status(404).json({ error: "Conversation not found" }); return; }

    /*
     * `markedUnread` is set by hand and is NOT the same as "has unseen
     * messages", which is derived from lastReadAt. A conversation you have
     * read can still be deliberately marked unread - that is the entire point
     * of the action, so clearing lastReadAt here would be wrong.
     */
    const state = await prisma.conversationReadState.upsert({
      // ★ `tenantId` IS LOAD-BEARING HERE, NOT BELT-AND-BRACES. The tenant
      // guard REFUSES an upsert whose where clause omits it
      // ("where clause must include tenantId"), and Prisma 5's extended unique
      // where accepts a non-unique field beside the compound key. Without it
      // this route throws on its first call.
      where: { userId_conversationId: { userId, conversationId }, tenantId: req.tenantId! },
      create: { tenantId: req.tenantId!, userId, conversationId, markedUnread: true },
      update: { markedUnread: true },
    });
    res.json({ data: state });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "Failed to mark conversation unread" });
  }
});

router.delete("/:id/unread", async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.id as string;
    const userId = req.user!.userId;
    const existing = await findInTenant(req.tenantId!, conversationId);
    if (!existing) { res.status(404).json({ error: "Conversation not found" }); return; }

    // Opening a conversation clears the manual mark AND moves the read point.
    const state = await prisma.conversationReadState.upsert({
      // Same reason as the mark-unread route above: the guard refuses an
      // upsert with no tenantId in its where.
      where: { userId_conversationId: { userId, conversationId }, tenantId: req.tenantId! },
      create: { tenantId: req.tenantId!, userId, conversationId, markedUnread: false, lastReadAt: new Date() },
      update: { markedUnread: false, lastReadAt: new Date() },
    });
    res.json({ data: state });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "Failed to mark conversation read" });
  }
});

router.post("/:id/reassign", async (req: Request, res: Response) => {
  try {
    const { agentId, departmentId } = req.body;
    if (!agentId && !departmentId) { res.status(400).json({ error: "agentId or departmentId is required" }); return; }

    const conversationId = req.params.id as string;
    const userId = req.user!.userId;
    const userRole = req.user!.role;

    // Agents can only transfer conversations assigned to them
    if (userRole !== "ADMIN") {
      const conv = await conversationService.getById(req.tenantId!, conversationId);
      if (!conv || conv.assignedAgentId !== userId) {
        res.status(403).json({ error: "You can only transfer conversations assigned to you" });
        return;
      }
    }

    // Transfer to department or agent
    if (departmentId) {
      const conversation = await conversationService.transferToDepartment(req.tenantId!, conversationId, departmentId);
      res.json({ data: conversation });
    } else {
      const conversation = await conversationService.reassign(req.tenantId!, conversationId, agentId);
      res.json({ data: conversation });
    }
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "Failed to reassign conversation" });
  }
});

router.post("/:id/close", async (req: Request, res: Response) => {
  try {
    const conversation = await conversationService.close(req.tenantId!, req.params.id as string);
    res.json({ data: conversation });

    // Non-blocking: generate AI summary after response is sent
    generateAndSaveSummary(req.tenantId!, conversation.id, req.headers.authorization).catch(err => {
      console.error("Failed to generate conversation summary:", err.message);
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "Failed to close conversation" });
  }
});

// ─── Delete Conversation (cascade messages) ──────────────────
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.id as string;
    const force = req.query.force === "true";
    const userRole = (req as any).user?.role;

    // Only ADMIN and SYSTEM_ADMIN can delete
    if (userRole !== "ADMIN" && userRole !== "SYSTEM_ADMIN") {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId: req.tenantId! },
    });

    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    // Must be closed unless force
    if (conversation.status !== "CLOSED" && !force) {
      res.status(400).json({ error: "Conversation must be closed before deletion. Use ?force=true to override." });
      return;
    }

    // Delete messages first, then conversation
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { tenantId: req.tenantId!, conversationId } }),
      prisma.conversation.delete({ where: { id: conversationId } }),
    ]);

    res.json({ data: { deleted: true, conversationId } });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "Failed to delete conversation" });
  }
});

export default router;
