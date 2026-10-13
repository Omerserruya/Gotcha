import { Job } from "bullmq";
import {
  prisma,
  createWorker,
  idleConversationQueue,
  outgoingMessageQueue,
  publishEvent,
  readDurableSetting,
  buildTemplateComponents,
  renderTemplateText,
} from "@chatcenter/shared";
import { hasReplyWindow, lastInboundAtForRecipient, replyWindowFor } from "@chatcenter/shared/src/lib/reply-window";

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

/**
 * PENDING approvals past their expiresAt become EXPIRED, and (for a request
 * raised in a customer's conversation) that conversation is routed to a human
 * so the customer isn't left hanging. A plan the team proposed in GOTCHA is
 * expired without touching the conversation.
 */
export async function expireDueApprovals(): Promise<void> {
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
        // A plan the team proposed in GOTCHA (Home or the command bar) never
        // parked the customer's conversation: its expiry must not hand that
        // conversation to a person, which stops GOTCHA answering the customer.
        // Same rule as the conversation service's isOperatorPlan.
        const source = (ar.params as Record<string, unknown> | null)?.source;
        const operatorPlan = ar.tool === "propose_plan" || source === "home_assistant" || source === "command_bar";
        if (ar.conversationId && !operatorPlan) {
          await prisma.conversation.update({
            where: { id: ar.conversationId },
            data: { handledBy: "human", isHandedOver: true },
          });
        }
        // (An "instant handoff summary" used to be requested here. It called
        // an authenticated ai route without a token, always failed, and fell
        // back to English keyword guesses; removed with the analysis on close:
        // docs/architecture/conversation-intelligence-on-close.md, backlog.)
        publishEvent({
          event: "approval:expired",
          tenantId: ar.tenantId,
          data: {
            approvalId: ar.id,
            conversationId: ar.conversationId,
            tool: ar.tool,
          },
        }).catch(() => {});
        console.log(`[idle-check] Expired approval ${ar.id} - conversation ${ar.conversationId} routed to human`);
      } catch (err: any) {
        console.error(`[idle-check] Failed to expire approval ${ar.id}:`, err.message);
      }
    }
  } catch (err: any) {
    console.error("[idle-check] Approval expiry sweep failed:", err.message);
  }
}

async function processIdleConversations(job: Job<IdleConversationJob>): Promise<void> {
  console.log("[idle-check] Running idle conversation check...");

  // ── Stranded-execution sweep ────────────────────────────
  // An APPROVED row whose execution never started (crash between the
  // decision CAS and the dispatch, AI service briefly down, dispatch HTTP
  // lost) sits at executionState=NOT_STARTED forever - the human believes
  // the action ran, the provider was never called. Re-dispatch through the
  // ONE execution path (dispatch-approved), whose claimForExecution CAS
  // makes a concurrent/duplicate sweep a no-op. Grace period keeps us from
  // racing an in-flight synchronous dispatch.
  try {
    const graceMs = 3 * 60 * 1000;
    const stranded = await (prisma as any).approvalRequest.findMany({
      where: {
        status: "APPROVED",
        executionState: "NOT_STARTED",
        decidedAt: { lt: new Date(Date.now() - graceMs) },
      },
      take: 25,
      select: { id: true, tenantId: true, tool: true },
    });
    const convBase = process.env.CONVERSATION_SERVICE_URL || "http://conversation:4002";
    for (const ar of stranded) {
      try {
        console.warn(`[idle-check] re-dispatching stranded approval ${ar.id} (${ar.tool})`);
        const res = await fetch(`${convBase}/api/approvals/${ar.id}/dispatch-approved`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "",
            "X-Tenant-Id": ar.tenantId,
          },
          body: JSON.stringify({ source: "sweeper" }),
        });
        if (!res.ok) {
          console.error(`[idle-check] stranded re-dispatch failed for ${ar.id}: ${res.status}`);
        }
      } catch (err: any) {
        console.error(`[idle-check] stranded re-dispatch error for ${ar.id}:`, err?.message);
      }
    }
  } catch (err: any) {
    console.error("[idle-check] stranded-execution sweep failed:", err?.message);
  }

  await expireDueApprovals();

  // ── Comment→DM 24h bridge expiry sweep ─────────────────
  // Conversations promoted from a comment trigger have a flowExpiresAt set
  // (24h from the private-reply DM). If the user never replies, the bridge
  // is dead - Meta blocks further DMs. Close them proactively so they don't
  // sit in inbox indefinitely waiting for an inbound that won't come.
  try {
    const expiredBridges = await prisma.conversation.findMany({
      where: {
        flowExpiresAt: { not: null, lt: new Date() },
        status: { not: "CLOSED" as any },
      },
      take: 200,
      select: { id: true, tenantId: true },
    });
    for (const conv of expiredBridges) {
      try {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: {
            status: "CLOSED" as any,
            chatbotNodeId: null,
            chatbotFlowId: null,
            flowExpiresAt: null,
            closedAt: new Date(),
          },
        });
        await publishEvent({
          event: "conversation:updated",
          tenantId: conv.tenantId,
          data: { id: conv.id, status: "CLOSED" },
        }).catch(() => {});
        console.log(
          `[idle-check] flow_expired conversation=${conv.id} (24h comment-DM bridge auto-closed)`,
        );
      } catch (err: any) {
        console.error(
          `[idle-check] Failed to close expired bridge ${conv.id}:`,
          err.message,
        );
      }
    }
  } catch (err: any) {
    console.error("[idle-check] Flow expiry sweep failed:", err.message);
  }

  // Get all active tenants
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  let reminders = 0;
  let closes = 0;
  let skipped = 0;

  for (const tenant of tenants) {
    try {
      const r = await idleAutomationForTenant(tenant.id);
      reminders += r.reminders;
      closes += r.closes;
      skipped += r.skippedOutsideWindow;
    } catch (err) {
      console.error(`[idle-check] Error processing tenant ${tenant.id}:`, err);
    }
  }

  console.log(`[idle-check] Complete: ${reminders} reminders sent, ${closes} conversations closed, ${skipped} messages skipped outside the reply window`);
}

