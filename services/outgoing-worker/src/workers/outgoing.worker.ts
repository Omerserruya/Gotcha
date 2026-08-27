import { Job } from "bullmq";
import { prisma, createWorker, OutgoingMessageJob, analyticsQueue, publishEvent, getOutboundAdapter, decryptCredentials, describeSendError, sanitizeCustomerText, resolveEmailThread } from "@chatcenter/shared";
import type { ChannelCredentials, ProviderSendError } from "@chatcenter/shared";
import { recordBroadcastResult } from "./broadcast.worker";

const MEDIA_MESSAGE_TYPES = ["image", "video", "document"];

/** Channels where a send is an email and therefore needs threading headers. */
const EMAIL_CHANNELS = new Set(["GMAIL", "OUTLOOK", "EMAIL"]);
/**
 * How far back to look for the email being answered. Deep enough that a long
 * support thread still threads, bounded so one enormous conversation cannot
 * make every send read its whole history.
 */
const EMAIL_THREAD_LOOKBACK = 50;

/**
 * Exported for tests. This function is where email threading is decided for
 * EVERY producer, so the branch that decides it needs to be reachable without
 * standing up BullMQ and Redis.
 */
export async function processOutgoingMessage(job: Job<OutgoingMessageJob>): Promise<void> {
  const { tenantId, conversationId, channel, channelAccountId, recipientExternalId, body: rawBody, messageId, messageType, mediaUrl, fileName, broadcastId, broadcastRecipientId, replyToExternalId, emailReplyMode } = job.data;
  let { emailThread } = job.data;
  // OUTBOX chokepoint: every customer-bound body from EVERY producer (bot
  // replies, approval continuations, broadcasts, scheduled sends, voice
  // callbacks) passes through the AI-signature sanitizer here, so no path -
  // present or future - can leak an em dash to a customer even if it skipped
  // the generation-side humanizer. Character-level only: business facts
  // (amounts, ids, dates) are never altered.
  const body = sanitizeCustomerText(rawBody);

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
  // ── Email threading ──
  //
  // Resolved here, at the one point EVERY producer passes through: the inbox,
  // the bot, flows, approvals, scheduled sends and broadcasts. Doing it in each
  // producer instead would guarantee that the next one added forgets, and the
  // symptom of forgetting is silent - the mail sends, it just arrives detached
  // from the thread it answers.
  //
  // Skipped for a deliberately new thread, and for a job that already carries
  // its own context.
  if (EMAIL_CHANNELS.has(channel) && !emailThread && emailReplyMode !== "new" && conversationId) {
    const history = await prisma.message.findMany({
      where: { tenantId, conversationId },
      select: { direction: true, metadata: true },
      orderBy: { createdAt: "desc" },
      take: EMAIL_THREAD_LOOKBACK,
    });
    emailThread = resolveEmailThread(history) || undefined;
  }

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
        body,
        // Renders the send as a reply quoting a specific earlier message.
        // Adapters that do not support quoting ignore it and still deliver the
        // text, which is the half that matters.
        replyToExternalId,
        // Email only: which thread this answers. Absent means a fresh email,
        // which is what every non-mail adapter reads it as anyway.
        emailThread,
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
  if (sendErrorDetail || emailThread) {
    const existing = await prisma.message.findUnique({
      where: { id: messageId },
      select: { metadata: true },
    });
    const base = (existing?.metadata && typeof existing.metadata === "object")
      ? (existing.metadata as Record<string, any>)
      : {};
    metadataUpdate = {
      ...base,
      ...(sendErrorDetail ? { sendError: sendErrorDetail } : {}),
      // The thread this reply joined, recorded on our own row. Without it a
      // second agent reply sent before the customer writes back would have
      // nothing to chain onto and would start a third thread.
      ...(emailThread
        ? {
            email: {
              ...(base.email && typeof base.email === "object" ? base.email : {}),
              subject: emailThread.subject,
              threadId: emailThread.threadId,
              references: emailThread.references,
              messageIdHeader: undefined,
            },
          }
        : {}),
    };
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
