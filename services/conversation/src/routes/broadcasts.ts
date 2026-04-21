import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole, broadcastQueue, publishEvent } from "@chatcenter/shared";
import type { BroadcastJob } from "@chatcenter/shared";

async function publishBroadcastUpdate(broadcastId: string, tenantId: string) {
  try {
    const bc = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
    if (bc) await publishEvent({ event: "broadcast:updated", tenantId, data: bc });
  } catch {}
}

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"));

// ─── List Broadcasts ─────────────────────────────────────────
router.get("/", async (req: Request, res: Response) => {
  try {
    const { status, channel } = req.query;

    const where: any = { tenantId: req.tenantId! };
    if (status) where.status = String(status);
    if (channel) where.channel = String(channel);

    const broadcasts = await prisma.broadcast.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        template: { select: { id: true, name: true } },
        _count: {
          select: { recipients: true },
        },
      },
    });

    const broadcastIds = broadcasts.map((b) => b.id);
    const recipientStatusCounts = broadcastIds.length
      ? await prisma.broadcastRecipient.groupBy({
          by: ["broadcastId", "status"],
          where: { broadcastId: { in: broadcastIds } },
          _count: { status: true },
        })
      : [];

    const countsByBroadcast: Record<string, Record<string, number>> = {};
    for (const row of recipientStatusCounts) {
      if (!countsByBroadcast[row.broadcastId]) countsByBroadcast[row.broadcastId] = {};
      countsByBroadcast[row.broadcastId][row.status] = row._count.status;
    }

    const data = broadcasts.map((b) => ({
      ...b,
      recipientStatusCounts: countsByBroadcast[b.id] || {},
    }));

    res.json({ data });
  } catch (err) {
    console.error("List broadcasts error:", err);
    res.status(500).json({ error: "Failed to list broadcasts" });
  }
});

// ─── Get Single Broadcast ────────────────────────────────────
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] as string;
    const broadcast = await prisma.broadcast.findFirst({
      where: { id, tenantId: req.tenantId! },
      include: {
        template: { select: { id: true, name: true } },
      },
    });

    if (!broadcast) {
      res.status(404).json({ error: "Broadcast not found" });
      return;
    }

    const analytics = {
      sentCount: broadcast.sentCount,
      deliveredCount: broadcast.deliveredCount,
      readCount: broadcast.readCount,
      repliedCount: broadcast.repliedCount,
      failedCount: broadcast.failedCount,
    };

    res.json({ data: { ...broadcast, analytics } });
  } catch (err) {
    console.error("Get broadcast error:", err);
    res.status(500).json({ error: "Failed to get broadcast" });
  }
});

// ─── Get Broadcast Recipients ────────────────────────────────
router.get("/:id/recipients", async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] as string;
    const broadcast = await prisma.broadcast.findFirst({
      where: { id, tenantId: req.tenantId! },
    });

    if (!broadcast) {
      res.status(404).json({ error: "Broadcast not found" });
      return;
    }

    const { page, limit } = req.query;
    const pageNum = page ? parseInt(page as string, 10) : 1;
    const limitNum = limit ? parseInt(limit as string, 10) : 50;
    const skip = (pageNum - 1) * limitNum;

    const [recipients, total] = await Promise.all([
      prisma.broadcastRecipient.findMany({
        where: { broadcastId: broadcast.id },
        skip,
        take: limitNum,
        include: {
          contact: { select: { displayName: true, externalId: true } },
        },
      }),
      prisma.broadcastRecipient.count({ where: { broadcastId: broadcast.id } }),
    ]);

    res.json({ data: recipients, meta: { total, page: pageNum, limit: limitNum } });
  } catch (err) {
    console.error("Get broadcast recipients error:", err);
    res.status(500).json({ error: "Failed to get broadcast recipients" });
  }
});

// ─── Create Broadcast ────────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, channel, channelAccountId, templateId, body, variables, scheduledAt, flowId } = req.body;

    if (!name || !channel || !channelAccountId) {
      res.status(400).json({ error: "name, channel, and channelAccountId are required" });
      return;
    }

    const broadcast = await prisma.broadcast.create({
      data: {
        tenantId: req.tenantId!,
        name,
        channel,
        channelAccountId,
        templateId: templateId || null,
        body: body || null,
        variables: variables || {},
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        flowId: flowId || null,
        createdBy: req.user!.userId,
        status: "DRAFT",
      },
    });

    res.status(201).json({ data: broadcast });
  } catch (err) {
    console.error("Create broadcast error:", err);
    res.status(500).json({ error: "Failed to create broadcast" });
  }
});

