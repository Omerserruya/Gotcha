import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN", "AGENT"));

// GET / - List scheduled messages for tenant
router.get("/", async (req: Request, res: Response) => {
  try {
    const { status, channel, page, limit } = req.query;
    const pageNum = page ? parseInt(page as string, 10) : 1;
    const limitNum = limit ? parseInt(limit as string, 10) : 20;
    const skip = (pageNum - 1) * limitNum;

    const where: any = { tenantId: req.tenantId! };
    if (status) where.status = status as string;
    if (channel) where.channel = channel as string;

    const [items, total] = await Promise.all([
      prisma.scheduledMessage.findMany({
        where,
        orderBy: { scheduledAt: "asc" },
        skip,
        take: limitNum,
      }),
      prisma.scheduledMessage.count({ where }),
    ]);

    res.json({ data: items, total, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error("List scheduled messages error:", err);
    res.status(500).json({ error: "Failed to list scheduled messages" });
  }
});

// GET /:id - Get single scheduled message
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const item = await prisma.scheduledMessage.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });
    if (!item) { res.status(404).json({ error: "Scheduled message not found" }); return; }
    res.json({ data: item });
  } catch (err) {
    console.error("Get scheduled message error:", err);
    res.status(500).json({ error: "Failed to get scheduled message" });
  }
});

// POST / - Create scheduled message
router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      channel,
      channelAccountId,
      recipientExternalId,
      body,
      scheduledAt,
      conversationId,
      messageType,
      mediaUrl,
      templateId,
      variables,
      sendType,
      departmentId,
      flowId,
    } = req.body;

    if (!channel || !channelAccountId || !recipientExternalId || !body || !scheduledAt) {
      res.status(400).json({ error: "channel, channelAccountId, recipientExternalId, body, and scheduledAt are required" });
      return;
    }

    const scheduledAtDate = new Date(scheduledAt);
    if (isNaN(scheduledAtDate.getTime()) || scheduledAtDate <= new Date()) {
      res.status(400).json({ error: "scheduledAt must be a valid date in the future" });
      return;
    }

    const item = await prisma.scheduledMessage.create({
      data: {
        tenantId: req.tenantId!,
        channel,
        channelAccountId,
        recipientExternalId,
        body,
        scheduledAt: scheduledAtDate,
        conversationId: conversationId ?? null,
        messageType: messageType ?? null,
        mediaUrl: mediaUrl ?? null,
        templateId: templateId ?? null,
        variables: variables ?? null,
        sendType: sendType ?? "regular",
        departmentId: departmentId ?? null,
        flowId: flowId ?? null,
        createdBy: req.user!.userId,
        status: "PENDING",
      },
    });

    res.status(201).json({ data: item });
  } catch (err) {
    console.error("Create scheduled message error:", err);
    res.status(500).json({ error: "Failed to create scheduled message" });
  }
});

// PATCH /:id - Update scheduled message (only if PENDING)
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.scheduledMessage.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });
    if (!existing) { res.status(404).json({ error: "Scheduled message not found" }); return; }
    if (existing.status !== "PENDING") {
      res.status(409).json({ error: "Only PENDING scheduled messages can be updated" });
      return;
    }

    const { body, scheduledAt, variables } = req.body;
    const updateData: any = {};

    if (body !== undefined) updateData.body = body;
    if (variables !== undefined) updateData.variables = variables;
    if (scheduledAt !== undefined) {
      const scheduledAtDate = new Date(scheduledAt);
      if (isNaN(scheduledAtDate.getTime()) || scheduledAtDate <= new Date()) {
        res.status(400).json({ error: "scheduledAt must be a valid date in the future" });
        return;
      }
      updateData.scheduledAt = scheduledAtDate;
    }

    const updated = await prisma.scheduledMessage.update({
      where: { id: existing.id },
      data: updateData,
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Update scheduled message error:", err);
    res.status(500).json({ error: "Failed to update scheduled message" });
  }
});

// DELETE /:id - Cancel scheduled message
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.scheduledMessage.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });
    if (!existing) { res.status(404).json({ error: "Scheduled message not found" }); return; }
    if (existing.status !== "PENDING") {
      res.status(409).json({ error: "Only PENDING scheduled messages can be cancelled" });
      return;
    }

    const cancelled = await prisma.scheduledMessage.update({
      where: { id: existing.id },
      data: { status: "CANCELLED" },
    });

    res.json({ data: cancelled });
  } catch (err) {
    console.error("Cancel scheduled message error:", err);
    res.status(500).json({ error: "Failed to cancel scheduled message" });
  }
});

export default router;
