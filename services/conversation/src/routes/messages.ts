import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma, authenticate, resolveTenant, validate, outgoingMessageQueue } from "@chatcenter/shared";
import * as messageService from "../services/message.service";

const router = Router();
router.use(authenticate, resolveTenant);

const sendMessageSchema = z.object({
  body: z.string().min(1),
  messageType: z.string().optional(),
});

router.get("/:conversationId/messages", async (req: Request, res: Response) => {
  try {
    const { page, limit } = req.query;
    const result = await messageService.listByConversation(
      req.tenantId!, req.params.conversationId as string,
      { page: page ? parseInt(page as string, 10) : undefined, limit: limit ? parseInt(limit as string, 10) : undefined }
    );
    res.json(result);
  } catch (err) {
    console.error("List messages error:", err);
    res.status(500).json({ error: "Failed to list messages" });
  }
});

router.post("/:conversationId/messages", validate(sendMessageSchema), async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.conversationId as string;
    const { body, messageType } = req.body;

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId: req.tenantId! },
      include: { channelAccount: true },
    });
    if (!conversation) { res.status(404).json({ error: "Conversation not found" }); return; }

    // Resolve channel credentials - try channel account first, then legacy tenant config
    const channel = conversation.channel || "WHATSAPP";
    const recipientId = conversation.customerExternalId || conversation.customerPhone;

    let channelAccountId = conversation.channelAccountId;
    let hasCredentials = false;

    if (conversation.channelAccount) {
      const creds = conversation.channelAccount.credentials as any;
      hasCredentials = !!creds?.accessToken;
    }

    // Legacy fallback for WhatsApp
    if (!hasCredentials && channel === "WHATSAPP") {
      const tenant = await prisma.tenant.findUnique({ where: { id: req.tenantId! } });
      if (!tenant?.waPhoneNumberId || !tenant?.waAccessToken) {
        res.status(400).json({ error: "Channel not configured for this tenant" }); return;
      }

      // Create message in PENDING state
      const message = await messageService.create({
        tenantId: req.tenantId!,
        conversationId,
        direction: "OUTBOUND",
        body,
        messageType,
        senderName: req.user!.email,
      });

      // Queue with legacy fields for backward compat
      await outgoingMessageQueue.add("send", {
        tenantId: req.tenantId!,
        conversationId,
        channel: "WHATSAPP",
        channelAccountId: channelAccountId || "",
        recipientExternalId: recipientId,
        body,
        messageType: messageType || "text",
        senderName: req.user!.email,
        messageId: message.id,
        // Legacy
        customerPhone: conversation.customerPhone || recipientId,
        phoneNumberId: tenant.waPhoneNumberId,
        accessToken: tenant.waAccessToken,
      }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });

      res.status(201).json({ data: message });
      return;
    }

    if (!hasCredentials) {
      res.status(400).json({ error: "Channel not configured for this tenant" }); return;
    }

    // New channel-aware path
    const message = await messageService.create({
      tenantId: req.tenantId!,
      conversationId,
      direction: "OUTBOUND",
      body,
      messageType,
      senderName: req.user!.email,
    });

    await outgoingMessageQueue.add("send", {
      tenantId: req.tenantId!,
      conversationId,
      channel,
      channelAccountId: channelAccountId!,
      recipientExternalId: recipientId,
      body,
      messageType: messageType || "text",
      senderName: req.user!.email,
      messageId: message.id,
    }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });

    res.status(201).json({ data: message });
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

export default router;
