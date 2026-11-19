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
  closeProposedExecutions,
  assignSoleMemberOnHandoff,
} from "@chatcenter/shared";
import { hasReplyWindow, lastInboundAtForRecipient, replyWindowFor } from "@chatcenter/shared/src/lib/reply-window";
import {
  BOT_IDLE_KEY, BOT_IDLE_CLOSE_REASON, BOT_END_CLOSE_REASON, BOT_IDLE_SOURCE, ENDED_FACT, MARKED_END_CLOSE_MINUTES,
  botIdleDefaultOn, botIdleLang, botIdleRules, botIdleText, markedEndStep, parseBotIdleRow, type BotIdleRule,
} from "@chatcenter/shared/src/lib/bot-idle";

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
        const decidedAt = new Date();
        await (prisma as any).approvalRequest.update({
          where: { id: ar.id },
          data: {
            status: "EXPIRED",
            decidedAt,
            decisionReason: "auto-expired (no human decision within TTL)",
          },
        });
        // Its execution rows stop saying "proposed" (the AI-activity panel).
        await closeProposedExecutions({ ...ar, decidedAt }, "expired");
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
          // In a workspace of one, to that one (sole-member.ts).
          await assignSoleMemberOnHandoff(ar.tenantId, ar.conversationId);
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
    try {
      const b = await botIdleForTenant(tenant.id);
      reminders += b.reminders;
      closes += b.closes;
    } catch (err) {
      console.error(`[idle-check] bot idle failed for tenant ${tenant.id}:`, err);
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

// ─── Bot idle: the AI employee's own conversations (B3, Smoovee 2026-11-09; default for every business 2026-11-19) ───
//
// "idleAutomation" above acts only on conversations a PERSON holds
// (assignedAgentId set) and counts any outbound message. This is the mode for
// a conversation only the AI employee answers, under its own key so the human
// one is unchanged. The numbers, the texts, the stored shape and the switch
// live in shared lib/bot-idle. The silence counts from the BOT's last message
// only; the close counts from the reminder; a conversation a person has, or
// was handed to one, or a flow holds, is never touched (re-checked just before
// acting). A conversation the customer ended (the engine's mark) closes
// quietly after a short while, with no reminder and no message.

export { BOT_IDLE_KEY, BOT_IDLE_CLOSE_REASON, BOT_END_CLOSE_REASON, BOT_IDLE_SOURCE };
/** How late a step may still be taken (the sweep runs every 5 minutes). */
export const STEP_LATE_MINUTES = 60;
/** Conversations loaded per read: every candidate is looked at, a page at a time. */
export const SWEEP_PAGE = 200;

const AI_SOURCES = new Set(["ai_bot", "approval_continuation"]);
/** An outbound message the AI sent (analytics' isAiOutbound rule). */
export function isBotOutbound(m: { direction?: string; metadata?: unknown; senderName?: string | null }): boolean {
  if (m.direction !== "OUTBOUND") return false;
  const meta = (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<string, unknown>;
  return AI_SOURCES.has(String(meta.source ?? "")) || meta.aiGenerated === true || m.senderName === "AI Bot";
}
const idleSourceOf = (m: { metadata?: unknown } | null | undefined) => String(((m?.metadata ?? {}) as any).source ?? "");
const isIdleSource = (m: { metadata?: unknown } | null | undefined) =>
  idleSourceOf(m) === BOT_IDLE_SOURCE.reminder || idleSourceOf(m) === BOT_IDLE_SOURCE.close;

type StepRule = Pick<BotIdleRule, "reminderEnabled" | "reminderDelayMinutes" | "reminderMessage" | "autoCloseEnabled" | "autoCloseDelayMinutes">;

/**
 * What the newest non-system message calls for: "remind" (the bot spoke last,
 * long enough ago), "close" (our reminder was last, long enough ago; or the
 * bot, when there is no reminder step), else null (the customer, a person, or
 * not yet).
 */
export function botIdleStep(
  last: { direction: string; createdAt: Date; metadata?: unknown; senderName?: string | null } | null | undefined,
  cfg: StepRule,
  now = Date.now(),
): "remind" | "close" | null {
  if (!last || last.direction !== "OUTBOUND") return null;
  const source = idleSourceOf(last);
  const minutes = (now - new Date(last.createdAt).getTime()) / 60000;
  // Due, and not long past due: a step is taken only within STEP_LATE_MINUTES
  // of falling due. Switching the rule on never sweeps up every old silent
  // conversation (dev 2026-11-09: 495 two-week-old ones reminded and closed).
  const due = (delay: number) => minutes >= delay && minutes < delay + STEP_LATE_MINUTES;
  if (source === BOT_IDLE_SOURCE.close) return null;
  if (source === BOT_IDLE_SOURCE.reminder) return cfg.autoCloseEnabled && due(cfg.autoCloseDelayMinutes) ? "close" : null;
  if (!isBotOutbound(last)) return null;
  if (cfg.reminderEnabled && cfg.reminderMessage) return due(cfg.reminderDelayMinutes) ? "remind" : null;
  return cfg.autoCloseEnabled && due(cfg.autoCloseDelayMinutes) ? "close" : null;
}

/** Only the AI employee's: nobody assigned, never handed over, no flow, not a person's or an approval's. */
const botOwned = (channels: string[]) => ({
  status: { in: ["OPEN", "WAITING"] as any[] },
  channel: { in: channels as any[] },
  assignedAgentId: null,
  isHandedOver: false,
  automationRunId: null,
  OR: [{ handledBy: null }, { handledBy: { notIn: ["human", "awaiting_approval", "flow"] } }],
});

const lastNonSystem = async (conversationId: string, direction?: "INBOUND" | "OUTBOUND") =>
  prisma.message.findFirst({
    where: { conversationId, messageType: { not: "system" }, ...(direction ? { direction } : {}) } as any,
    orderBy: { createdAt: "desc" },
    select: { id: true, direction: true, createdAt: true, metadata: true, senderName: true, body: true },
  });

/** A team pass in the bot's own words ("העברתי את זה לצוות", "עדיין בבדיקה אצל הצוות"). */
const TEAM_PASS = /(?<![֐-׿])(?:העברתי|העברנו)\s+(?:את\s+)?(?:\S+\s+){0,4}(?:ל)?צוות|(?:בבדיקה|נבדק|נבדקת)\s+(?:אצל|עם)\s+(?:ה)?צוות|(?:ה)?צוות\s+(?:יחזור|יחזרו|יבדוק|יבדקו|ייצור|יעדכן)|\b(?:passed (?:this|it|your \w+) (?:on )?to the team|the team will (?:get back|check|reply))\b/iu;
/** A return, refund or exchange asked for. */
const RETURN_ASK = /(?<![֐-׿])[והלשב]?(?:החזרה|החזרת|להחזיר|מחזירה|מחזיר|החזר|זיכוי|לבטל|ביטול|החלפה|להחליף)(?![֐-׿])|\b(?:return|refund|exchange|cancel(?:lation)?)\b/iu;
/** The engine's open team items: "checking with the team: …" promises younger than 72h (reply-engine state.ts). */
const TEAM_OPEN_MS = 72 * 60 * 60 * 1000;
export function hasOpenTeamItem(pending: unknown, now = Date.now()): boolean {
  return Array.isArray(pending) && pending.some((p: any) => p?.kind === "promise" && String(p?.text ?? "").startsWith("checking with the team: ") && !(now - Date.parse(p?.at ?? "") > TEAM_OPEN_MS));
}

/** The engine's state of the live conversation: its open items and its own facts (the end mark). */
const liveState = async (tenantId: string, conversationId: string): Promise<{ pending?: unknown; facts?: unknown } | null> =>
  (await (prisma as any).conversationState?.findFirst?.({ where: { tenantId, conversationId, lane: "live" }, select: { pending: true, facts: true } }).catch(() => null)) ?? null;

/**
 * Never remind or close a conversation that waits on the business (2026-11-18, Smoovee: "העברתי את השאלה לצוות",
 * then "עדיין כאן?", then "סוגרת את השיחה"; a return request closed). Blocked by an open team item, the bot's
 * last message being a team pass, or a return asked for in the last 3 days. Handoffs are out by botOwned already.
 * `known`: the live state when the caller has read it already.
 */
export async function botIdleBlocked(tenantId: string, conversationId: string, lastBody: string | null | undefined, known?: { pending?: unknown } | null): Promise<string | null> {
  if (TEAM_PASS.test(String(lastBody ?? ""))) return "team_pass_last";
  const state = known !== undefined ? known : await liveState(tenantId, conversationId);
  if (hasOpenTeamItem(state?.pending)) return "open_team_item";
  const asked = await prisma.message.findMany({
    where: { tenantId, conversationId, direction: "INBOUND", createdAt: { gte: new Date(Date.now() - TEAM_OPEN_MS) } },
    select: { body: true }, orderBy: { createdAt: "desc" }, take: 30,
  }).catch(() => [] as Array<{ body: string }>);
  if (asked.some((m) => RETURN_ASK.test(String(m.body ?? "")))) return "return_requested";
  return null;
}

/**
 * The bot's close, the same outcome as a person's Resolve in the inbox (conversation.service close():
 * status CLOSED, closedAt, and conversation:closed carrying the whole row), plus the system event that says
 * it was automatic and why. Only while the conversation is still the bot's: a person who took it, or a
 * close that already happened, is left alone. False: nothing was closed.
 */
export async function closeByBot(tenantId: string, conversationId: string, channels: string[], reason: string): Promise<boolean> {
  const closed = await prisma.conversation.updateMany({
    where: { id: conversationId, tenantId, ...botOwned(channels) } as any,
    data: { status: "CLOSED", closedAt: new Date() },
  });
  if (!closed.count) return false;
  await prisma.message.create({
    data: {
      tenantId, conversationId, direction: "INBOUND", body: "", messageType: "system", senderName: "System",
      metadata: { systemEvent: "auto_closed", reason },
    },
  });
  const row = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { assignedAgent: { select: { id: true, name: true, email: true } } },
  });
  // closeReason: the storefront relay does not end the visitor's chat for a close their next message reopens.
  publishEvent({ event: "conversation:closed", tenantId, data: { ...(row ?? { id: conversationId, status: "CLOSED" }), closeReason: reason } }).catch(() => {});
  return true;
}

