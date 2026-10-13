import { Job } from "bullmq";
import { prisma, createWorker, OutgoingMessageJob, analyticsQueue, publishEvent, getOutboundAdapter, decryptCredentials, describeSendError, sanitizeCustomerText, resolveEmailThread, hasReplyWindow, lastInboundAtForRecipient, replyWindowFor, sendAllowed } from "@chatcenter/shared";
import type { ChannelCredentials, ProviderSendError } from "@chatcenter/shared";
import { recordBroadcastResult } from "./broadcast.worker";
import { outboundMediaUrl } from "../lib/outbound-media-url";

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

  // ── The customer-service window (B7, 2026-10-12) ──
  //
  // Here because every queued producer passes through: scheduled sends,
  // approval continuations, the auto-greeting, idle reminders, opt-out
  // confirmations. Past the window WhatsApp takes only a template and
  // Instagram/Messenger take nothing; sending anyway fails at Meta (131047)
  // and the retry below sent it three more times. A refusal is final: FAILED
  // with a reason, never retried. If the window cannot be read, the send goes
  // ahead and Meta decides, as before.
  if (hasReplyWindow(channel) && recipientExternalId) {
    let verdict: ReturnType<typeof sendAllowed> = { ok: true };
    try {
      const last = await lastInboundAtForRecipient({ tenantId, channel, channelAccountId, customerExternalId: recipientExternalId });
      verdict = sendAllowed(replyWindowFor(channel, last), messageType);
    } catch (err: any) {
      console.warn(`[outgoing] reply window unreadable, sending anyway: ${err?.message}`);
    }
    if (!verdict.ok) {
      await refuseOutsideWindow(job.data, { code: verdict.code, message: verdict.message });
      return;
    }
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
        // A stored upload goes out as a signed link minted now (2026-10-10);
        // inside the try, so a missing origin is a FAILED send with a reason.
        outboundMediaUrl({ mediaUrl, messageId, tenantId, publicBaseUrl: job.data.publicBaseUrl }),
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
    /**
     * ★ THE SORT KEY MOVES HERE, BECAUSE THIS IS WHERE THE SEND BECAME TRUE.
     *
     * No queued outbound ever advanced `lastMessageAt`. Every path through this
     * worker - scheduled sends, `contacts.ts`, approvals, the idle nudges,
     * voice-callback - creates its Message row as PENDING and hands off, and the
     * word `lastMessageAt` did not appear anywhere in this service. So a
     * scheduled message really delivered to a real customer left the
     * conversation sitting wherever it already was in the inbox.
     *
     * It does NOT belong at the site that creates the row. Advancing the key
     * there would claim a delivery that has not happened yet - the same defect
     * as advancing it on a FAILED send, just earlier. The rule belongs where the
     * fact becomes true, which is here, on the success branch.
     *
     * ★★ `updateMany` WITH A `lt` PREDICATE, NOT `update`, AND THE PREDICATE IS
     * THE POINT.
     *
     * The row is created at T0 and this runs at T1. A customer inbound arriving
     * between them is NEWER than this message, so writing our timestamp
     * unconditionally would drag the key BACKWARDS and bury someone who has just
     * written in. The predicate makes the write a max() and does it in one
     * statement, so there is no read-modify-write race between two workers.
     *
     * It also makes the double-write idempotent: `approvals.ts` already sets the
     * key at enqueue time with `new Date()`, which is later than this row's
     * `createdAt`, so this call correctly does nothing there.
     *
     * `tenantId` is required: the tenant guard blocks any bulk write whose where
     * clause omits it. And `origin` is deliberately NOT mentioned - the
     * live-by-default guard injects `origin: "LIVE"`, so an imported
     * conversation can never have its key moved by a live send. That is the
     * origin rule enforced for free rather than restated here.
     *
     * Never throws. The message is already on the wire; failing the job would
     * retry the SEND and deliver the customer a second copy, which is a far
     * worse outcome than a stale sort key.
     */
    if (updatedMessage?.conversationId) {
      await prisma.conversation.updateMany({
        where: {
          id: updatedMessage.conversationId,
          tenantId,
          OR: [
            { lastMessageAt: null },
            { lastMessageAt: { lt: updatedMessage.createdAt } },
          ],
        },
        data: { lastMessageAt: updatedMessage.createdAt },
      }).catch((err: any) =>
        console.warn("[outgoing] conversation sort-key update failed:", err?.message),
      );
    }

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

/**
 * A send refused because the customer-service window is closed: recorded the
 * way a provider failure is (FAILED, errorMessage, metadata.sendError, the
 * status event, the scheduled and broadcast mirrors), so every screen that
 * shows a failed send shows this one with its reason. Not retried.
 */
async function refuseOutsideWindow(data: OutgoingMessageJob, why: { code: string; message: string }): Promise<void> {
  const { tenantId, conversationId, channel, messageId, broadcastId, broadcastRecipientId } = data;
  const sendError: ProviderSendError = {
    channel: channel as ProviderSendError["channel"],
    phase: "send",
    type: why.code,
    message: why.message,
    retryable: false,
    at: new Date().toISOString(),
  };
  const existing = await prisma.message.findUnique({ where: { id: messageId }, select: { metadata: true } });
  const base = existing?.metadata && typeof existing.metadata === "object" ? (existing.metadata as Record<string, any>) : {};
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { status: "FAILED", errorMessage: why.message, metadata: { ...base, sendError } as any },
  });
  console.warn(`[outgoing] ${channel} send refused (${why.code}) message=${messageId}`);
  if (updated?.scheduledMessageId) {
    await prisma.scheduledMessage
      .update({ where: { id: updated.scheduledMessageId }, data: { status: "FAILED", error: why.message } })
      .catch((err: any) => console.warn("[outgoing] scheduled-message status mirror failed:", err?.message));
  }
  if (conversationId) {
    await publishEvent({
      event: "message:status",
      tenantId,
      data: { messageId, conversationId, status: "FAILED", externalMessageId: null, error: why.message, sendError },
    });
  }
  await recordBroadcastResult({ tenantId, broadcastId, broadcastRecipientId, success: false, errorMessage: why.message });
}

let worker: any;
export function startOutgoingWorker() {
  worker = createWorker<OutgoingMessageJob>("outgoing-messages", processOutgoingMessage, 5);
  console.log("[outgoing-worker] Outgoing message worker started");
}