// ─── Update Broadcast ────────────────────────────────────────
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] as string;
    const broadcast = await prisma.broadcast.findFirst({
      where: { id, tenantId: req.tenantId! },
    });

    if (!broadcast) {
      res.status(404).json({ error: "Broadcast not found" });
      return;
    }

    if (broadcast.status !== "DRAFT" && broadcast.status !== "SCHEDULED") {
      res.status(400).json({ error: "Only DRAFT or SCHEDULED broadcasts can be updated" });
      return;
    }

    const { name, channel, channelAccountId, templateId, body, variables, scheduledAt, flowId } = req.body;

    const updated = await prisma.broadcast.update({
      where: { id: broadcast.id },
      data: {
        ...(name !== undefined && { name }),
        ...(channel !== undefined && { channel }),
        ...(channelAccountId !== undefined && { channelAccountId }),
        ...(templateId !== undefined && { templateId }),
        ...(body !== undefined && { body }),
        ...(variables !== undefined && { variables }),
        ...(scheduledAt !== undefined && { scheduledAt: scheduledAt ? new Date(scheduledAt) : null }),
        ...(flowId !== undefined && { flowId: flowId || null }),
      },
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Update broadcast error:", err);
    res.status(500).json({ error: "Failed to update broadcast" });
  }
});

// ─── Delete Broadcast ────────────────────────────────────────
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] as string;
    const broadcast = await prisma.broadcast.findFirst({
      where: { id, tenantId: req.tenantId! },
    });

    if (!broadcast) {
      res.status(404).json({ error: "Broadcast not found" });
      return;
    }

    if (broadcast.status === "SENDING") {
      res.status(400).json({ error: "Cancel the broadcast before deleting" });
      return;
    }

    await prisma.$transaction([
      prisma.broadcastRecipient.deleteMany({ where: { broadcastId: broadcast.id } }),
      prisma.broadcast.delete({ where: { id: broadcast.id } }),
    ]);

    await publishEvent({
      event: "broadcast:deleted",
      tenantId: broadcast.tenantId,
      data: { id: broadcast.id },
    });

    res.json({ data: { deleted: true, broadcastId: broadcast.id } });
  } catch (err) {
    console.error("Delete broadcast error:", err);
    res.status(500).json({ error: "Failed to delete broadcast" });
  }
});

// ─── Add Recipients ──────────────────────────────────────────
router.post("/:id/recipients", async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] as string;
    const broadcast = await prisma.broadcast.findFirst({
      where: { id, tenantId: req.tenantId! },
    });

    if (!broadcast) {
      res.status(404).json({ error: "Broadcast not found" });
      return;
    }

    const { recipients } = req.body;
    if (!Array.isArray(recipients) || recipients.length === 0) {
      res.status(400).json({ error: "recipients must be a non-empty array" });
      return;
    }

    const created = await prisma.$transaction(async (tx) => {
      const records = await tx.broadcastRecipient.createMany({
        data: recipients.map((r: { externalId: string; contactId?: string }) => ({
          broadcastId: broadcast.id,
          externalId: r.externalId,
          contactId: r.contactId || null,
        })),
        skipDuplicates: true,
      });

      const newTotal = await tx.broadcastRecipient.count({ where: { broadcastId: broadcast.id } });
      await tx.broadcast.update({
        where: { id: broadcast.id },
        data: { totalRecipients: newTotal },
      });

      return records;
    });

    res.status(201).json({ data: { added: created.count } });
  } catch (err) {
    console.error("Add recipients error:", err);
    res.status(500).json({ error: "Failed to add recipients" });
  }
});

// ─── Send Broadcast ──────────────────────────────────────────
router.post("/:id/send", async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] as string;
    const broadcast = await prisma.broadcast.findFirst({
      where: { id, tenantId: req.tenantId! },
    });

    if (!broadcast) {
      res.status(404).json({ error: "Broadcast not found" });
      return;
    }

    if (broadcast.status !== "DRAFT" && broadcast.status !== "SCHEDULED") {
      res.status(400).json({ error: "Only DRAFT or SCHEDULED broadcasts can be sent" });
      return;
    }

    const now = new Date();
    const isScheduled = broadcast.scheduledAt && broadcast.scheduledAt > now;
    const newStatus = isScheduled ? "SCHEDULED" : "SENDING";

    await prisma.broadcast.update({
      where: { id: broadcast.id },
      data: {
        status: newStatus,
        startedAt: isScheduled ? null : now,
        lastError: null,
        sentCount: 0,
        failedCount: 0,
      },
    });

    await publishBroadcastUpdate(broadcast.id, broadcast.tenantId);

    if (!isScheduled) {
      const recipients = await prisma.broadcastRecipient.findMany({
        where: { broadcastId: broadcast.id },
      });

      for (const recipient of recipients) {
        await broadcastQueue.add("send", {
          broadcastId: broadcast.id,
          tenantId: broadcast.tenantId,
          channel: broadcast.channel as BroadcastJob["channel"],
          channelAccountId: broadcast.channelAccountId,
          templateId: broadcast.templateId ?? undefined,
          body: broadcast.body ?? "",
          messageType: broadcast.templateId ? "template" : "text",
          recipientId: recipient.id,
          recipientExternalId: recipient.externalId,
          variables: (broadcast.variables as Record<string, string>) ?? undefined,
        }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
      }
    }

    res.json({ data: { status: newStatus, broadcastId: broadcast.id } });
  } catch (err) {
    console.error("Send broadcast error:", err);
    res.status(500).json({ error: "Failed to send broadcast" });
  }
});

