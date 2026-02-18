import { Job } from "bullmq";
import { prisma, createWorker, OutgoingMessageJob, analyticsQueue, publishEvent, getOutboundAdapter } from "@chatcenter/shared";
import type { ChannelCredentials } from "@chatcenter/shared";
import axios from "axios";

const WA_API_URL = process.env.WHATSAPP_API_URL || "https://graph.facebook.com/v19.0";

async function processOutgoingMessage(job: Job<OutgoingMessageJob>): Promise<void> {
  const { tenantId, channel, channelAccountId, recipientExternalId, body, messageId } = job.data;

  // New channel-aware path
  if (channel && channelAccountId) {
    return processViaAdapter(job);
  }

  // Legacy WhatsApp-only path (backward compat)
  return processLegacy(job);
}

async function processViaAdapter(job: Job<OutgoingMessageJob>): Promise<void> {
  const { tenantId, channel, channelAccountId, recipientExternalId, body, messageId } = job.data;

  // Resolve channel account credentials
  const channelAccount = await prisma.channelAccount.findUnique({ where: { id: channelAccountId } });
  if (!channelAccount) {
    console.error(`Channel account not found: ${channelAccountId}`);
    await prisma.message.update({ where: { id: messageId }, data: { status: "FAILED" } });
    return;
  }

  const credentials = channelAccount.credentials as any as ChannelCredentials;
  const adapter = getOutboundAdapter(channel);
  if (!adapter) {
    console.error(`No outbound adapter for channel: ${channel}`);
    await prisma.message.update({ where: { id: messageId }, data: { status: "FAILED" } });
    return;
  }

  const externalMessageId = await adapter.sendTextMessage(
    credentials,
    channelAccount.externalId,
    recipientExternalId,
    body
  );

  const status = externalMessageId ? "SENT" : "FAILED";

  await prisma.message.update({
    where: { id: messageId },
    data: {
      status,
      externalMessageId,
      waMessageId: channel === "WHATSAPP" ? externalMessageId : undefined,
    },
  });

  await publishEvent({
    event: "message:status",
    tenantId,
    data: { messageId, conversationId: job.data.conversationId, status, externalMessageId },
  });

  await analyticsQueue.add("message-sent", {
    tenantId,
    event: "message_sent",
    data: { conversationId: job.data.conversationId, messageId, status, channel },
    timestamp: new Date().toISOString(),
  });

  if (!externalMessageId && (job.data.retryCount || 0) < 3) {
    throw new Error(`${channel} send failed - will retry`);
  }
}

// Legacy path: direct WhatsApp API call (for messages enqueued before migration)
async function processLegacy(job: Job<OutgoingMessageJob>): Promise<void> {
  const { tenantId, customerPhone, phoneNumberId, accessToken, body, messageId } = job.data;

  let waMessageId: string | null = null;
  if (phoneNumberId && accessToken && customerPhone) {
    try {
      const response = await axios.post(`${WA_API_URL}/${phoneNumberId}/messages`, {
        messaging_product: "whatsapp", to: customerPhone, type: "text", text: { body },
      }, { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } });
      waMessageId = response.data?.messages?.[0]?.id || null;
    } catch (err: any) {
      console.error("WhatsApp send error:", err.response?.data || err.message);
    }
  }

  const status = waMessageId ? "SENT" : "FAILED";
  await prisma.message.update({ where: { id: messageId }, data: { status, waMessageId, externalMessageId: waMessageId } });

  const eventData = { messageId, conversationId: job.data.conversationId, status, waMessageId };
  await publishEvent({ event: "message:status", tenantId, data: eventData });

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
  console.log("[outgoing-worker] Outgoing message worker started");
}
