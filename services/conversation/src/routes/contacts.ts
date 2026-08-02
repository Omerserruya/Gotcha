import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requirePermissionOrRole,
  requireRole,
  outgoingMessageQueue,
  searchLeads as crmSearchLeads,
  searchContacts as crmSearchContacts,
  getConnectedCrm,
  type CrmRecord,
} from "@chatcenter/shared";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());
// Customer-context reads are permissioned (crm:contacts:read is part of every
// built-in role that handles conversations); ADMIN fallback covers tenants
// whose role rows predate the permission catalog.
router.use(requirePermissionOrRole("crm:contacts:read", "ADMIN"));

// GET / - Search contacts in the connected CRM only.
//
// Query params:
//   q       search across name / phone / email
//   limit   max rows (default 20)
//
// CRM is the source of truth for people-data. The platform's local Contact
// table is a write-side cache populated by inbound conversations; it is
// not surfaced through this endpoint anymore. When no CRM is connected
// the endpoint returns an empty list.
router.get("/", async (req: Request, res: Response) => {
  try {
    const { q, limit } = req.query;
    const limitNum = limit ? parseInt(limit as string, 10) : 20;
    const queryStr = typeof q === "string" ? q.trim() : "";

    const crm = await getConnectedCrm(req.tenantId!);
    if (!crm || !queryStr) {
      res.json({
        data: [],
        meta: { total: 0, page: 1, limit: limitNum, crmIncluded: !!crm },
      });
      return;
    }

    const looksLikeEmail = /@/.test(queryStr);
    const looksLikePhone = /^[+\d\s\-()]+$/.test(queryStr);
    const args = looksLikeEmail
      ? { email: queryStr }
      : looksLikePhone
        ? { phone: queryStr }
        : { name: queryStr };

    const [leads, contactsCrm] = await Promise.all([
      crmSearchLeads(req.tenantId!, args).catch(() => [] as CrmRecord[]),
      crmSearchContacts(req.tenantId!, args).catch(() => [] as CrmRecord[]),
    ]);

    // Dedupe across leads + contacts by phone/email (a person can be
    // filed in both modules in some CRMs).
    const seen = new Set<string>();
    const rows: any[] = [];
    for (const r of [...leads, ...contactsCrm]) {
      const key = (r.email || r.phone || r.id || "").toLowerCase();
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      rows.push({
        id: r.id,
        source: "crm",
        displayName: r.name,
        phone: r.phone,
        email: r.email,
        company: r.company,
        // Provider-native fields so per-recipient surfaces (scheduled,
        // conversation-initiate) can map template variables to any CRM
        // field without a second round-trip.
        raw: r.raw ?? null,
      });
      if (rows.length >= limitNum) break;
    }

    res.json({
      data: rows,
      meta: { total: rows.length, page: 1, limit: limitNum, crmIncluded: true },
    });
  } catch (err) {
    console.error("List contacts error:", err);
    res.status(500).json({ error: "Failed to list contacts" });
  }
});

