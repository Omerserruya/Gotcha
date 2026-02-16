import { Router, Request, Response } from "express";
import { prisma, incomingMessageQueue } from "@chatcenter/shared";
import { verifyWebhookSignature } from "../services/whatsapp.service";

const router = Router();

// Webhook verification (GET)
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

// Webhook handler (POST) - receives incoming messages and status updates
// Pattern: handler -> queue -> worker
router.post("/", async (req: Request, res: Response) => {
  // Always respond 200 quickly to WhatsApp
  res.sendStatus(200);

  try {
    // Verify signature if app secret is configured
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (appSecret && req.headers["x-hub-signature-256"]) {
      const signature = req.headers["x-hub-signature-256"] as string;
      const rawBody = (req as any).rawBody;
      if (rawBody && !verifyWebhookSignature(appSecret, rawBody, signature)) {
        console.error("Invalid webhook signature");
        return;
      }
    }

    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value;
        const phoneNumberId = value.metadata?.phone_number_id;

        // Find tenant by phone number ID
        const tenant = await prisma.tenant.findFirst({
          where: { waPhoneNumberId: phoneNumberId },
        });
        if (!tenant) {
          console.warn(`No tenant found for phone number ID: ${phoneNumberId}`);
          continue;
        }

        // Enqueue incoming messages for async processing (handler -> queue -> worker)
        if (value.messages) {
          for (const msg of value.messages) {
            await incomingMessageQueue.add(
              "process",
              { tenantId: tenant.id, phoneNumberId, message: msg, contacts: value.contacts || [] },
              { attempts: 3, backoff: { type: "exponential", delay: 1000 } }
            );
          }
        }

        // Handle status updates inline (lightweight)
        if (value.statuses) {
          for (const status of value.statuses) {
            await handleStatusUpdate(tenant.id, status);
          }
        }
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

async function handleStatusUpdate(tenantId: string, status: any) {
  const waMessageId = status.id;
  const statusValue = status.status;
  const statusMap: Record<string, string> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };
  const mappedStatus = statusMap[statusValue];
  if (!mappedStatus) return;

  const message = await prisma.message.findFirst({ where: { waMessageId } });
  if (message) {
    await prisma.message.update({ where: { id: message.id }, data: { status: mappedStatus as any } });
    // Publish status event for conversation-service to relay via Socket.IO
    const { publishEvent } = await import("@chatcenter/shared");
    await publishEvent({
      event: "message:status",
      tenantId,
      data: { messageId: message.id, conversationId: message.conversationId, status: mappedStatus },
    });
  }
}

export default router;