/**
 * The customer-service window for an idle reminder or close message (B8,
 * 2026-10-12): free text only while the customer's 24h window is open
 * (WhatsApp, Instagram, Messenger). Outside it the message is skipped and
 * logged; the close itself still happens. Free text there failed at Meta
 * (131047). An unreadable window allows the message, as before.
 */
async function windowMode(conv: { tenantId: string; channel: string | null; channelAccountId: string | null; customerExternalId: string }): Promise<"free" | "template_only" | "closed"> {
  try {
    const channel = conv.channel || "WHATSAPP";
    if (!hasReplyWindow(channel)) return "free";
    const last = await lastInboundAtForRecipient({ tenantId: conv.tenantId, channel, channelAccountId: conv.channelAccountId, customerExternalId: conv.customerExternalId });
    return replyWindowFor(channel, last).mode;
  } catch (err: any) {
    console.warn(`[idle-check] reply window unreadable for ${conv.customerExternalId.slice(0, 4)}***, allowing: ${err?.message}`);
    return "free";
  }
}

async function messageAllowed(conv: { tenantId: string; channel: string | null; channelAccountId: string | null; customerExternalId: string }): Promise<boolean> {
  return (await windowMode(conv)) === "free";
}

/**
 * The approved WhatsApp follow-up template for this number (B9, 2026-10-13):
 * past the 24h window the idle reminder goes out as this template instead of
 * being skipped. Its name is the "followup" role of conversation
 * lib/required-templates.ts. This number's own first, else an unbound one,
 * in the workspace's language when there is a choice.
 */
const FOLLOWUP_TEMPLATE_NAME = "gotcha_followup";
async function followupTemplate(tenantId: string, channelAccountId: string | null) {
  const rows = await prisma.messageTemplate.findMany({
    where: {
      tenantId,
      name: FOLLOWUP_TEMPLATE_NAME,
      status: "APPROVED",
      isActive: true,
      channel: "WHATSAPP" as any,
      OR: [{ channelAccountId }, { channelAccountId: null }],
    },
  });
  if (rows.length === 0) return null;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultLocale: true } }).catch(() => null);
  const lang = String(tenant?.defaultLocale ?? "").toLowerCase().startsWith("he") ? "he" : "en";
  const rank = (t: any) => (t.channelAccountId === channelAccountId ? 0 : 2) + (t.language === lang ? 0 : 1);
  return [...rows].sort((a: any, b: any) => rank(a) - rank(b))[0]!;
}

/**
 * One workspace's idle reminders and auto-closes. The settings are durable
 * (TenantSetting "idleAutomation", read cache-first); they lived in Redis only
 * and a flush lost them.
 */