// POST /initiate-conversation - must be before /:id to avoid conflict
router.post("/initiate-conversation", async (req: Request, res: Response) => {
  try {
    const { contactId, externalId, channel, channelAccountId, body, messageType, templateId, variables } = req.body;

    if (!channelAccountId) {
      res.status(400).json({ error: "channelAccountId is required" });
      return;
    }
    if (!body) {
      res.status(400).json({ error: "body is required" });
      return;
    }
    if (!contactId && !(externalId && channel)) {
      res.status(400).json({ error: "contactId or (externalId + channel) is required" });
      return;
    }
    if (messageType === "template" && !templateId) {
      res.status(400).json({ error: "templateId is required when messageType is 'template'" });
      return;
    }

    // Resolve the contact
    let contact;
    if (contactId) {
      contact = await prisma.contact.findFirst({
        where: { id: contactId, tenantId: req.tenantId! },
      });
    } else {
      contact = await prisma.contact.findFirst({
        where: { tenantId: req.tenantId!, channel: channel as any, externalId: externalId as string },
      });
    }

    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    // Find existing OPEN conversation or create a new one
    let conversation = await prisma.conversation.findFirst({
      where: {
        tenantId: req.tenantId!,
        customerExternalId: contact.externalId,
        channel: contact.channel,
        status: "OPEN",
      },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          tenantId: req.tenantId!,
          channel: contact.channel,
          channelAccountId,
          customerExternalId: contact.externalId,
          customerName: contact.displayName,
          assignedAgentId: req.user!.userId,
          status: "OPEN",
          lastMessageAt: new Date(),
        },
      });
    } else if (!conversation.assignedAgentId) {
      conversation = await prisma.conversation.update({
        where: { id: conversation.id },
        data: { assignedAgentId: req.user!.userId },
      });
    }

    // Create the outbound message with PENDING status
    const message = await prisma.message.create({
      data: {
        tenantId: req.tenantId!,
        conversationId: conversation.id,
        direction: "OUTBOUND",
        body,
        messageType: messageType || "text",
        status: "PENDING",
        senderName: req.user!.email,
      },
    });

    // Resolve template data when sending a template message (required for
    // WhatsApp first-contact outside the 24h service window).
    let templateData: any = {};
    if (messageType === "template" && templateId) {
      const tmpl = await prisma.messageTemplate.findFirst({
        where: { id: templateId, tenantId: req.tenantId! },
      });
      if (!tmpl) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      const varEntries = variables && typeof variables === "object" ? Object.entries(variables) : [];
      const ordered = varEntries
        .map(([k, v]) => ({ idx: parseInt(k, 10), value: String(v ?? "") }))
        .filter((e) => !Number.isNaN(e.idx))
        .sort((a, b) => a.idx - b.idx);
      templateData = {
        templateName: tmpl.name,
        templateLanguage: tmpl.language || "en",
        templateComponents: ordered.length
          ? [{ type: "body", parameters: ordered.map((e) => ({ type: "text", text: e.value })) }]
          : [],
      };
    }

    // Enqueue to outgoingMessageQueue
    await outgoingMessageQueue.add("send", {
      tenantId: req.tenantId!,
      conversationId: conversation.id,
      channel: contact.channel,
      channelAccountId,
      recipientExternalId: contact.externalId,
      body,
      messageType: messageType || "text",
      senderName: req.user!.email,
      messageId: message.id,
      ...templateData,
    }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });

    res.status(201).json({ data: { conversation, message } });
  } catch (err) {
    console.error("Initiate conversation error:", err);
    res.status(500).json({ error: "Failed to initiate conversation" });
  }
});

// GET /:id - Get single contact with conversation history count per channel
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });

    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    // Count conversations per channel for this contact
    const conversationCounts = await prisma.conversation.groupBy({
      by: ["channel"],
      where: {
        tenantId: req.tenantId!,
        customerExternalId: contact.externalId,
      },
      _count: { id: true },
    });

    const historyByChannel = conversationCounts.reduce<Record<string, number>>((acc, row) => {
      acc[row.channel] = row._count.id;
      return acc;
    }, {});

    res.json({ data: { ...contact, historyByChannel } });
  } catch (err) {
    console.error("Get contact error:", err);
    res.status(500).json({ error: "Failed to get contact" });
  }
});

