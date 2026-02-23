import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma, authenticate, resolveTenant, validate, outgoingMessageQueue, decryptCredentials } from "@chatcenter/shared";
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

    const channel = conversation.channel || "WHATSAPP";
    const recipientId = conversation.customerExternalId;

    if (!conversation.channelAccount) {
      res.status(400).json({ error: "Channel not configured for this tenant" }); return;
    }

    const rawCreds = conversation.channelAccount.credentials;
    const creds = typeof rawCreds === "string" ? decryptCredentials(rawCreds) : (rawCreds as any);
    if (!creds?.accessToken) {
      res.status(400).json({ error: "Channel not configured for this tenant" }); return;
    }

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
      channelAccountId: conversation.channelAccountId!,
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
