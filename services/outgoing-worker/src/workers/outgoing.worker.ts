import { Job } from "bullmq";
import { prisma, createWorker, OutgoingMessageJob, analyticsQueue, publishEvent, getOutboundAdapter, decryptCredentials, describeSendError } from "@chatcenter/shared";
import type { ChannelCredentials, ProviderSendError } from "@chatcenter/shared";
import { recordBroadcastResult } from "./broadcast.worker";

const MEDIA_MESSAGE_TYPES = ["image", "video", "document"];

async function processOutgoingMessage(job: Job<OutgoingMessageJob>): Promise<void> {
  const { tenantId, channel, channelAccountId, recipientExternalId, body, messageId, messageType, mediaUrl, fileName, broadcastId, broadcastRecipientId } = job.data;

  const channelAccount = await prisma.channelAccount.findUnique({ where: { id: channelAccountId } });
  if (!channelAccount) {
    const errMsg = `Channel account not found: ${channelAccountId}`;
    console.error(errMsg);
    await prisma.message.update({ where: { id: messageId }, data: { status: "FAILED" } });
    await recordBroadcastResult({ tenantId, broadcastId, broadcastRecipientId, success: false, errorMessage: errMsg });
    return;
  }

  const rawCreds = channelAccount.credentials;
  const credentials = (typeof rawCreds === "string" ? decryptCredentials(rawCreds) : rawCreds) as ChannelCredentials;
  const adapter = getOutboundAdapter(channel);
  if (!adapter) {
    const errMsg = `No outbound adapter for channel: ${channel}`;
    console.error(errMsg);
    await prisma.message.update({ where: { id: messageId }, data: { status: "FAILED" } });
    await recordBroadcastResult({ tenantId, broadcastId, broadcastRecipientId, success: false, errorMessage: errMsg });
    return;
  }

  let externalMessageId: string | null = null;
  let sendError: string | null = null;
  let sendErrorDetail: ProviderSendError | null = null;

  try {
    if (messageType === "template" && adapter.sendTemplateMessage) {
      const { templateName, templateLanguage, templateComponents } = job.data as any;
      externalMessageId = await adapter.sendTemplateMessage(
        credentials,
        channelAccount.externalId,
        recipientExternalId,
        templateName,
        templateLanguage || "en",
        templateComponents
      );
    } else if (MEDIA_MESSAGE_TYPES.includes(messageType) && mediaUrl && adapter.sendMediaMessage) {
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
  } catch (err: any) {
    const described = describeSendError(err, channel);
    sendError = described.errorMessage;
    sendErrorDetail = described.sendError;
    // Structured so it's diagnosable from the DB/UI without server logs.
    console.error(`[outgoing] ${channel} adapter error:`, JSON.stringify(sendErrorDetail));
  }

  const status = externalMessageId ? "SENT" : "FAILED";

  // Merge the structured provider error into the row's existing metadata JSON
  // (Prisma replaces the whole column, so read-then-merge to avoid clobbering
  // whatever the enqueuer stored). Persisted at `metadata.sendError` so the
  // failed send is fully diagnosable from the DB/UI without server logs.
  let metadataUpdate: Record<string, any> | undefined;
  if (sendErrorDetail) {
    const existing = await prisma.message.findUnique({
      where: { id: messageId },
      select: { metadata: true },
    });
    const base = (existing?.metadata && typeof existing.metadata === "object")
      ? (existing.metadata as Record<string, any>)
      : {};
    metadataUpdate = { ...base, sendError: sendErrorDetail };
  }

  const updatedMessage = await prisma.message.update({
    where: { id: messageId },
    data: {
      status,
      externalMessageId,
      errorMessage: sendError || undefined,
      ...(metadataUpdate ? { metadata: metadataUpdate } : {}),
    },
  });

  // If this Message was produced by a scheduled-message job, mirror the
  // final outcome onto the ScheduledMessage row so the Scheduled tab
  // doesn't keep showing SENT for a delivery that actually failed. The
  // scheduled worker pre-marks the row SENT optimistically to stop the
  // 30s poll from re-picking it; here we correct that if the send blew up.
  if (updatedMessage?.scheduledMessageId) {
    try {
      await prisma.scheduledMessage.update({
        where: { id: updatedMessage.scheduledMessageId },
        data: {
          status: status === "SENT" ? "SENT" : "FAILED",
          ...(status === "FAILED" ? { error: sendError ?? `${channel} send failed` } : {}),
        },
      });
    } catch (err: any) {
      console.warn("[outgoing] scheduled-message status mirror failed:", err?.message);
    }
  }

  if (job.data.conversationId) {
    await publishEvent({
      event: "message:status",
      tenantId,
      data: { messageId, conversationId: job.data.conversationId, status, externalMessageId, error: sendError, sendError: sendErrorDetail || undefined },
    });
  }

  await analyticsQueue.add("message-sent", {
    tenantId,
    event: "message_sent",
    data: { conversationId: job.data.conversationId, messageId, status, channel, broadcastId },
    timestamp: new Date().toISOString(),
  });

  if (status === "SENT") {
    prisma.usageLog.create({
      data: {
        tenantId,
        type: "message_sent",
        quantity: 1,
        tokensEquivalent: 1,
        metadata: { channel, conversationId: job.data.conversationId, messageId, broadcastId },
      },
    }).catch((err: any) => console.error("[outgoing] Usage tracking failed:", err.message));

    if (job.data.conversationId) {
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
  }

  await recordBroadcastResult({
    tenantId,
    broadcastId,
    broadcastRecipientId,
    success: status === "SENT",
    errorMessage: sendError || (status === "FAILED" ? `${channel} send failed` : undefined),
  });

  if (status === "FAILED" && (job.data.retryCount || 0) < 3 && !broadcastId) {
    // Retry non-broadcast messages. Broadcasts are handled at recipient level; we
    // don't want BullMQ to also retry here (would double-count failures).
    throw new Error(`${channel} send failed - will retry`);
  }
}

let worker: any;
export function startOutgoingWorker() {
  worker = createWorker<OutgoingMessageJob>("outgoing-messages", processOutgoingMessage, 5);
  console.log("[outgoing-worker] Outgoing message worker started");
}
