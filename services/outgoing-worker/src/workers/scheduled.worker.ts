import { prisma, outgoingMessageQueue, createWorker, scheduledMessageQueue } from "@chatcenter/shared";

async function processScheduledMessages(): Promise<void> {
  const now = new Date();

  const dueMessages = await prisma.scheduledMessage.findMany({
    where: {
      status: "PENDING",
      scheduledAt: { lte: now },
    },
  });

  let processed = 0;

  for (const scheduledMessage of dueMessages) {
    try {
      // Check opt-out
      const contact = await prisma.contact.findFirst({
        where: { tenantId: scheduledMessage.tenantId, externalId: scheduledMessage.recipientExternalId, channel: scheduledMessage.channel as any },
      });
      if (contact) {
        const optOutChannels = ((contact as any).optOutChannels as string[]) || [];
        if (optOutChannels.includes(scheduledMessage.channel as string)) {
          await prisma.scheduledMessage.update({
            where: { id: scheduledMessage.id },
            data: { status: "CANCELLED", error: "Recipient opted out" },
          });
          continue;
        }
      }

      // Optimistic status update
      await prisma.scheduledMessage.update({
        where: { id: scheduledMessage.id },
        data: { status: "SENT", sentAt: new Date() },
      });

      // Enqueue to outgoing message queue
      await outgoingMessageQueue.add("scheduled-message", {
        tenantId: scheduledMessage.tenantId,
        conversationId: scheduledMessage.conversationId ?? "",
        channel: scheduledMessage.channel as any,
        channelAccountId: scheduledMessage.channelAccountId,
        recipientExternalId: scheduledMessage.recipientExternalId,
        body: scheduledMessage.body,
        messageType: scheduledMessage.messageType,
        senderName: "System",
        messageId: scheduledMessage.id,
      });

      // Create a Message record if conversation is linked
      if (scheduledMessage.conversationId) {
        await prisma.message.create({
          data: {
            tenantId: scheduledMessage.tenantId,
            conversationId: scheduledMessage.conversationId,
            direction: "OUTBOUND",
            body: scheduledMessage.body,
            messageType: scheduledMessage.messageType,
            status: "SENT",
            senderName: "System",
            scheduledMessageId: scheduledMessage.id,
          },
        });
      }

      processed++;
    } catch (err: any) {
      console.error(`[scheduled-worker] Failed to process scheduled message ${scheduledMessage.id}:`, err.message);
      await prisma.scheduledMessage.update({
        where: { id: scheduledMessage.id },
        data: { status: "FAILED", error: err.message },
      }).catch(() => {});
    }
  }

  console.log(`[scheduled-worker] Processed ${processed} scheduled message(s)`);
}

export function startScheduledMessageWorker() {
  // Add a repeatable job that triggers every 30 seconds
  scheduledMessageQueue.add(
    "poll-scheduled-messages",
    {},
    { repeat: { every: 30000 }, jobId: "scheduled-message-poll" }
  );

  createWorker("scheduled-messages", processScheduledMessages, 1);
  console.log("[outgoing-worker] Scheduled message worker started");
}