export async function idleAutomationForTenant(tenantId: string): Promise<{ reminders: number; closes: number; skippedOutsideWindow: number }> {
  let reminders = 0;
  let closes = 0;
  let skippedOutsideWindow = 0;
  const raw = await readDurableSetting(tenantId, "idleAutomation");
  if (!raw) return { reminders, closes, skippedOutsideWindow };

  const config: IdleAutomationConfig = JSON.parse(raw);
  if (!config.reminderEnabled && !config.autoCloseEnabled) return { reminders, closes, skippedOutsideWindow };

  // Find open conversations where last message is OUTBOUND (agent waiting for customer)
  // and conversation is assigned to an agent
  const conversations = await prisma.conversation.findMany({
    where: {
      tenantId,
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
          // Send auto-close message if configured, and only inside the
          // customer's reply window; the close happens either way.
          const closeMessageAllowed = !!(config.autoCloseMessage && conv.channelAccount) && (await messageAllowed(conv as any));
          if (config.autoCloseMessage && conv.channelAccount && !closeMessageAllowed) {
            skippedOutsideWindow++;
            console.log(`[idle-check] Close message skipped for ${conv.id}: outside the reply window`);
          }
          if (closeMessageAllowed && conv.channelAccount) {
            const message = await prisma.message.create({
              data: {
                tenantId,
                conversationId: conv.id,
                direction: "OUTBOUND",
                body: config.autoCloseMessage,
                messageType: "text",
                senderName: "System",
                status: "PENDING",
              },
            });

            await outgoingMessageQueue.add("send", {
              tenantId,
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
              tenantId,
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
            tenantId,
            data: { id: conv.id, status: "CLOSED" },
          }).catch(() => {});

          // Intelligence: the ai service analyses it on the
          // conversation:closed event above.

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
          // Outside the customer's reply window the reminder is skipped,
          // and marked handled for this silence so it is not retried every
          // five minutes. (An approved follow-up template will be used here
          // once the WhatsApp required templates exist.)
          const mode = config.reminderMessage && conv.channelAccount ? await windowMode(conv as any) : "free";
          const reminderAllowed = !!(config.reminderMessage && conv.channelAccount) && mode === "free";
          // Past WhatsApp's window: the approved follow-up template, if there is one.
          const tpl = !reminderAllowed && mode === "template_only" && conv.channelAccount
            ? await followupTemplate(tenantId, conv.channelAccountId)
            : null;
          if (tpl && conv.channelAccount) {
            const values = { "1": (conv as any).customerName || "" };
            const body = renderTemplateText(tpl as any, values);
            const message = await prisma.message.create({
              data: {
                tenantId,
                conversationId: conv.id,
                direction: "OUTBOUND",
                body,
                messageType: "template",
                senderName: conv.assignedAgent?.name || "System",
                status: "PENDING",
                metadata: { template: { id: tpl.id, name: tpl.name, language: tpl.language }, source: "idle_followup" },
              },
            });
            await outgoingMessageQueue.add("send", {
              tenantId,
              conversationId: conv.id,
              channel: conv.channelAccount.channel,
              channelAccountId: conv.channelAccount.id,
              recipientExternalId: conv.customerExternalId,
              body,
              messageType: "template",
              senderName: conv.assignedAgent?.name || "System",
              messageId: message.id,
              templateName: tpl.name,
              templateLanguage: tpl.language || "en",
              templateComponents: buildTemplateComponents(tpl as any, values),
            } as any, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
            reminders++;
            console.log(`[idle-check] Sent follow-up template ${tpl.name}/${tpl.language} for ${conv.id}`);
          } else if (config.reminderMessage && conv.channelAccount && !reminderAllowed) {
            skippedOutsideWindow++;
            console.log(`[idle-check] Reminder skipped for ${conv.id}: outside the reply window`);
          }
          if (reminderAllowed && conv.channelAccount) {
            const message = await prisma.message.create({
              data: {
                tenantId,
                conversationId: conv.id,
                direction: "OUTBOUND",
                body: config.reminderMessage,
                messageType: "text",
                senderName: conv.assignedAgent?.name || "System",
                status: "PENDING",
              },
            });

            await outgoingMessageQueue.add("send", {
              tenantId,
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
            tenantId,
            data: { id: conv.id },
          }).catch(() => {});

          if (reminderAllowed) {
            reminders++;
            console.log(`[idle-check] Sent reminder for conversation ${conv.id} (idle ${Math.round(elapsedMinutes)}m)`);
          }
        } catch (err) {
          console.error(`[idle-check] Reminder failed for ${conv.id}:`, err);
        }
      }
    }
  }
  return { reminders, closes, skippedOutsideWindow };
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