// ─── Query Contact Segment ──────────────────────────────────
router.post("/segment", async (req: Request, res: Response) => {
  try {
    const { rules, channel, countOnly } = req.body;

    const where: any = { tenantId: req.tenantId! };
    if (channel) where.channel = channel;

    if (Array.isArray(rules)) {
      const AND: any[] = [];

      for (const rule of rules) {
        switch (rule.field) {
          case "channel":
            where.channel = rule.value;
            break;
          case "tag":
            AND.push({ tags: { array_contains: [rule.value] } });
            break;
          case "hasTag":
            AND.push({ tags: { array_contains: [rule.value] } });
            break;
          case "phone":
            if (rule.operator === "contains") AND.push({ phone: { contains: rule.value } });
            else if (rule.operator === "startsWith") AND.push({ phone: { startsWith: rule.value } });
            else AND.push({ phone: rule.value });
            break;
          case "email":
            if (rule.operator === "contains") AND.push({ email: { contains: rule.value, mode: "insensitive" } });
            else AND.push({ email: { equals: rule.value, mode: "insensitive" } });
            break;
          case "lastSeenAfter":
            AND.push({ lastSeenAt: { gte: new Date(rule.value) } });
            break;
          case "lastInteractionAfter":
            AND.push({ lastInteractionAt: { gte: new Date(rule.value) } });
            break;
          case "lastInteractionBefore":
            AND.push({ lastInteractionAt: { lte: new Date(rule.value) } });
            break;
          case "inactiveDays": {
            const daysAgo = new Date();
            daysAgo.setDate(daysAgo.getDate() - parseInt(rule.value, 10));
            AND.push({ lastInteractionAt: { lte: daysAgo } });
            break;
          }
          case "source":
            if (rule.operator === "contains") AND.push({ source: { contains: rule.value } });
            else AND.push({ source: rule.value });
            break;
          case "createdAfter":
            AND.push({ createdAt: { gte: new Date(rule.value) } });
            break;
          case "createdBefore":
            AND.push({ createdAt: { lte: new Date(rule.value) } });
            break;
          case "optedOut":
            if (rule.value === "false" || rule.value === false) {
              AND.push({
                OR: [
                  { optOutChannels: { equals: [] } },
                  { optOutChannels: { equals: null } },
                ],
              });
            }
            break;
        }
      }

      if (AND.length > 0) where.AND = AND;
    }

    const count = await prisma.contact.count({ where });

    if (countOnly) {
      res.json({ data: [], total: count });
      return;
    }

    const contacts = await prisma.contact.findMany({
      where,
      take: 500,
      select: { id: true, externalId: true, displayName: true, channel: true, phone: true, email: true, tags: true, lastInteractionAt: true, source: true },
      orderBy: { lastSeenAt: "desc" },
    });

    res.json({ data: contacts, total: count });
  } catch (err) {
    console.error("Segment query error:", err);
    res.status(500).json({ error: "Failed to query contacts" });
  }
});

// POST / - Create contact
router.post("/", async (req: Request, res: Response) => {
  try {
    const { externalId, channel, displayName, email, phone, metadata } = req.body;

    if (!externalId || !channel) {
      res.status(400).json({ error: "externalId and channel are required" });
      return;
    }

    const contact = await prisma.contact.upsert({
      where: {
        tenantId_channel_externalId: {
          tenantId: req.tenantId!,
          channel: channel as any,
          externalId: externalId as string,
        },
      },
      update: {
        ...(displayName !== undefined && { displayName }),
        ...(email !== undefined && { email }),
        ...(phone !== undefined && { phone }),
        ...(metadata !== undefined && { metadata }),
      },
      create: {
        tenantId: req.tenantId!,
        externalId,
        channel,
        displayName,
        email,
        phone,
        metadata,
      },
    });

    res.status(201).json({ data: contact });
  } catch (err) {
    console.error("Create contact error:", err);
    res.status(500).json({ error: "Failed to create contact" });
  }
});

// PATCH /:id - Update contact
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const { displayName, email, phone, metadata } = req.body;

    const existing = await prisma.contact.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });

    if (!existing) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: {
        ...(displayName !== undefined && { displayName }),
        ...(email !== undefined && { email }),
        ...(phone !== undefined && { phone }),
        ...(metadata !== undefined && { metadata }),
      },
    });

    res.json({ data: contact });
  } catch (err) {
    console.error("Update contact error:", err);
    res.status(500).json({ error: "Failed to update contact" });
  }
});

// ─── Opt-Out Management ─────────────────────────────────────
router.post("/:id/opt-out", async (req: Request, res: Response) => {
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }

    const { channel, optOut } = req.body; // channel: string, optOut: boolean
    const currentOptOut = (contact.optOutChannels as string[]) || [];

    let newOptOut: string[];
    if (optOut) {
      newOptOut = [...new Set([...currentOptOut, channel])];
    } else {
      newOptOut = currentOptOut.filter((c: string) => c !== channel);
    }

    const updated = await prisma.contact.update({
      where: { id: contact.id },
      data: {
        optOutChannels: newOptOut,
        optedOutAt: newOptOut.length > 0 ? (contact.optedOutAt || new Date()) : null,
      },
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Opt-out error:", err);
    res.status(500).json({ error: "Failed to update opt-out" });
  }
});

export default router;
