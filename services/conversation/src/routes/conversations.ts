import { Router, Request, Response } from "express";
import { authenticate, resolveTenant, requireRole, requireActiveTenant, prisma } from "@chatcenter/shared";
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
    const { status, assignedAgentId, channel, departmentId, search, page, limit, includeAutomated, automatedOnly } = req.query;
    const result = await conversationService.list(req.tenantId!, {
      status: status as string | undefined,
      assignedAgentId: assignedAgentId as string | undefined,
      channel: channel as string | undefined,
      departmentId: departmentId as string | undefined,
      search: search as string | undefined,
      page: page ? parseInt(page as string, 10) : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      includeAutomated: includeAutomated === "true",
      automatedOnly: automatedOnly === "true",
      userRole: req.user!.role,
      userId: req.user!.userId,
      userDepartmentId: req.user!.departmentId,
    });
    res.json(result);
  } catch (err) {
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
    );
    res.json({ data });
  } catch (err) {
    console.error("Conversation history error:", err);
    res.status(500).json({ error: "Failed to get conversation history" });
  }
});

router.get("/:id/notes", async (_req: Request, res: Response) => {
  // Demo stub - notes will be stored in a future model
  res.json({ data: [] });
});

router.post("/:id/notes", async (req: Request, res: Response) => {
  // Demo stub - echo back the note
  const { text } = req.body;
  res.json({ data: { id: Date.now().toString(), text, createdAt: new Date().toISOString() } });
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

// Allow both ADMIN and the assigned agent to transfer/reassign
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
