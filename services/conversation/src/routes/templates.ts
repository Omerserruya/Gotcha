import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole, decryptCredentials } from "@chatcenter/shared";

const router = Router();

const FB_API_URL = process.env.FACEBOOK_API_URL || "https://graph.facebook.com/v21.0";

async function resolveWabaCreds(tenantId: string, template: { channelAccountId: string | null }) {
  const channelAccount = template.channelAccountId
    ? await prisma.channelAccount.findFirst({
        where: {
          id: template.channelAccountId,
          tenantId,
          channel: "WHATSAPP",
          isActive: true,
          connectionStatus: "CONNECTED",
        },
      })
    : await prisma.channelAccount.findFirst({
        where: { tenantId, channel: "WHATSAPP", isActive: true, connectionStatus: "CONNECTED" },
      });
  if (!channelAccount) return { error: "No connected WhatsApp channel found for this template" as const };
  const creds = decryptCredentials(channelAccount.credentials as any);
  const accessToken = creds?.accessToken;
  const wabaId = creds?.wabaId;
  if (!accessToken || !wabaId) return { error: "WhatsApp channel missing credentials" as const };
  return { channelAccount, accessToken, wabaId };
}

async function deleteMetaTemplate(wabaId: string, accessToken: string, name: string, hsmId?: string | null) {
  const qs = new URLSearchParams({ name });
  if (hsmId) qs.set("hsm_id", hsmId);
  const url = `${FB_API_URL}/${wabaId}/message_templates?${qs.toString()}`;
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
  const data: any = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function normalizeMetaName(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 512);
}

function buildMetaComponents(template: any) {
  const components: any[] = [];
  if (template.headerType && template.headerType !== "NONE") {
    components.push({
      type: "HEADER",
      format: template.headerType,
      ...(template.headerType === "TEXT" ? { text: template.headerContent || "" } : {}),
    });
  }
  components.push({ type: "BODY", text: template.body });
  if (template.footer) components.push({ type: "FOOTER", text: template.footer });
  return components;
}

router.get("/", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { channel, channelAccountId, status, category, page, limit } = req.query;
    const pageNum = page ? parseInt(page as string, 10) : 1;
    const limitNum = limit ? parseInt(limit as string, 10) : 50;
    const skip = (pageNum - 1) * limitNum;

    const where: any = { tenantId: req.tenantId! as string };
    if (channel) where.channel = channel;
    if (channelAccountId) where.channelAccountId = channelAccountId;
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
      channelAccountId,
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

    let resolvedChannel: string | null = channel ?? null;
    if (channelAccountId) {
      const account = await prisma.channelAccount.findFirst({
        where: { id: channelAccountId, tenantId: req.tenantId! as string },
      });
      if (!account) {
        res.status(400).json({ error: "Invalid channelAccountId" });
        return;
      }
      resolvedChannel = account.channel;
    }

    const template = await prisma.messageTemplate.create({
      data: {
        tenantId: req.tenantId! as string,
        name,
        body,
        category,
        language,
        channel: (resolvedChannel as any) ?? null,
        channelAccountId: channelAccountId ?? null,
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

    const data: any = { ...req.body };
    if (data.channelAccountId) {
      const account = await prisma.channelAccount.findFirst({
        where: { id: data.channelAccountId, tenantId: req.tenantId! as string },
      });
      if (!account) {
        res.status(400).json({ error: "Invalid channelAccountId" });
        return;
      }
      data.channel = account.channel;
    } else if (data.channelAccountId === null) {
      data.channelAccountId = null;
    }

    const template = await prisma.messageTemplate.update({
      where: { id: existing.id },
      data,
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
    if (broadcastCount > 0 && req.query.force !== "true") {
      res.status(409).json({ error: "Template is used by one or more broadcasts and cannot be deleted. Add ?force=true to force delete." });
      return;
    }

    // Unlink broadcasts before deleting
    if (broadcastCount > 0) {
      await prisma.broadcast.updateMany({
        where: { templateId: existing.id },
        data: { templateId: null },
      });
    }

    // Cascade delete on Meta for WhatsApp templates that have been submitted
    let metaDeleteResult: any = null;
    if (existing.channel === "WHATSAPP" && existing.status !== "DRAFT") {
      try {
        const resolved = await resolveWabaCreds(req.tenantId! as string, existing);
        if (!("error" in resolved)) {
          const metaName = normalizeMetaName(existing.name);
          const del = await deleteMetaTemplate(resolved.wabaId, resolved.accessToken, metaName, existing.metaTemplateId);
          metaDeleteResult = { ok: del.ok, status: del.status };
          if (!del.ok && del.status !== 404) {
            console.warn("[delete template] Meta delete non-ok:", del.status, del.data);
          }
        }
      } catch (metaErr) {
        console.error("[delete template] Meta delete threw:", metaErr);
      }
    }

    await prisma.messageTemplate.delete({ where: { id: existing.id } });

    res.json({ data: { deleted: true, id: existing.id, meta: metaDeleteResult } });
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

    if (template.status !== "DRAFT" && template.status !== "REJECTED") {
      res.status(400).json({ error: "Only DRAFT or REJECTED templates can be submitted to Meta" });
      return;
    }

    if (template.channel !== "WHATSAPP") {
      res.status(400).json({ error: "Only WhatsApp templates can be submitted to Meta" });
      return;
    }

    const resolved = await resolveWabaCreds(req.tenantId! as string, template);
    if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
    const { accessToken, wabaId } = resolved;

    const metaName = normalizeMetaName(template.name);
    if (!metaName) {
      res.status(400).json({ error: "Template name must contain at least one letter or digit" });
      return;
    }

    // For REJECTED resubmit: delete the existing rejected template on Meta so we can re-create with the same name
    if (template.status === "REJECTED") {
      const del = await deleteMetaTemplate(wabaId, accessToken, metaName, template.metaTemplateId);
      if (!del.ok && del.status !== 404) {
        console.warn("[submit-to-meta] prior delete non-ok:", del.status, del.data);
      }
    }

    const metaPayload = {
      name: metaName,
      category: (template.category || "UTILITY").toUpperCase(),
      language: template.language || "en",
      components: buildMetaComponents(template),
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

    const updated = await prisma.messageTemplate.update({
      where: { id: template.id },
      data: {
        status: "PENDING_APPROVAL",
        name: metaName,
        rejectionReason: null,
        metaTemplateId: metaData?.id ? String(metaData.id) : template.metaTemplateId,
      },
    });

    res.json({ data: updated, meta: metaData });
  } catch (err) {
    console.error("Submit template to Meta error:", err);
    res.status(500).json({ error: "Failed to submit template to Meta" });
  }
});

export default router;
