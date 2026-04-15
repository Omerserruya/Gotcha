import { Router, Request, Response } from "express";
import { prisma, incomingMessageQueue, withCrossTenantAccess } from "@chatcenter/shared";
import crypto from "crypto";

const router = Router();

// POST /api/embedded-chat/init — Initialize a chat session (public, no auth)
router.post("/init", async (req: Request, res: Response) => {
  try {
    const { widgetId, visitorId, sessionId, visitorName, pageUrl } = req.body;

    if (!widgetId) {
      res.status(400).json({ error: "widgetId is required" });
      return;
    }

    // Find the channel account for this widget. Widget init is public — the
    // anonymous caller has no tenant context yet, and widgetId is globally
    // unique by design, so this lookup MUST be cross-tenant. We then derive
    // tenantId from the channel account and scope everything downstream to it.
    const channelAccount = await withCrossTenantAccess(
      async () =>
        await prisma.channelAccount.findFirst({
          where: { externalId: widgetId, channel: "WEBCHAT", connectionStatus: "CONNECTED" },
        }),
    );

    if (!channelAccount) {
      res.status(404).json({ error: "Widget not found or not active" });
      return;
    }

    const finalVisitorId = visitorId || `visitor_${crypto.randomBytes(8).toString("hex")}`;
    const finalSessionId = sessionId || `sess_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    // Find conversation for THIS session first (tab-level isolation)
    // sessionId is stored as customerExternalId so each tab gets its own conversation
    let conversation = await prisma.conversation.findFirst({
      where: {
        tenantId: channelAccount.tenantId,
        channel: "WEBCHAT",
        customerExternalId: finalSessionId,
        status: { in: ["OPEN", "WAITING"] },
      },
      orderBy: { updatedAt: "desc" },
    });

    // If no session-specific conversation, find by visitor (returning user in new tab)
    if (!conversation) {
      conversation = await prisma.conversation.findFirst({
        where: {
          tenantId: channelAccount.tenantId,
          customerExternalId: finalVisitorId,
          channel: "WEBCHAT",
          status: { in: ["OPEN", "WAITING"] },
        },
        orderBy: { updatedAt: "desc" },
      });
    }

    if (!conversation) {
      // Generate a readable visitor name
      let displayName = visitorName || "Website Visitor";
      if (!visitorName && pageUrl) {
        try {
          const hostname = new URL(pageUrl).hostname.replace("www.", "");
          displayName = `Visitor from ${hostname}`;
        } catch {}
      }

      conversation = await prisma.conversation.create({
        data: {
          tenantId: channelAccount.tenantId,
          channelAccountId: channelAccount.id,
          channel: "WEBCHAT",
          customerExternalId: finalSessionId,
          customerName: displayName,
          status: "OPEN",
        },
      });
    }

    res.json({
      data: {
        sessionId: conversation.id,
        visitorId: finalVisitorId,
        sessionToken: finalSessionId,
        tenantId: channelAccount.tenantId,
      },
    });
  } catch (err) {
    console.error("Embedded chat init error:", err);
    res.status(500).json({ error: "Failed to initialize chat" });
  }
});

// POST /api/embedded-chat/message — Send a message (public)
router.post("/message", async (req: Request, res: Response) => {
  try {
    const { sessionId, visitorId, body } = req.body;

    if (!sessionId || !body) {
      res.status(400).json({ error: "sessionId and body are required" });
      return;
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: sessionId },
    });

    if (!conversation) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const externalMessageId = `widget_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    // Enqueue to the incoming message pipeline so webchat goes through
    // the same routing rules, AI agent processing, and department assignment
    // as all other channels (WhatsApp, Instagram, Email, etc.)
    await incomingMessageQueue.add(
      "process",
      {
        tenantId: conversation.tenantId,
        channel: "WEBCHAT",
        channelAccountId: conversation.channelAccountId || "",
        normalizedMessage: {
          externalMessageId,
          senderId: conversation.customerExternalId || visitorId || "visitor",
          senderDisplayName: conversation.customerName || "Visitor",
          timestamp: new Date().toISOString(),
          contentType: "text",
          body,
          messageType: "text",
        },
      },
      { attempts: 3, backoff: { type: "exponential", delay: 1000 } }
    );

    res.json({ data: { messageId: externalMessageId } });
  } catch (err) {
    console.error("Embedded chat message error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// GET /api/embedded-chat/messages/:sessionId — Get messages for a session (public)
router.get("/messages/:sessionId", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const after = req.query.after as string | undefined;

    const conversation = await prisma.conversation.findUnique({
      where: { id: sessionId },
      select: { tenantId: true },
    });
    if (!conversation) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const where: any = { tenantId: conversation.tenantId, conversationId: sessionId };
    if (after) {
      where.createdAt = { gt: new Date(after) };
    }

    const messages = await prisma.message.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: 100,
      select: {
        id: true,
        direction: true,
        body: true,
        senderName: true,
        createdAt: true,
      },
    });

    res.json({ data: messages });
  } catch (err) {
    console.error("Embedded chat messages error:", err);
    res.status(500).json({ error: "Failed to get messages" });
  }
});

export default router;
