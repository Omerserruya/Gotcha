import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";

const router = Router();

router.get("/", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { channel, status, category, page, limit } = req.query;
    const pageNum = page ? parseInt(page as string, 10) : 1;
    const limitNum = limit ? parseInt(limit as string, 10) : 50;
    const skip = (pageNum - 1) * limitNum;

    const where: any = { tenantId: req.tenantId! as string };
    if (channel) where.channel = channel;
    if (status) where.status = status;
    if (category) where.category = category;

    const [items, total] = await Promise.all([
      prisma.messageTemplate.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip,
        take: limitNum,
      }),
      prisma.messageTemplate.count({ where }),
    ]);

    res.json({ data: items, total, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error("List templates error:", err);
    res.status(500).json({ error: "Failed to list templates" });
  }
});

router.get("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const template = await prisma.messageTemplate.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });
    if (!template) { res.status(404).json({ error: "Template not found" }); return; }
    res.json({ data: template });
  } catch (err) {
    console.error("Get template error:", err);
    res.status(500).json({ error: "Failed to get template" });
  }
});

router.post("/", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const {
      name,
      body,
      category = "general",
      language = "en",
      channel,
      headerType,
      headerContent,
      footer,
      buttons = [],
      variables = [],
      status = "DRAFT",
    } = req.body;

    if (!name || !body) {
      res.status(400).json({ error: "name and body are required" });
      return;
    }

    const template = await prisma.messageTemplate.create({
      data: {
        tenantId: req.tenantId! as string,
        name,
        body,
        category,
        language,
        channel: channel ?? null,
        headerType: headerType ?? null,
        headerContent: headerContent ?? null,
        footer: footer ?? null,
        buttons,
        variables,
        status,
      },
    });

    res.status(201).json({ data: template });
  } catch (err) {
    console.error("Create template error:", err);
    res.status(500).json({ error: "Failed to create template" });
  }
});

router.patch("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.messageTemplate.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });
    if (!existing) { res.status(404).json({ error: "Template not found" }); return; }

    const template = await prisma.messageTemplate.update({
      where: { id: existing.id },
      data: req.body,
    });

    res.json({ data: template });
  } catch (err) {
    console.error("Update template error:", err);
    res.status(500).json({ error: "Failed to update template" });
  }
});

router.delete("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.messageTemplate.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });
    if (!existing) { res.status(404).json({ error: "Template not found" }); return; }

    const broadcastCount = await prisma.broadcast.count({
      where: { templateId: existing.id },
    });
    if (broadcastCount > 0) {
      res.status(409).json({ error: "Template is used by one or more broadcasts and cannot be deleted" });
      return;
    }

    await prisma.messageTemplate.delete({ where: { id: existing.id } });

    res.json({ data: { deleted: true, id: existing.id } });
  } catch (err) {
    console.error("Delete template error:", err);
    res.status(500).json({ error: "Failed to delete template" });
  }
});

router.post("/:id/duplicate", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const original = await prisma.messageTemplate.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });
    if (!original) { res.status(404).json({ error: "Template not found" }); return; }

    const copy = await prisma.messageTemplate.create({
      data: {
        tenantId: req.tenantId! as string,
        name: `${original.name} (Copy)`,
        body: original.body,
        category: original.category,
        language: original.language,
        channel: original.channel ?? null,
        headerType: original.headerType ?? null,
        headerContent: original.headerContent ?? null,
        footer: original.footer ?? null,
        buttons: original.buttons as any,
        variables: original.variables as any,
        status: "DRAFT",
      },
    });

    res.status(201).json({ data: copy });
  } catch (err) {
    console.error("Duplicate template error:", err);
    res.status(500).json({ error: "Failed to duplicate template" });
  }
});

// ─── Submit Template to Meta ────────────────────────────────
router.post("/:id/submit-to-meta", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const template = await prisma.messageTemplate.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });
    if (!template) { res.status(404).json({ error: "Template not found" }); return; }

    if (template.status !== "DRAFT") {
      res.status(400).json({ error: "Only DRAFT templates can be submitted to Meta" });
      return;
    }

    if (template.channel !== "WHATSAPP") {
      res.status(400).json({ error: "Only WhatsApp templates can be submitted to Meta" });
      return;
    }

    // Find the WhatsApp channel account for this tenant
    const channelAccount = await prisma.channelAccount.findFirst({
      where: { tenantId: req.tenantId! as string, channel: "WHATSAPP", isActive: true, connectionStatus: "CONNECTED" },
    });

    if (!channelAccount) {
      res.status(400).json({ error: "No connected WhatsApp channel found" });
      return;
    }

    // Decrypt credentials to get access token and WABA ID
    const { decryptCredentials } = await import("@chatcenter/shared");
    const creds = decryptCredentials(channelAccount.credentials as string);
    const { accessToken, wabaId } = creds;

    if (!accessToken || !wabaId) {
      res.status(400).json({ error: "WhatsApp channel missing credentials" });
      return;
    }

    // Submit to Meta WhatsApp Business API
    const FB_API_URL = process.env.FACEBOOK_API_URL || "https://graph.facebook.com/v21.0";

    const components: any[] = [];

    // Header component
    if (template.headerType && template.headerType !== "NONE") {
      components.push({
        type: "HEADER",
        format: template.headerType,
        ...(template.headerType === "TEXT" ? { text: template.headerContent || "" } : {}),
      });
    }

    // Body component
    components.push({
      type: "BODY",
      text: template.body,
    });

    // Footer component
    if (template.footer) {
      components.push({
        type: "FOOTER",
        text: template.footer,
      });
    }

    const metaPayload = {
      name: template.name,
      category: (template.category || "UTILITY").toUpperCase(),
      language: template.language || "en",
      components,
    };

    const metaRes = await fetch(`${FB_API_URL}/${wabaId}/message_templates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(metaPayload),
    });

    const metaData: any = await metaRes.json();

    if (!metaRes.ok) {
      console.error("Meta template submission error:", metaData);
      res.status(400).json({
        error: metaData.error?.message || "Failed to submit template to Meta",
        metaError: metaData.error,
      });
      return;
    }

    // Update template status
    const updated = await prisma.messageTemplate.update({
      where: { id: template.id },
      data: {
        status: "PENDING_APPROVAL",
      },
    });

    res.json({ data: updated, meta: metaData });
  } catch (err) {
    console.error("Submit template to Meta error:", err);
    res.status(500).json({ error: "Failed to submit template to Meta" });
  }
});

export default router;
