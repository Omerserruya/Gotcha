import { Job } from "bullmq";
import { prisma, createWorker, OutgoingMessageJob, analyticsQueue, publishEvent, getOutboundAdapter, decryptCredentials } from "@chatcenter/shared";
import type { ChannelCredentials } from "@chatcenter/shared";

async function processOutgoingMessage(job: Job<OutgoingMessageJob>): Promise<void> {
  const { tenantId, channel, channelAccountId, recipientExternalId, body, messageId } = job.data;

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

  const externalMessageId = await adapter.sendTextMessage(
    credentials,
    channelAccount.externalId,
    recipientExternalId,
    body
  );

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

  if (!externalMessageId && (job.data.retryCount || 0) < 3) {
    throw new Error(`${channel} send failed - will retry`);
  }
}

let worker: any;
export function startOutgoingWorker() {
  worker = createWorker<OutgoingMessageJob>("outgoing-messages", processOutgoingMessage, 5);
  console.log("[outgoing-worker] Outgoing message worker started");
}
