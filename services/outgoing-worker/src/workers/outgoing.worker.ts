import { Job } from "bullmq";
import { prisma, createWorker, OutgoingMessageJob, analyticsQueue, publishEvent, getOutboundAdapter, decryptCredentials } from "@chatcenter/shared";
import type { ChannelCredentials } from "@chatcenter/shared";

const MEDIA_MESSAGE_TYPES = ["image", "video", "document"];

async function processOutgoingMessage(job: Job<OutgoingMessageJob>): Promise<void> {
  const { tenantId, channel, channelAccountId, recipientExternalId, body, messageId, messageType, mediaUrl, fileName } = job.data;

  // Resolve channel account credentials
  const channelAccount = await prisma.channelAccount.findUnique({ where: { id: channelAccountId } });
  if (!channelAccount) {
    console.error(`Channel account not found: ${channelAccountId}`);
    await prisma.message.update({ where: { id: messageId }, data: { status: "FAILED" } });
    return;
  }

  const rawCreds = channelAccount.credentials;
  const credentials = (typeof rawCreds === "string" ? decryptCredentials(rawCreds) : rawCreds) as ChannelCredentials;
  const adapter = getOutboundAdapter(channel);
  if (!adapter) {
    console.error(`No outbound adapter for channel: ${channel}`);
    await prisma.message.update({ where: { id: messageId }, data: { status: "FAILED" } });
    return;
  }

  let externalMessageId: string | null = null;

  // Send media or text message
  if (MEDIA_MESSAGE_TYPES.includes(messageType) && mediaUrl && adapter.sendMediaMessage) {
    externalMessageId = await adapter.sendMediaMessage(
      credentials,
      channelAccount.externalId,
      recipientExternalId,
      mediaUrl,
      messageType as "image" | "video" | "document",
      fileName,
      body || undefined
    );
  } else {
    externalMessageId = await adapter.sendTextMessage(
      credentials,
      channelAccount.externalId,
      recipientExternalId,
      body
    );
  }

  const status = externalMessageId ? "SENT" : "FAILED";

  await prisma.message.update({
    where: { id: messageId },
    data: { status, externalMessageId },
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

  // Track usage + audit for sent messages (fire-and-forget)
  if (status === "SENT") {
    prisma.usageLog.create({
      data: {
        tenantId,
        type: "message_sent",
        quantity: 1,
        tokensEquivalent: 1, // actual: 1 message sent
        metadata: { channel, conversationId: job.data.conversationId, messageId },
      },
    }).catch((err: any) => console.error("[outgoing] Usage tracking failed:", err.message));

    prisma.auditLog.create({
      data: {
        tenantId,
        actorType: "system",
        action: "message.sent",
        targetType: "conversation",
        targetId: job.data.conversationId,
        metadata: { messageId, channel, status },
      },
    }).catch((err: any) => console.error("[outgoing] Audit logging failed:", err.message));
  }

  if (!externalMessageId && (job.data.retryCount || 0) < 3) {
    throw new Error(`${channel} send failed - will retry`);
  }
}

let worker: any;
export function startOutgoingWorker() {
  worker = createWorker<OutgoingMessageJob>("outgoing-messages", processOutgoingMessage, 5);
  console.log("[outgoing-worker] Outgoing message worker started");
}
