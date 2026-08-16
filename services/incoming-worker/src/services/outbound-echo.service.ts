import { Job } from "bullmq";
import { prisma, OutboundEchoJob, publishEvent, decryptCredentials } from "@chatcenter/shared";

/**
 * Business-app echo ingestion (WhatsApp Coexistence).
 *
 * When a number runs in Coexistence, the owner can answer a customer straight
 * from the WhatsApp Business app on their phone. Meta mirrors that message to
 * our webhook as `smb_message_echoes`. This handler puts it in the GOTCHA
 * thread so the inbox shows the WHOLE conversation and not the half of it that
 * happened to go through us.
 *
 * Two things make this different from an inbound message, and both matter:
 *
 * 1. **It is OUTBOUND.** The echo's `to` is the customer. Feeding it through
 *    the inbound path would make the business a "customer", answer its own
 *    message with the bot, and run identity-link against our own copy.
 *
 * 2. **A human just spoke.** Someone picked up the phone and typed. That is
 *    exactly the signal a takeover carries, so the conversation leaves the AI
 *    the same way `escalate_to_human` leaves it - except no handoff message is
 *    sent to the customer, because the human has ALREADY replied. Announcing
 *    "connecting you with a representative" after the representative already
 *    answered is worse than saying nothing.
 */
export async function processOutboundEcho(job: Job<OutboundEchoJob>): Promise<void> {
  const { tenantId, channel, channelAccountId, echo } = job.data;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true },
  });
  if (!tenant || tenant.status !== "ACTIVE") {
    console.log(`[incoming-worker] Skipping echo for non-active tenant ${tenantId} (status: ${tenant?.status})`);
    return;
  }

  // Idempotency. Meta redelivers on any non-2xx and BullMQ retries on throw,
  // so without this a flaky minute would post the owner's message three times.
  // The same check absorbs an echo of a message GOTCHA itself sent, whose row
  // already carries this wamid.
  const existing = await prisma.message.findFirst({
    where: { externalMessageId: echo.externalMessageId },
    select: { id: true },
  });
  if (existing) return;

  const channelAccount = channelAccountId
    ? await prisma.channelAccount.findUnique({ where: { id: channelAccountId } })
    : null;

  // Same lookup rule as the inbound path: a CLOSED conversation stays closed.
  // The owner writing to an old customer from their phone opens a new thread
  // rather than resurrecting one with stale routing and escalation state.
  let conversation = await prisma.conversation.findFirst({
    where: {
      tenantId,
      channel,
      customerExternalId: echo.customerExternalId,
      status: { not: "CLOSED" },
    },
    orderBy: { createdAt: "desc" },
  });

  // The business can also START a conversation from the app, with someone we
  // have never heard from. That thread is human-owned from its first message:
  // there was no inbound to route, and the AI has no business picking it up
  // mid-way when the customer answers.
  let createdConversation = false;
  if (!conversation) {
    const { resolveContactByChannelId } = await import("@chatcenter/shared");
    const savedContact = await resolveContactByChannelId(tenantId, channel, echo.customerExternalId);
    conversation = await prisma.conversation.create({
      data: {
        tenantId,
        channel,
        channelAccountId: channelAccountId || undefined,
        customerExternalId: echo.customerExternalId,
        customerName: savedContact?.displayName || null,
        customerAvatarUrl: savedContact?.avatarUrl || undefined,
        status: "OPEN",
        isHandedOver: true,
        handledBy: "human",
      },
    });
    createdConversation = true;
  }

  // WhatsApp hands us a media ID, not a URL - the same resolution the inbound
  // path does, so an image the owner sent from their phone is viewable in the
  // inbox instead of showing as a bare "[Image]".
  let resolvedMediaUrl: string | undefined;
  let resolvedFileName: string | undefined;
  let mediaError: string | undefined;
  if (echo.mediaUrl && channelAccount) {
    try {
      const creds = channelAccount.credentials;
      const decrypted = typeof creds === "string" ? decryptCredentials(creds) : (creds as any);
      if (decrypted?.accessToken) {
        const { resolveWhatsAppMedia } = await import("../workers/incoming.worker");
        const resolved = await resolveWhatsAppMedia(echo.mediaUrl, decrypted.accessToken, echo.messageType, {
          fileName: echo.fileName,
          mimeType: echo.mimeType,
        });
        if (resolved) {
          resolvedMediaUrl = resolved.localUrl;
          resolvedFileName = resolved.displayName;
        } else {
          mediaError = "download_failed";
        }
      } else {
        mediaError = "no_channel_token";
      }
    } catch (err: any) {
      mediaError = "download_failed";
      console.warn("[incoming-worker] echo media resolution failed:", err?.message);
    }
  }

  // DELIVERED, not SENT: the app already put this on the wire. We will never
  // get a `statuses` webhook for it, so leaving it PENDING/SENT would strand
  // the row in a state nothing can advance.
  const message = await prisma.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      channel,
      externalMessageId: echo.externalMessageId,
      direction: "OUTBOUND",
      body: echo.body,
      messageType: echo.messageType,
      senderName: channelAccount?.displayName || "WhatsApp Business App",
      status: "DELIVERED",
      createdAt: new Date(echo.timestamp),
      mediaUrl: resolvedMediaUrl,
      fileName: resolvedFileName,
      metadata: {
        source: "whatsapp_business_app",
        echo: true,
        ...(echo.businessExternalId ? { businessExternalId: echo.businessExternalId } : {}),
        ...(mediaError ? { mediaError } : {}),
      },
    },
  });

  // The takeover. `isHandedOver` is the one latch every AI entry point reads
  // (ai-bot.service returns early on it, the incoming worker skips bot
  // processing on it), so setting it here is what actually stops the AI - not
  // a flag the bot is free to ignore.
  const aiWasDriving = !conversation.isHandedOver && !conversation.assignedAgentId;

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: new Date(),
      ...(aiWasDriving
        ? {
            isHandedOver: true,
            handledBy: "human",
            // OPEN, not WAITING. WAITING means "queued for a human to pick
            // up"; here the human already answered, and marking it WAITING
            // would put an already-handled chat back in the needs-attention
            // queue.
            status: "OPEN" as const,
            // A parked flow cursor is a live claim on the customer's NEXT
            // message. Left set, the flow resumes and talks over the person
            // who just took the conversation.
            chatbotFlowId: null,
            chatbotNodeId: null,
          }
        : {}),
    },
  });

  // Explain the takeover on the inbox timeline. Without the divider the thread
  // shows an outbound message from nobody and an AI that silently stopped.
  if (aiWasDriving && !createdConversation) {
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        channel,
        direction: "INBOUND",
        body: "",
        messageType: "system",
        senderName: "System",
        status: "DELIVERED",
        metadata: { systemEvent: "whatsapp_app_takeover" },
      },
    });
  }

  await publishEvent({
    event: "message:new",
    tenantId,
    data: { message, conversationId: conversation.id, channel },
  });
  await publishEvent({
    event: "conversation:updated",
    tenantId,
    data: {
      ...conversation,
      channel,
      ...(aiWasDriving ? { isHandedOver: true, handledBy: "human", status: "OPEN" } : {}),
    },
  });

  console.log(
    `[incoming-worker] business-app echo conv=${conversation.id} msg=${message.id} ` +
      `takeover=${aiWasDriving} newConversation=${createdConversation}`,
  );
}
