import { Job } from "bullmq";
import { prisma, createWorker, OutgoingMessageJob, analyticsQueue, publishEvent } from "@chatcenter/shared";
import axios from "axios";
import { getIO } from "../lib/socket";

const WA_API_URL = process.env.WHATSAPP_API_URL || "https://graph.facebook.com/v19.0";

async function sendWhatsAppMessage(phoneNumberId: string, accessToken: string, to: string, text: string): Promise<string | null> {
  try {
    const response = await axios.post(`${WA_API_URL}/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp", to, type: "text", text: { body: text },
    }, { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } });
    return response.data?.messages?.[0]?.id || null;
  } catch (err: any) {
    console.error("WhatsApp send error:", err.response?.data || err.message);
    return null;
  }
}

async function processOutgoingMessage(job: Job<OutgoingMessageJob>): Promise<void> {
  const { tenantId, customerPhone, phoneNumberId, accessToken, body, messageId } = job.data;
  const waMessageId = await sendWhatsAppMessage(phoneNumberId, accessToken, customerPhone, body);
  const status = waMessageId ? "SENT" : "FAILED";

  await prisma.message.update({ where: { id: messageId }, data: { status, waMessageId } });

  const eventData = { messageId, conversationId: job.data.conversationId, status, waMessageId };
  try { getIO().to(`tenant:${tenantId}`).emit("message:status", eventData); } catch {}
  publishEvent({ event: "message:status", tenantId, data: eventData }).catch(() => {});

  await analyticsQueue.add("message-sent", {
    tenantId, event: "message_sent",
    data: { conversationId: job.data.conversationId, messageId, status },
    timestamp: new Date().toISOString(),
  });

  if (!waMessageId && (job.data.retryCount || 0) < 3) throw new Error("WhatsApp send failed - will retry");
}

let worker: any;
export function startOutgoingWorker() {
  worker = createWorker<OutgoingMessageJob>("outgoing-messages", processOutgoingMessage, 5);
  console.log("[conversation-service] Outgoing message worker started");
}
