import { Job } from "bullmq";
import {
  prisma,
  createWorker,
  idleConversationQueue,
  outgoingMessageQueue,
  getRedis,
  publishEvent,
} from "@chatcenter/shared";

interface IdleConversationJob {
  type: "idle_check";
}

interface IdleAutomationConfig {
  reminderEnabled: boolean;
  reminderDelayMinutes: number;
  reminderMessage: string;
  autoCloseEnabled: boolean;
  autoCloseDelayMinutes: number;
  autoCloseMessage: string;
}

const DEFAULT_IDLE: IdleAutomationConfig = {
  reminderEnabled: false,
  reminderDelayMinutes: 60,
  reminderMessage: "",
  autoCloseEnabled: false,
  autoCloseDelayMinutes: 1440,
  autoCloseMessage: "",
};

async function processIdleConversations(job: Job<IdleConversationJob>): Promise<void> {
  console.log("[idle-check] Running idle conversation check...");

  // ── F4 approval expiry sweep ────────────────────────────
  // PENDING approvals past their expiresAt get EXPIRED status and the
  // underlying conversation is routed to a human so the customer isn't
  // left hanging. Done at the top of the cron so it runs every 5 min
  // regardless of whether any tenants have idle config enabled.
  try {
    const expired = await (prisma as any).approvalRequest.findMany({
      where: { status: "PENDING", expiresAt: { lt: new Date() } },
      take: 100,
    });
    for (const ar of expired) {
      try {
        await (prisma as any).approvalRequest.update({
          where: { id: ar.id },
          data: {
            status: "EXPIRED",
            decidedAt: new Date(),
            decisionReason: "auto-expired (no human decision within TTL)",
          },
        });
        await prisma.conversation.update({
          where: { id: ar.conversationId },
          data: { handledBy: "human", isHandedOver: true },
        });
        // F7 handoff trigger: fire analysis so the incoming human has an
        // instant summary + intent + sentiment of the stalled thread.
        import("../services/intelligence.service")
          .then(({ analyzeConversation }) =>
            analyzeConversation(ar.tenantId, ar.conversationId, "handoff"),
          )
          .catch((err: any) =>
            console.error(`[idle-check] analyzeConversation failed for ${ar.conversationId}:`, err?.message),
          );
        publishEvent({
          event: "approval:expired",
          tenantId: ar.tenantId,
          data: {
            approvalId: ar.id,
            conversationId: ar.conversationId,
            tool: ar.tool,
          },
        }).catch(() => {});
        console.log(`[idle-check] Expired approval ${ar.id} — conversation ${ar.conversationId} routed to human`);
      } catch (err: any) {
        console.error(`[idle-check] Failed to expire approval ${ar.id}:`, err.message);
      }
    }
  } catch (err: any) {
    console.error("[idle-check] Approval expiry sweep failed:", err.message);
  }

  // Get all active tenants
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  const redis = getRedis();
  let reminders = 0;
  let closes = 0;

  for (const tenant of tenants) {
    try {
      const raw = await redis.get(`tenant:${tenant.id}:idleAutomation`);
      if (!raw) continue;

      const config: IdleAutomationConfig = JSON.parse(raw);
      if (!config.reminderEnabled && !config.autoCloseEnabled) continue;

      // Find open conversations where last message is OUTBOUND (agent waiting for customer)
      // and conversation is assigned to an agent
      const conversations = await prisma.conversation.findMany({
        where: {
          tenantId: tenant.id,
          status: { in: ["OPEN", "WAITING"] },
          assignedAgentId: { not: null },
          lastMessageAt: { not: null },
        },
        include: {
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { direction: true, createdAt: true, messageType: true },
          },
          channelAccount: {
            select: { id: true, channel: true },
          },
          assignedAgent: {
            select: { id: true, name: true },
          },
        },
      });

      for (const conv of conversations) {
        const lastMsg = conv.messages[0];
        if (!lastMsg) continue;

        // Only act if last message is from agent (OUTBOUND) and not a system message
        if (lastMsg.direction !== "OUTBOUND" || lastMsg.messageType === "system") continue;

        const lastMsgTime = lastMsg.createdAt.getTime();
        const now = Date.now();
        const elapsedMinutes = (now - lastMsgTime) / 60000;

        // Auto-close check (takes priority - check first since it has a longer delay)
        if (config.autoCloseEnabled && config.autoCloseDelayMinutes > 0) {
          if (elapsedMinutes >= config.autoCloseDelayMinutes) {
            try {
              // Send auto-close message if configured
              if (config.autoCloseMessage && conv.channelAccount) {
                const message = await prisma.message.create({
                  data: {
                    tenantId: tenant.id,
                    conversationId: conv.id,
                    direction: "OUTBOUND",
                    body: config.autoCloseMessage,
                    messageType: "text",
                    senderName: "System",
                    status: "PENDING",
                  },
                });

                await outgoingMessageQueue.add("send", {
                  tenantId: tenant.id,
                  conversationId: conv.id,
                  channel: conv.channelAccount.channel,
                  channelAccountId: conv.channelAccount.id,
                  recipientExternalId: conv.customerExternalId,
                  body: config.autoCloseMessage,
                  messageType: "text",
                  senderName: "System",
                  messageId: message.id,
                }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
              }

              // Close the conversation
              await prisma.conversation.update({
                where: { id: conv.id },
                data: { status: "CLOSED", closedAt: new Date() },
              });

              // Create system message
              await prisma.message.create({
                data: {
                  tenantId: tenant.id,
                  conversationId: conv.id,
                  direction: "INBOUND",
                  body: "",
                  messageType: "system",
                  senderName: "System",
                  metadata: { systemEvent: "auto_closed", reason: "idle_timeout" },
                },
              });

              publishEvent({
                event: "conversation:closed",
                tenantId: tenant.id,
                data: { id: conv.id, status: "CLOSED" },
              }).catch(() => {});

              // Analyze the closed conversation for intelligence
              import("../services/intelligence.service").then(({ analyzeClosedConversation }) => {
                analyzeClosedConversation(tenant.id, conv.id).catch((err: any) =>
                  console.error(`[idle-check] Intelligence analysis failed for ${conv.id}:`, err.message)
                );
              }).catch(() => {});

              closes++;
              console.log(`[idle-check] Auto-closed conversation ${conv.id} (idle ${Math.round(elapsedMinutes)}m)`);
            } catch (err) {
              console.error(`[idle-check] Auto-close failed for ${conv.id}:`, err);
            }
            continue; // Skip reminder since we're closing
          }
        }

        // Reminder check
        if (config.reminderEnabled && config.reminderDelayMinutes > 0) {
          if (elapsedMinutes >= config.reminderDelayMinutes) {
            // Check if reminder was already sent for this idle period
            if (conv.reminderSentAt && conv.reminderSentAt.getTime() > lastMsgTime) {
              continue; // Already sent reminder after last agent message
            }

            try {
              if (config.reminderMessage && conv.channelAccount) {
                const message = await prisma.message.create({
                  data: {
                    tenantId: tenant.id,
                    conversationId: conv.id,
                    direction: "OUTBOUND",
                    body: config.reminderMessage,
                    messageType: "text",
                    senderName: conv.assignedAgent?.name || "System",
                    status: "PENDING",
                  },
                });

                await outgoingMessageQueue.add("send", {
                  tenantId: tenant.id,
                  conversationId: conv.id,
                  channel: conv.channelAccount.channel,
                  channelAccountId: conv.channelAccount.id,
                  recipientExternalId: conv.customerExternalId,
                  body: config.reminderMessage,
                  messageType: "text",
                  senderName: conv.assignedAgent?.name || "System",
                  messageId: message.id,
                }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
              }

              // Mark reminder as sent
              await prisma.conversation.update({
                where: { id: conv.id },
                data: { reminderSentAt: new Date() },
              });

              publishEvent({
                event: "conversation:updated",
                tenantId: tenant.id,
                data: { id: conv.id },
              }).catch(() => {});

              reminders++;
              console.log(`[idle-check] Sent reminder for conversation ${conv.id} (idle ${Math.round(elapsedMinutes)}m)`);
            } catch (err) {
              console.error(`[idle-check] Reminder failed for ${conv.id}:`, err);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[idle-check] Error processing tenant ${tenant.id}:`, err);
    }
  }

  console.log(`[idle-check] Complete: ${reminders} reminders sent, ${closes} conversations closed`);
}

// ─── Setup Repeatable Job + Start Worker ────────────────────

export async function startIdleConversationWorker(): Promise<void> {
  await idleConversationQueue.add(
    "idle-check",
    { type: "idle_check" },
    {
      repeat: { pattern: "*/5 * * * *" }, // Every 5 minutes
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 },
    }
  );

  createWorker<IdleConversationJob>("idle-conversations", processIdleConversations, 1);

  console.log("[idle-check] Worker started with repeatable idle check (5 min)");
}