export async function botIdleForTenant(tenantId: string): Promise<{ reminders: number; closes: number }> {
  let reminders = 0, closes = 0;
  const defaultOn = botIdleDefaultOn();
  const rules = botIdleRules(parseBotIdleRow(await readDurableSetting(tenantId, BOT_IDLE_KEY)), defaultOn);
  const channels = Object.keys(rules);
  if (!channels.length) return { reminders, closes };
  const longest = Math.max(MARKED_END_CLOSE_MINUTES, ...channels.flatMap((c) => [rules[c].reminderDelayMinutes, rules[c].autoCloseDelayMinutes]));
  // Every candidate, not the first 500: the ids in one read (no ordering, so the tenant and status index
  // serves it), then the rows a page at a time.
  const ids = (await prisma.conversation.findMany({
    where: { tenantId, ...botOwned(channels), lastMessageAt: { gte: new Date(Date.now() - (longest + STEP_LATE_MINUTES) * 60_000 * 2) } } as any,
    select: { id: true },
  })).map((c) => c.id);
  for (let at = 0; at < ids.length; at += SWEEP_PAGE) {
    const conversations = await prisma.conversation.findMany({
      where: { tenantId, id: { in: ids.slice(at, at + SWEEP_PAGE) } },
      select: { id: true, tenantId: true, channel: true, channelAccountId: true, customerExternalId: true, detectedLocale: true, channelAccount: { select: { id: true, channel: true } } },
    });
    for (const conv of conversations) {
      try {
        const rule = rules[String(conv.channel)];
        const last = await lastNonSystem(conv.id);
        if (!rule || !last) continue;
        const idle = botIdleStep(last as any, rule);
        // The customer ended it (the engine's mark): a quiet close, and never a reminder after a goodbye.
        const quiet = (Date.now() - new Date(last.createdAt).getTime()) / 60000;
        const endCould = defaultOn && !isIdleSource(last) && (last.direction === "INBOUND" || isBotOutbound(last))
          && (!!idle || (quiet >= MARKED_END_CLOSE_MINUTES && quiet < MARKED_END_CLOSE_MINUTES + STEP_LATE_MINUTES));
        if (!idle && !endCould) continue;
        const state = await liveState(tenantId, conv.id);
        const endedAt = endCould ? (state?.facts as any)?.[ENDED_FACT] : null;
        const end = endedAt
          ? markedEndStep({
              endedAt,
              last: { direction: last.direction, createdAt: last.createdAt, botOutbound: isBotOutbound(last), idleSource: isIdleSource(last) },
              lastInboundAt: last.direction === "INBOUND" ? last.createdAt : (await lastNonSystem(conv.id, "INBOUND"))?.createdAt,
              lateMinutes: STEP_LATE_MINUTES,
            })
          : null;
        if (end === "wait") continue;
        const step = end === "close" ? "end" : idle;
        if (!step) continue;
        // Just before acting: still the bot's, and nobody wrote since (a person
        // took it, the customer replied, or a flow claimed it in the meantime).
        const still = await prisma.conversation.findFirst({ where: { id: conv.id, tenantId, ...botOwned(channels) } as any, select: { id: true } });
        const newest = await lastNonSystem(conv.id);
        if (!still || newest?.id !== last.id) continue;
        // Waiting on the business: neither a reminder nor a close (2026-11-18). After a goodbye the bot did
        // not answer, the bot's own last message is the one that may be a team pass.
        const ours = last.direction === "OUTBOUND" ? (last as any).body : (await lastNonSystem(conv.id, "OUTBOUND"))?.body;
        const blocked = await botIdleBlocked(tenantId, conv.id, ours, state);
        if (blocked) { console.log(`[idle-check][bot] ${step} skipped (${blocked}) conv=${conv.id}`); continue; }
        if (step === "end") {
          if (await closeByBot(tenantId, conv.id, channels, BOT_END_CLOSE_REASON)) { closes++; console.log(`[idle-check][bot] closed (customer ended) conv=${conv.id}`); }
          continue;
        }
        const text = botIdleText(rule, step === "remind" ? "reminder" : "close", botIdleLang(conv.detectedLocale, (last as any).body));
        const allowed = !!(text && conv.channelAccount) && (await messageAllowed(conv as any));
        const send = async () => {
          const message = await prisma.message.create({
            data: {
              tenantId, conversationId: conv.id, direction: "OUTBOUND", body: text, messageType: "text",
              senderName: "AI Bot", status: "PENDING",
              metadata: { source: step === "remind" ? BOT_IDLE_SOURCE.reminder : BOT_IDLE_SOURCE.close },
            },
          });
          await outgoingMessageQueue.add("send", {
            tenantId, conversationId: conv.id, channel: conv.channelAccount!.channel, channelAccountId: conv.channelAccount!.id,
            recipientExternalId: conv.customerExternalId, body: text, messageType: "text", senderName: "AI Bot", messageId: message.id,
          }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
        };
        if (step === "remind") {
          // No reminder can be sent (the reply window is closed): nothing is written, the conversation is as it was.
          if (!allowed) { console.log(`[idle-check][bot] reminder skipped (window) conv=${conv.id}`); continue; }
          await send();
          await prisma.conversation.update({ where: { id: conv.id }, data: { reminderSentAt: new Date(), lastMessageAt: new Date() } });
          publishEvent({ event: "conversation:updated", tenantId, data: { id: conv.id } }).catch(() => {});
          reminders++;
          console.log(`[idle-check][bot] reminder sent conv=${conv.id}`);
          continue;
        }
        if (allowed) await send();
        if (await closeByBot(tenantId, conv.id, channels, BOT_IDLE_CLOSE_REASON)) { closes++; console.log(`[idle-check][bot] closed conv=${conv.id}`); }
      } catch (err) {
        console.error(`[idle-check][bot] failed for ${conv.id}:`, (err as any)?.message ?? err);
      }
    }
  }
  return { reminders, closes };
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
