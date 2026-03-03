import { Router, Request, Response } from "express";
import {
  prisma,
  incomingMessageQueue,
  publishEvent,
  detectInboundAdapter,
} from "@chatcenter/shared";
import type { NormalizedInboundMessage, NormalizedStatusUpdate } from "@chatcenter/shared";

const router = Router();

// Webhook verification (GET) - shared by WhatsApp and Messenger
router.get("/", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && token === verifyToken) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.status(403).send("Forbidden");
  }
});

// Unified webhook handler (POST) - detects platform via adapter pattern
router.post("/", async (req: Request, res: Response) => {
  // Always respond 200 quickly (required by both WhatsApp and Messenger)
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log(`[WEBHOOK] Incoming: object=${body?.object}, entries=${body?.entry?.length || 0}`, JSON.stringify(body).slice(0, 500));

    // Step 1: Detect which platform sent this webhook
    const adapter = detectInboundAdapter(body);
    if (!adapter) {
      console.warn("Webhook received from unknown platform:", body?.object);
      return;
    }

    // Step 2: Verify signature
    const signatureHeader = adapter.getSignatureHeader();
    const signature = req.headers[signatureHeader] as string;
    if (signature) {
      // Try channel account secret first, fall back to app secret
      const appSecret = process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET;
      const rawBody = (req as any).rawBody;
      if (appSecret && rawBody && !adapter.verifySignature(appSecret, rawBody, signature)) {
        console.error(`Invalid webhook signature for ${adapter.channel}`);
        return;
      }
    }

    // Step 3: Resolve tenant via ChannelAccount
    const channelExternalId = adapter.resolveChannelAccountExternalId(body);
    if (!channelExternalId) {
      console.warn(`No channel account ID found in ${adapter.channel} webhook`);
      return;
    }

    const channelAccount = await prisma.channelAccount.findFirst({
      where: { externalId: channelExternalId, channel: adapter.channel, isActive: true },
    });

    if (!channelAccount) {
      console.warn(`No channel account found for ${adapter.channel} account: ${channelExternalId}`);
      return;
    }

    const tenantId = channelAccount.tenantId;
    const channelAccountId = channelAccount.id;

    // Step 4: Extract and enqueue normalized messages
    const messages = adapter.extractMessages(body);
    for (const msg of messages) {
      const { body: msgBody, messageType } = normalizeContentToBodyAndType(msg);
      await incomingMessageQueue.add(
        "process",
        {
          tenantId,
          channel: adapter.channel,
          channelAccountId,
          normalizedMessage: {
            externalMessageId: msg.externalMessageId,
            senderId: msg.senderId,
            senderDisplayName: msg.senderDisplayName,
            timestamp: msg.timestamp.toISOString(),
            contentType: msg.content.type,
            body: msgBody,
            messageType,
            interactiveReply: msg.content.interactiveReply,
          },
        },
        { attempts: 3, backoff: { type: "exponential", delay: 1000 } }
      );
    }

    // Step 5: Handle status updates inline (lightweight)
    const statusUpdates = adapter.extractStatusUpdates(body);
    for (const status of statusUpdates) {
      await handleStatusUpdate(tenantId, status);
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

// ─── Helpers ─────────────────────────────────────────────────

function normalizeContentToBodyAndType(msg: NormalizedInboundMessage): { body: string; messageType: string } {
  const content = msg.content;
  if (content.interactiveReply) {
    return { body: content.interactiveReply.title || content.text || "", messageType: "interactive" };
  }
  switch (content.type) {
    case "text":
      return { body: content.text || "", messageType: "text" };
    case "image":
      return { body: content.caption || "[Image]", messageType: "image" };
    case "document":
      return { body: content.caption || "[Document]", messageType: "document" };
    case "audio":
      return { body: content.text || "[Audio message]", messageType: "audio" };
    case "video":
      return { body: content.caption || "[Video]", messageType: "video" };
    case "location":
      return { body: content.text || "[Location]", messageType: "location" };
    default:
      return { body: content.text || `[${content.type} message]`, messageType: content.type };
  }
}

async function handleStatusUpdate(tenantId: string, status: NormalizedStatusUpdate) {
  const statusMap: Record<string, string> = {
    sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED",
  };
  const mappedStatus = statusMap[status.status];
  if (!mappedStatus) return;

  const message = await prisma.message.findFirst({
    where: { externalMessageId: status.externalMessageId },
  });

  if (message) {
    await prisma.message.update({
      where: { id: message.id },
      data: { status: mappedStatus as any },
    });
    await publishEvent({
      event: "message:status",
      tenantId,
      data: {
        messageId: message.id,
        conversationId: message.conversationId,
        status: mappedStatus,
      },
    });
  }
}

// ─── Email Webhook (POST) ──────────────────────────────────────
router.post("/email", async (req: Request, res: Response) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log(`[WEBHOOK] Email incoming from: ${body?.from}`);

    // Use the email adapter directly
    const { emailInboundAdapter } = await import("@chatcenter/shared");

    if (!emailInboundAdapter.canHandle(body)) {
      console.warn("Email webhook: invalid payload");
      return;
    }

    // Resolve channel account by recipient email
    const recipientEmail = emailInboundAdapter.resolveChannelAccountExternalId(body);
    if (!recipientEmail) {
      console.warn("Email webhook: no recipient found");
      return;
    }

    const channelAccount = await prisma.channelAccount.findFirst({
      where: { externalId: recipientEmail, channel: "EMAIL", isActive: true },
    });

    if (!channelAccount) {
      console.warn(`No email channel account found for: ${recipientEmail}`);
      return;
    }

    const tenantId = channelAccount.tenantId;
    const channelAccountId = channelAccount.id;

    // Extract and enqueue messages
    const messages = emailInboundAdapter.extractMessages(body);
    for (const msg of messages) {
      await incomingMessageQueue.add(
        "process",
        {
          tenantId,
          channel: "EMAIL",
          channelAccountId,
          normalizedMessage: {
            externalMessageId: msg.externalMessageId,
            senderId: msg.senderId,
            senderDisplayName: msg.senderDisplayName,
            timestamp: msg.timestamp.toISOString(),
            contentType: msg.content.type,
            body: msg.content.text || "",
            messageType: "email",
          },
        },
        { attempts: 3, backoff: { type: "exponential", delay: 1000 } }
      );
    }
  } catch (err) {
    console.error("Email webhook error:", err);
  }
});

export default router;
