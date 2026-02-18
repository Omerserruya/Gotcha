import { Router, Request, Response } from "express";
import { authenticate, resolveTenant, requireRole } from "@chatcenter/shared";
import * as conversationService from "../services/conversation.service";

const router = Router();
router.use(authenticate, resolveTenant);

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
    const { status, assignedAgentId, channel, departmentId, search, page, limit } = req.query;
    const result = await conversationService.list(req.tenantId!, {
      status: status as string | undefined,
      assignedAgentId: assignedAgentId as string | undefined,
      channel: channel as string | undefined,
      departmentId: departmentId as string | undefined,
      search: search as string | undefined,
      page: page ? parseInt(page as string, 10) : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
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

router.get("/history/:phone", async (req: Request, res: Response) => {
  try {
    const phone = req.params.phone as string;
    const data = await conversationService.getHistoryByPhone(req.tenantId!, phone);
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
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "Failed to close conversation" });
  }
});

export default router;