// ─── Validate Broadcast Before Send ─────────────────────────
router.post("/:id/validate", async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] as string;
    const broadcast = await prisma.broadcast.findFirst({
      where: { id, tenantId: req.tenantId! },
      include: { template: true },
    });

    if (!broadcast) {
      res.status(404).json({ error: "Broadcast not found" });
      return;
    }

    // Get all recipients
    const recipients = await prisma.broadcastRecipient.findMany({
      where: { broadcastId: broadcast.id },
      include: { contact: true },
    });

    const totalRecipients = recipients.length;
    let validCount = 0;
    let invalidCount = 0;
    let optedOutCount = 0;
    const invalidReasons: string[] = [];

    for (const r of recipients) {
      // Check opt-out
      if (r.contact) {
        const contactAny = r.contact as any;
        const optOutChannels = (contactAny.optOutChannels as string[]) || [];
        if (optOutChannels.includes(broadcast.channel)) {
          optedOutCount++;
          continue;
        }
      }

      // Check validity based on channel
      const hasValidId = r.externalId && r.externalId.trim().length > 0;
      if (!hasValidId) {
        invalidCount++;
        invalidReasons.push(`Recipient ${r.id}: missing external ID`);
        continue;
      }

      // Channel-specific validation
      if (broadcast.channel === "WHATSAPP" || broadcast.channel === "MESSENGER") {
        // WhatsApp needs phone-like ID or WAID
        if (broadcast.channel === "WHATSAPP" && !/^\+?\d{7,15}$/.test(r.externalId.replace(/\s/g, ""))) {
          invalidCount++;
          invalidReasons.push(`Recipient ${r.externalId}: invalid phone number format`);
          continue;
        }
      }

      validCount++;
    }

    // Template/channel mismatch check
    const warnings: string[] = [];
    if (broadcast.template) {
      if (broadcast.template.channel && broadcast.template.channel !== broadcast.channel) {
        warnings.push(`Template channel (${broadcast.template.channel}) doesn't match broadcast channel (${broadcast.channel})`);
      }
      if (broadcast.template.status !== "APPROVED" && broadcast.channel === "WHATSAPP") {
        warnings.push("WhatsApp requires approved templates. Current template status: " + broadcast.template.status);
      }
    }

    // No body or template
    if (!broadcast.body && !broadcast.templateId) {
      warnings.push("No message body or template selected");
    }

    // Cost estimation (rough)
    const costPerMessage: Record<string, number> = {
      WHATSAPP: 0.05,
      MESSENGER: 0.01,
      INSTAGRAM: 0.01,
      EMAIL: 0.001,
      GMAIL: 0.001,
      OUTLOOK: 0.001,
      SLACK: 0,
    };
    const unitCost = costPerMessage[broadcast.channel] || 0.01;
    const estimatedCost = validCount * unitCost;

    const canSend = validCount > 0 && warnings.filter(w => w.includes("requires approved")).length === 0;

    res.json({
      data: {
        totalRecipients,
        validCount,
        invalidCount,
        optedOutCount,
        reachableCount: validCount,
        estimatedCost: Math.round(estimatedCost * 100) / 100,
        estimatedCurrency: "USD",
        canSend,
        warnings,
        invalidReasons: invalidReasons.slice(0, 10), // first 10 only
      },
    });
  } catch (err) {
    console.error("Validate broadcast error:", err);
    res.status(500).json({ error: "Failed to validate broadcast" });
  }
});

// ─── Cancel Broadcast ────────────────────────────────────────
router.post("/:id/cancel", async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] as string;
    const broadcast = await prisma.broadcast.findFirst({
      where: { id, tenantId: req.tenantId! },
    });

    if (!broadcast) {
      res.status(404).json({ error: "Broadcast not found" });
      return;
    }

    if (broadcast.status !== "SENDING" && broadcast.status !== "SCHEDULED") {
      res.status(400).json({ error: "Only SENDING or SCHEDULED broadcasts can be cancelled" });
      return;
    }

    // Drain any pending jobs for this broadcast so we stop sending immediately.
    try {
      const waiting = await broadcastQueue.getJobs(["waiting", "delayed", "paused"]);
      for (const job of waiting) {
        if ((job.data as BroadcastJob)?.broadcastId === broadcast.id) {
          await job.remove();
        }
      }
    } catch (err) {
      console.warn("Cancel broadcast: drain queue failed", err);
    }

    await prisma.broadcastRecipient.updateMany({
      where: { broadcastId: broadcast.id, status: { in: ["pending", "queued"] } },
      data: { status: "skipped", error: "Broadcast cancelled" },
    });

    const updated = await prisma.broadcast.update({
      where: { id: broadcast.id },
      data: { status: "CANCELLED", completedAt: new Date() },
    });

    await publishBroadcastUpdate(broadcast.id, broadcast.tenantId);

    res.json({ data: updated });
  } catch (err) {
    console.error("Cancel broadcast error:", err);
    res.status(500).json({ error: "Failed to cancel broadcast" });
  }
});

export default router;
