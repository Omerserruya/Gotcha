import { prisma, createWorker, outgoingMessageQueue, CHANNEL_RATE_LIMITS } from "@chatcenter/shared";
import type { BroadcastJob } from "@chatcenter/shared";

async function processBroadcastMessage(job: any) {
  const data = job.data as BroadcastJob;
  const { broadcastId, tenantId, channel, channelAccountId, recipientId, recipientExternalId, body, messageType, templateId, variables } = data;

  // Fetch recipient record
  const recipient = await prisma.broadcastRecipient.findUnique({ where: { id: recipientId } });
  if (!recipient || recipient.status !== "pending") return;

  // Check broadcast not cancelled
  const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
  if (!broadcast || broadcast.status === "CANCELLED") return;

  // Check opt-out
  if (recipient.contactId) {
    const contact = await prisma.contact.findUnique({ where: { id: recipient.contactId } });
    if (contact) {
      const optOutChannels = ((contact as any).optOutChannels as string[]) || [];
      if (optOutChannels.includes(channel)) {
        await prisma.broadcastRecipient.update({
          where: { id: recipientId },
          data: { status: "skipped", error: "Contact opted out" },
        });
        return;
      }
    }
  }

  try {
    // Create message record with broadcast link
    const message = await prisma.message.create({
      data: {
        tenantId,
        conversationId: "broadcast-" + broadcastId, // placeholder for non-conversation messages
        channel: channel as any,
        direction: "OUTBOUND",
        body: body || "",
        messageType: messageType || "text",
        status: "PENDING",
        senderName: "Broadcast",
        broadcastId,
      },
    });

    // Enqueue to outgoing message queue
    await outgoingMessageQueue.add("send", {
      tenantId,
      conversationId: message.conversationId,
      channel,
      channelAccountId,
      recipientExternalId,
      body: body || "",
      messageType: messageType || "text",
      senderName: "Broadcast",
      messageId: message.id,
    }, {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
    });

    // Update recipient status
    await prisma.broadcastRecipient.update({
      where: { id: recipientId },
      data: { status: "sent", sentAt: new Date(), messageId: message.id },
    });

    // Increment sent count
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { sentCount: { increment: 1 } },
    });
  } catch (error: any) {
    console.error(`[BROADCAST] Failed to send to ${recipientExternalId}:`, error.message);

    await prisma.broadcastRecipient.update({
      where: { id: recipientId },
      data: { status: "failed", error: error.message?.slice(0, 500) },
    });

    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { failedCount: { increment: 1 } },
    });

    throw error; // Let BullMQ handle retry
  } finally {
    // Check completion
    await checkBroadcastCompletion(broadcastId);
  }
}

async function checkBroadcastCompletion(broadcastId: string) {
  const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
  if (!broadcast || broadcast.status !== "SENDING") return;

  const processedCount = broadcast.sentCount + broadcast.failedCount;
  if (processedCount >= broadcast.totalRecipients) {
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    console.log(`[BROADCAST] ${broadcastId} completed: ${broadcast.sentCount} sent, ${broadcast.failedCount} failed`);
  }
}

export function startBroadcastWorker() {
  const worker = createWorker("broadcast-messages", async (job) => {
    await processBroadcastMessage(job);
  }, {
    concurrency: 20,
    limiter: {
      max: 80,       // Default to WhatsApp limit (most restrictive common case)
      duration: 1000,
    },
  });

  worker.on("failed", (job, err) => {
    console.error(`[BROADCAST] Job ${job?.id} failed:`, err.message);
  });

  console.log("[BROADCAST] Worker started with rate limiting (80 msg/s)");
  return worker;
}
