import { getInternalServiceKey } from "@chatcenter/shared";
/**
 * Autonomous AI bot - worker side.
 *
 * After the 2026-04 refactor, this module DOES NOT call OpenAI directly.
 * The LLM call, prompt assembly, tool-calling loop, and KB retrieval all
 * live in the AI service (POST /api/ai-bot/reply). This file owns only
 * the side effects:
 *   - escalation threshold checks (max messages / minutes)
 *   - explicit "talk to a human" keyword detection
 *   - HTTP call to AI service for the reply decision
 *   - sending the reply via the channel adapter
 *   - persisting the OUTBOUND message + audit + usage
 *   - escalateToHuman() flow
 *   - "awaiting approval" pause + bridge ack
 *
 * Triggered from:
 *   - flow-executor.service.ts:dispatchRoute("agent")
 *   - incoming.worker.ts (ongoing AI conversation branch)
 *   - approval-resume worker (after a human approves a paused tool call)
 */

import axios from "axios";
import {
  prisma,
  getOutboundAdapter,
  decryptCredentials,
  publishEvent,
  describeSendError,
  getRedis,
  BUSINESS_HOURS_KEY,
  parseBusinessHours,
  evaluateBusinessHours,
  describeNextOpening,
} from "@chatcenter/shared";
import type { ChannelCredentials, ProviderSendError, BusinessHoursConfig, BusinessOpenState } from "@chatcenter/shared";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";
const INTERNAL_SERVICE_KEY = getInternalServiceKey();

interface SendContext {
  channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM";
  channelAccountExternalId: string;
  credentials: ChannelCredentials;
  recipientId: string;
}

interface AIBotReplyResult {
  reply: string | null;
  /** Short acks (e.g. "one moment, checking") to send as their own bubble(s) before `reply`. */
  interimMessages?: string[];
  escalation: { reason: string; priority?: "low" | "medium" | "high"; summary?: string } | null;
  awaitingApproval: { approvalRequestId: string; tool: string; reason: string } | null;
  toolCallLog: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    decision?: string;
    sideEffect?: string;
  }>;
  modelUsed: string;
  totalTokens: number;
}

export async function processAIBot(
  tenantId: string,
  conversationId: string,
  incomingMessage: string,
  aiAgentId?: string | null,
): Promise<boolean> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { channelAccount: true },
  });

  if (!conversation || conversation.isHandedOver || conversation.assignedAgentId) return false;

  // Resolution order (graph is source of truth):
  //   1. Explicit `aiAgentId` argument (graph dispatched this call).
  //   2. `conversation.assignedAiAgentId` (set by a prior graph dispatch).
  // No legacy RouterRule fallback - if the graph never picked an agent for
  // this conversation, the AI bot does nothing and the conversation stays
  // unassigned for a human to claim.
  let resolvedAgentId: string | null = aiAgentId || null;
  if (!resolvedAgentId && (conversation as any).assignedAiAgentId) {
    resolvedAgentId = (conversation as any).assignedAiAgentId as string;
  }
  if (!resolvedAgentId) return false;

  // Validate the agent row before we round-trip - this catches "agent
  // deleted but assignedAiAgentId still set" without burning a network call.
  const agentLite = await prisma.aIAgent.findUnique({
    where: { id: resolvedAgentId },
    select: { id: true, tenantId: true, escalationMessage: true, maxAutonomousMessages: true, maxAutonomousMinutes: true, status: true },
  });
  if (!agentLite || agentLite.tenantId !== tenantId) return false;

  const sendContext = buildSendContext(conversation);
  if (!sendContext) return false;

  // Enforce the agent's lifecycle status at dispatch. "Pause" must actually
  // pause: a PAUSED employee hands the conversation to a human instead of
  // silently continuing to answer; a DRAFT (or any non-ACTIVE) employee is
  // never dispatched at all.
  if (agentLite.status !== "ACTIVE") {
    if (agentLite.status === "PAUSED") {
      console.warn(`[AI-Bot] agent ${agentLite.id} is PAUSED - escalating conv=${conversationId} to human`);
      await escalateToHuman(tenantId, conversationId, sendContext, agentLite.escalationMessage, agentLite.id, {
        case: "agent_paused",
        summary: "The AI employee is paused, so the conversation was handed to a human.",
      });
      return true;
    }
    console.warn(`[AI-Bot] agent ${agentLite.id} status=${agentLite.status} - not dispatching conv=${conversationId}`);
    return false;
  }

  // ── Business-hours gate (side-effect decision → worker-owned) ──
  // Evaluated from the tenant's PERSISTED config (shared evaluator), never
  // from frontend state. "silent" policy: while closed the AI does not answer
  // at all - the configured closed-hours response (or a generated default
  // with the REAL next opening time) is sent once per closed window.
  // "active" policy (default): the AI keeps answering; the closed context is
  // passed to the AI service so it never implies immediate human availability.
  const bizHours = await getBusinessHoursState(tenantId);
  if (bizHours.state.configured && !bizHours.state.open) {
    if ((bizHours.cfg?.aiOutsideHours || "active") === "silent") {
      await sendClosedHoursAutoReply(tenantId, conversationId, incomingMessage, sendContext, bizHours);
      return true;
    }
  }

  // Pre-check: hard limits set on the agent row. These are enforced by the
  // worker, not the AI service, because they're side-effect decisions
  // (escalate vs. continue) tied to the conversation's channel pipeline.
  const escalationCase = await checkEscalationThresholds(conversationId, tenantId, agentLite, incomingMessage);
  if (escalationCase) {
    await escalateToHuman(tenantId, conversationId, sendContext, agentLite.escalationMessage, agentLite.id, {
      case: escalationCase,
      summary: "The AI reached its autonomy limit for this conversation.",
    });
    return true;
  }

  // Pre-check: explicit human request - short-circuits the LLM call.
  if (isHumanRequest(incomingMessage)) {
    await escalateToHuman(tenantId, conversationId, sendContext, agentLite.escalationMessage, agentLite.id, {
      case: "customer_requested_human",
      summary: "The customer explicitly asked for a person.",
    });
    return true;
  }

  // Delegate the actual LLM work to AI service. The AI service:
  //   - loads the full agent config + history
  //   - builds the system prompt
  //   - performs RAG (KB retrieval)
  //   - runs the tool-calling loop (3 rounds)
  //   - returns reply / escalation / awaiting-approval signal
  let result: AIBotReplyResult;
  try {
    const res = await axios.post(
      `${AI_SERVICE_URL}/api/ai-bot/reply`,
      {
        tenantId,
        conversationId,
        aiAgentId: resolvedAgentId,
        incomingMessage,
        // Closed + "active" policy: the AI answers, but must speak truthfully
        // about human availability. Localized next-opening wording is computed
        // HERE (the tenant config lives on this side) and injected as prompt
        // context by the AI service.
        ...(bizHours.state.configured && !bizHours.state.open
          ? {
              closedHours: {
                nextOpeningIso: bizHours.state.nextOpening?.toISOString() ?? null,
                timezone: bizHours.state.timezone,
                nextOpeningText: {
                  en: describeNextOpening(bizHours.state, "en"),
                  he: describeNextOpening(bizHours.state, "he"),
                },
              },
            }
          : {}),
      },
      {
        headers: { "X-Internal-Key": INTERNAL_SERVICE_KEY, "Content-Type": "application/json" },
        timeout: 60_000,
      },
    );
    result = res.data as AIBotReplyResult;
  } catch (err: any) {
    // 499 - AI service aborted the in-flight LLM call because a newer
    // inbound for this conversation showed up. The newer job will produce
    // the reply; this job exits quietly. Critical: NO escalation, NO
    // error-level log - that would create the same "answering per message"
    // noise we're trying to suppress.
    if (err.response?.status === 499 || err.response?.data?.aborted) {
      console.log(
        `[AI-Bot] reply aborted conv=${conversationId} (newer turn took over) - dropping this job's reply`,
      );
      return false;
    }
    console.error("[AI-Bot] AI service /reply call failed:", err.response?.data || err.message);
    // NEVER leave the customer in silence: an AI-service failure/timeout hands
    // the conversation to a human with the warm handoff line. (The handoff
    // copy generator also lives in the AI service - escalateToHuman already
    // falls back to the agent's static escalationMessage when it's down.)
    try {
      await escalateToHuman(tenantId, conversationId, sendContext, agentLite.escalationMessage, agentLite.id, {
        case: "ai_service_failure",
        summary: "The AI could not produce a reply (service error or timeout), so the conversation was handed to a human.",
      });
      return true;
    } catch (escErr: any) {
      console.error("[AI-Bot] failure-escalation also failed:", escErr?.message);
      return false;
    }
  }

  // Side-effect: pause for human approval. Don't reply - set state, audit,
  // and send a short bridge ack so the customer isn't left hanging while a
  // human reviews the pending tool call.
  if (result.awaitingApproval) {
    try {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { handledBy: "awaiting_approval" },
      });
      await prisma.auditLog.create({
        data: {
          tenantId,
          actorType: "ai",
          action: "ai.paused_for_approval",
          targetType: "conversation",
          targetId: conversationId,
          metadata: {
            approvalRequestId: result.awaitingApproval.approvalRequestId,
            tool: result.awaitingApproval.tool,
            reason: result.awaitingApproval.reason,
          },
        },
      });
    } catch (err: any) {
      console.error("[AI-Bot] Failed to pause conversation:", err.message);
    }
    try {
      // Bridge-ack: a brief "give me a moment" while the human approves
      // the gated tool. Generated via AI oneshot so it lands in the
      // customer's language and stays in-character - never says "team
      // will reach out" since the bot is still the one handling the
      // conversation.
      let ack: string | null = null;
      try {
        // Pull a few recent inbound messages so the model can detect the
        // conversation's language even when the latest message is
        // language-less (an email, "ok", a number).
        const recentInbound = await prisma.message.findMany({
          where: { tenantId, conversationId, direction: "INBOUND" },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { body: true },
        });
        const inboundSample = recentInbound
          .map((m) => m.body?.trim())
          .filter((s): s is string => !!s)
          .reverse()
          .join("\n");
        const userInput =
          `[INTERNAL CONTEXT - do not echo to the customer]\n` +
          `Customer's recent messages (oldest → newest):\n${inboundSample || incomingMessage}\n\n` +
          `Customer's latest message: "${incomingMessage}"\n\n` +
          `TASK: Send ONE very short reply (max one sentence) to acknowledge the customer and tell them you're handling their request right now.\n` +
          `Rules:\n` +
          `- Detect the language from the FIRST customer message above (or any earlier non-trivial message). Reply in THAT language. If any message contains Hebrew characters, the language is Hebrew. Do not default to English.\n` +
          `- Do NOT say "a team member will reach out", "we'll get back to you", or anything that implies a handoff - you are handling this yourself.\n` +
          `- Do NOT mention the CRM, lead creation, or any internal system.\n` +
          `- Tone: warm, brief, like a human typing a quick "give me a sec".\n`;
        const oneshotRes = await axios.post(
          `${AI_SERVICE_URL}/api/ai-bot/oneshot`,
          { tenantId, aiAgentId: resolvedAgentId, userInput, feature: "approval_bridge_ack", maxTokens: 80 },
          {
            headers: { "X-Internal-Key": INTERNAL_SERVICE_KEY, "Content-Type": "application/json" },
            timeout: 15_000,
          },
        );
        const reply = (oneshotRes.data as { reply?: string | null } | undefined)?.reply;
        if (reply && reply.trim()) ack = reply.trim();
      } catch (err: any) {
        console.warn("[AI-Bot] bridge-ack oneshot failed; staying silent:", err?.message);
      }
      const adapter = ack ? getOutboundAdapter(sendContext.channel) : null;
      if (adapter && ack) {
        const extId = await adapter.sendTextMessage(
          sendContext.credentials,
          sendContext.channelAccountExternalId,
          sendContext.recipientId,
          ack,
        );
        const bridgeMsg = await prisma.message.create({
          data: {
            tenantId,
            conversationId,
            channel: sendContext.channel,
            direction: "OUTBOUND",
            body: ack,
            senderName: "AI Bot",
            externalMessageId: extId,
            status: extId ? "SENT" : "FAILED",
            metadata: { source: "ai_bot", kind: "bridge_ack_for_approval" },
          },
        });
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: new Date() },
        });
        await publishEvent({
          event: "message:new",
          tenantId,
          data: { message: bridgeMsg, conversationId, channel: sendContext.channel },
        });
      }
    } catch (err: any) {
      console.error("[AI-Bot] bridge ack failed:", err.message);
    }
    return true;
  }

  // Side-effect: model decided to escalate (via the escalate_to_human tool).
  if (result.escalation) {
    await escalateToHuman(tenantId, conversationId, sendContext, agentLite.escalationMessage, agentLite.id, {
      case: result.escalation.reason || "ai_decided",
      summary: result.escalation.summary,
    });
    return true;
  }

  // Side-effect: send the AI reply.
  if (!result.reply) return false;

  const adapter = getOutboundAdapter(sendContext.channel);
  if (!adapter) {
    console.error(`[AI-Bot] No outbound adapter for channel: ${sendContext.channel}`);
    return false;
  }

  // Two-bubble flow: send any pre-tool acks ("one moment, checking") as their
  // own message(s) first, then a brief pause so the result reads like the bot
  // actually went and checked, then the real reply. Best-effort: a failed
  // interim send never blocks the real reply.
  if (result.interimMessages?.length) {
    for (const interim of result.interimMessages) {
      if (!interim?.trim()) continue;
      try {
        const interimExtId = await adapter.sendTextMessage(
          sendContext.credentials,
          sendContext.channelAccountExternalId,
          sendContext.recipientId,
          interim,
        );
        const interimMsg = await prisma.message.create({
          data: {
            tenantId,
            conversationId,
            channel: sendContext.channel,
            direction: "OUTBOUND",
            body: interim,
            senderName: "AI Bot",
            externalMessageId: interimExtId,
            status: interimExtId ? "SENT" : "FAILED",
            metadata: { source: "ai_bot", kind: "interim_ack" },
          },
        });
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: new Date() },
        });
        await publishEvent({
          event: "message:new",
          tenantId,
          data: { message: interimMsg, conversationId, channel: sendContext.channel },
        });
      } catch (err: any) {
        console.warn("[AI-Bot] interim ack send failed (continuing to reply):", err?.message);
      }
    }
    // Small human-feeling gap between "checking…" and the result.
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  // Adapter throws on provider errors despite the `string | null` signature.
  // A failed send must still persist the reply row as FAILED (visible in the
  // inbox) instead of crashing the job into a retry loop with no record.
  let extId: string | null = null;
  let sendErrorDetail: ProviderSendError | null = null;
  let sendErrorMessage: string | null = null;
  try {
    extId = await adapter.sendTextMessage(
      sendContext.credentials,
      sendContext.channelAccountExternalId,
      sendContext.recipientId,
      result.reply,
    );
  } catch (err: any) {
    const described = describeSendError(err, sendContext.channel);
    sendErrorDetail = described.sendError;
    sendErrorMessage = described.errorMessage;
    // Full provider breakdown is persisted below (errorMessage + metadata.sendError)
    // so the failed send is diagnosable from the DB/UI without server logs.
    console.error(`[AI-Bot] reply send failed (persisting FAILED message):`, JSON.stringify(sendErrorDetail));
  }

  const aiMessage = await prisma.message.create({
    data: {
      tenantId,
      conversationId,
      channel: sendContext.channel,
      direction: "OUTBOUND",
      body: result.reply,
      senderName: "AI Bot",
      externalMessageId: extId,
      status: extId ? "SENT" : "FAILED",
      errorMessage: sendErrorMessage || undefined,
      metadata: {
        source: "ai_bot",
        ...(result.toolCallLog.length > 0 && {
          toolCalls: result.toolCallLog.map((tc) => ({ tool: tc.tool, decision: tc.decision })),
        }),
        ...(sendErrorDetail ? { sendError: sendErrorDetail } : {}),
      },
    },
  });

  trackMessageUsage(tenantId, conversationId, aiMessage.id, sendContext.channel).catch(() => {});

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date() },
  });

  await publishEvent({
    event: "message:new",
    tenantId,
    data: { message: aiMessage, conversationId, channel: sendContext.channel },
  });

  // If the bot called close_conversation this turn, the dispatcher already
  // flipped the conversation row to CLOSED (see agent-tools.ts close handler)
  // but it is "side-effect free" by design - the caller publishes the
  // downstream event. Without this, the post-chat subscriber (which feeds
  // summary, CRM patch, Customer Brief refresh, tasks, follow-ups) never
  // fires for bot-initiated closes.
  const closedByBot = result.toolCallLog.some(
    (tc) => tc.tool === "close_conversation" && tc.decision === "executed",
  );
  if (closedByBot) {
    await publishEvent({
      event: "conversation:closed",
      tenantId,
      data: { id: conversationId, conversationId, channel: sendContext.channel, status: "CLOSED" },
    });
  }

  return true;
}

async function trackMessageUsage(tenantId: string, conversationId: string, messageId: string, channel: string) {
  try {
    await prisma.usageLog.create({
      data: {
        tenantId,
        type: "message_sent",
        quantity: 1,
        tokensEquivalent: 1,
        metadata: { channel, conversationId, messageId },
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId,
        actorType: "ai",
        action: "message.sent",
        targetType: "conversation",
        targetId: conversationId,
        metadata: { messageId, channel, source: "ai_bot" },
      },
    });
  } catch (err: any) {
    console.error("[AI-Bot] Message usage tracking failed:", err.message);
  }
}

function buildSendContext(conversation: any): SendContext | null {
  if (!conversation.channelAccount) return null;

  const rawCreds = conversation.channelAccount.credentials;
  const creds = typeof rawCreds === "string" ? decryptCredentials(rawCreds) : (rawCreds as any);
  return {
    channel: conversation.channel,
    channelAccountExternalId: conversation.channelAccount.externalId,
    // Spread ALL decrypted fields (not just accessToken/appSecret) so channel
    // flags like `igLogin` survive - the Instagram adapter needs it to pick the
    // graph.instagram.com host instead of graph.facebook.com.
    credentials: { ...creds },
    recipientId: conversation.customerExternalId,
  };
}

/**
 * Deterministic escalation gates. Returns the machine-readable CASE that
 * fired (persisted so owners can see WHY the bot handed off) or null when
 * no gate tripped.
 */
async function checkEscalationThresholds(
  conversationId: string,
  tenantId: string,
  config: { maxAutonomousMessages: number | null; maxAutonomousMinutes: number | null },
  incomingText?: string,
): Promise<string | null> {
  const aiMessageCount = await prisma.message.count({
    where: {
      conversationId,
      tenantId,
      direction: "OUTBOUND",
      metadata: { path: ["source"], equals: "ai_bot" },
    },
  });

  const maxMsgs = config.maxAutonomousMessages || 10;
  const hardCeiling = maxMsgs * 2;

  // Hard ceiling - true runaway-loop backstop, always escalates.
  if (aiMessageCount >= hardCeiling) {
    console.log(`[AI-Bot] HARD ceiling reached (${aiMessageCount}/${hardCeiling}) for conversation ${conversationId} - escalating`);
    return "hard_message_ceiling";
  }

  // GOAL PRESERVATION: the soft message/time caps are autonomous-budget limits,
  // not a reason to abandon a live deal. When the objective is still viable - we
  // have a way to reach the customer (a contact email/phone) and they're engaged
  // (this runs on a fresh inbound) - suppress the soft caps so a hot lead one
  // message from booking isn't handed to a human just for crossing a counter.
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { createdAt: true, channel: true, customerExternalId: true },
  });
  let hasReachPath = false;
  try {
    if (conversation) {
      const contact = await prisma.contact.findFirst({
        where: { tenantId, channel: conversation.channel, externalId: conversation.customerExternalId },
        select: { email: true, phone: true },
      });
      hasReachPath = !!(contact?.email || contact?.phone);
    }
  } catch (err: any) {
    console.warn("[AI-Bot] reach-path lookup failed (non-fatal):", err?.message);
  }
  // A scheduling request (book / move / cancel a meeting or demo) is an action
  // the AI can complete - never hand it to a human for crossing a counter. This
  // is the main reason a returning customer ("can we move the demo?") used to
  // auto-escalate. Treat such a turn as goal-viable.
  const schedulingIntent =
    /(reschedul|postpone|\bmove\b|cancel|book|schedule|לקבוע|לתאם|להזיז|לדחות|לבטל|לשנות|פגיש|דמו|demo|meeting)/i.test(
      incomingText || "",
    );
  const goalViable = hasReachPath || schedulingIntent; // engagement implied: runs on an inbound

  if (aiMessageCount >= maxMsgs) {
    if (goalViable) {
      console.log(`[AI-Bot] soft msg cap (${aiMessageCount}/${maxMsgs}) reached but objective viable - NOT escalating (goal preservation) conv=${conversationId}`);
    } else {
      console.log(`[AI-Bot] Max messages reached (${aiMessageCount}/${maxMsgs}) for conversation ${conversationId}`);
      return "autonomous_message_cap";
    }
  }

  if (conversation) {
    // Measure the CURRENT autonomous burst, not the conversation's lifetime age.
    // A burst resets after a quiet gap (≥30m), so a customer returning hours/days
    // later doesn't trip the "AI ran too long" cap the instant they message.
    const BURST_RESET_MS = 30 * 60_000;
    let autonomousSinceMs = conversation.createdAt.getTime();
    try {
      const recent = await prisma.message.findMany({
        where: { conversationId, tenantId },
        orderBy: { createdAt: "asc" },
        take: 50,
        select: { createdAt: true },
      });
      for (let i = 1; i < recent.length; i++) {
        const prev = new Date(recent[i - 1].createdAt).getTime();
        const cur = new Date(recent[i].createdAt).getTime();
        if (cur - prev >= BURST_RESET_MS) autonomousSinceMs = cur;
      }
      if (recent.length > 0) {
        const lastMs = new Date(recent[recent.length - 1].createdAt).getTime();
        if (Date.now() - lastMs >= BURST_RESET_MS) autonomousSinceMs = Date.now();
      }
    } catch (err: any) {
      console.warn("[AI-Bot] burst-start lookup failed (non-fatal):", err?.message);
    }
    const minutesElapsed = (Date.now() - autonomousSinceMs) / 60000;
    const maxMins = config.maxAutonomousMinutes || 15;
    if (minutesElapsed >= maxMins && !goalViable) {
      console.log(`[AI-Bot] Max burst time reached (${Math.round(minutesElapsed)}m/${maxMins}m) for conversation ${conversationId}`);
      return "autonomous_time_cap";
    }
  }

  return null;
}

// A bare keyword like "נציג"/"agent"/"representative" is NOT a handoff request:
// it fires on questions ABOUT agents ("how many agents do you support?",
// "מה קורה כשזה מגיע לנציג?"). This short-circuits the LLM, so it must detect
// the customer's INTENT to reach a human - i.e. an ask/request verb paired with
// the human noun - not the noun alone. Mirrors the AI service's
// detectHumanHandoff() (services/ai/src/services/ai-bot.service.ts).
//
// \b doesn't work for Hebrew in JS (non-ASCII aren't word chars), so Hebrew
// patterns anchor on whitespace/start/end instead.
const HUMAN_HANDOFF_PATTERNS: RegExp[] = [
  // English - explicit request to be connected to a person.
  // `(?:an?\s+|the\s+)?` tolerates "a/an/the agent" (and no article).
  /\b(speak|talk|connect|chat|transfer|put me through)\s+(to|with|me)\s+(?:to\s+)?(?:an?\s+|the\s+)?(human|agent|person|someone|rep|representative)\b/i,
  /\b(can\s+i|i\s+(?:want|need|wanna|would like))\s+(to\s+)?(speak|talk|chat)\s+(to|with)\s+(?:an?\s+|the\s+)?(human|agent|person|someone|rep)\b/i,
  /\b(give|get|connect)\s+me\s+(?:to\s+)?(?:an?\s+|the\s+)?(human|agent|person|rep)\b/i,
  /\bnot\s+a\s+bot\b/i,
  // Hebrew - explicit request only
  /(?:^|\s)לדבר עם\s+(אדם|נציג|נציגה|מישהו|בנאדם)/,
  /(?:^|\s)תעבירו? אותי\s+(?:ל|אל)\s*(אדם|נציג|נציגה|מישהו)/,
  /(?:^|\s)(?:אני רוצה|אני צריך|תן לי|תני לי|אפשר)\s+(?:לדבר עם\s+)?(אדם|נציג|נציגה|בנאדם|אנושי)(?:\s|$|[.,!?])/,
  /(?:^|\s)נציג\s+(אנושי|אמיתי|בבקשה)(?:\s|$|[.,!?])/,
  /(?:^|\s)(אדם|בנאדם)\s+(אמיתי|אנושי)(?:\s|$|[.,!?])/,
];
function isHumanRequest(message: string): boolean {
  if (!message) return false;
  for (const re of HUMAN_HANDOFF_PATTERNS) if (re.test(message)) return true;
  return false;
}

// ─── Business hours (tenant-persisted; shared evaluator) ─────
const HEBREW_RE = /[֐-׿]/;

async function getBusinessHoursState(
  tenantId: string,
): Promise<{ cfg: BusinessHoursConfig | null; state: BusinessOpenState }> {
  try {
    const raw = await getRedis().get(BUSINESS_HOURS_KEY(tenantId));
    const cfg = parseBusinessHours(raw);
    return { cfg, state: evaluateBusinessHours(cfg) };
  } catch (err: any) {
    // Config store unreachable → behave as always-open. The bot answering
    // during closed hours is recoverable; the bot going mute is not.
    console.warn("[AI-Bot] business-hours read failed (treating as open):", err?.message);
    return { cfg: null, state: { configured: false, open: true, nextOpening: null, timezone: "UTC" } };
  }
}

/**
 * "silent" outside-hours policy: send the configured closed-hours response
 * (or a generated default carrying the REAL next opening time) instead of an
 * AI reply - at most once per closed window per conversation, so a customer
 * sending three messages overnight gets one notice, not three.
 */
async function sendClosedHoursAutoReply(
  tenantId: string,
  conversationId: string,
  incomingMessage: string,
  sendContext: SendContext,
  biz: { cfg: BusinessHoursConfig | null; state: BusinessOpenState },
): Promise<void> {
  // Dedupe: an auto-reply already sent after the last opening? The next
  // opening is at most a week away, so "within the last 24h" bounds one
  // closed window for any realistic schedule without tracking window edges.
  const recent = await prisma.message.findFirst({
    where: {
      tenantId,
      conversationId,
      direction: "OUTBOUND",
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      metadata: { path: ["closedHoursAutoReply"], equals: true },
    },
    select: { id: true },
  });
  if (recent) return;

  const he = HEBREW_RE.test(incomingMessage || "");
  const when = describeNextOpening(biz.state, he ? "he" : "en");
  const body =
    biz.cfg?.autoResponse?.trim() ||
    (he
      ? `תודה שפניתם אלינו! אנחנו כרגע סגורים. נחזור לפעילות ${when} ונענה לכם אז.`
      : `Thanks for reaching out! We're currently closed. We'll be back ${when} and will reply then.`);

  const adapter = getOutboundAdapter(sendContext.channel);
  if (!adapter) return;
  let extId: string | null = null;
  let sendErrorMessage: string | null = null;
  try {
    extId = await adapter.sendTextMessage(
      sendContext.credentials,
      sendContext.channelAccountExternalId,
      sendContext.recipientId,
      body,
    );
  } catch (err: any) {
    sendErrorMessage = describeSendError(err, sendContext.channel).errorMessage;
    console.warn("[AI-Bot] closed-hours auto-reply send failed:", sendErrorMessage);
  }
  await prisma.message.create({
    data: {
      tenantId,
      conversationId,
      channel: sendContext.channel,
      direction: "OUTBOUND",
      body,
      senderName: "AI Bot",
      externalMessageId: extId,
      status: extId ? "SENT" : "FAILED",
      errorMessage: sendErrorMessage || undefined,
      metadata: { source: "ai_bot", closedHoursAutoReply: true },
    },
  });
  await publishEvent({ event: "conversation:updated", tenantId, data: { id: conversationId } });
}

async function escalateToHuman(
  tenantId: string,
  conversationId: string,
  sendContext: SendContext,
  fallbackMessage: string,
  aiAgentId?: string,
  reason?: { case: string; summary?: string },
): Promise<void> {
  const adapter = getOutboundAdapter(sendContext.channel);
  if (!adapter) return;

  // Every handoff must know whether the business is OPEN: telling a customer
  // "connecting you with a person" at 2am implies availability that doesn't
  // exist. Evaluated here - the single choke point every escalation path
  // (limits, keywords, model-decided, AI failure, paused agent) runs through.
  const biz = await getBusinessHoursState(tenantId);
  const closed = biz.state.configured && !biz.state.open;

  // Generate the customer-facing handoff message via AI so it lands in
  // the conversation's language (Hebrew/English/Arabic/…) and stays in
  // the agent's voice. Falls back to the agent's configured static
  // `escalationMessage` if the oneshot fails - never block the actual
  // escalation just because copywriting hiccupped.
  let escalationMessage = await generateEscalationHandoff(
    tenantId,
    conversationId,
    aiAgentId,
    fallbackMessage,
    closed,
  );

  if (closed) {
    // Deterministic availability line - appended AFTER generation so the real
    // next-opening time always reaches the customer even when the oneshot
    // fell back to the static message. Owner-written copy wins when set.
    const he = HEBREW_RE.test(escalationMessage);
    const custom = biz.cfg?.outsideHoursHandoffMessage?.trim();
    const when = describeNextOpening(biz.state, he ? "he" : "en");
    const line = custom ||
      (he
        ? `הצוות שלנו כרגע מחוץ לשעות הפעילות - נציג יחזור אליכם ${when}.`
        : `Our team is currently outside business hours - a representative will get back to you ${when}.`);
    escalationMessage = `${escalationMessage}\n${line}`;
  }

  // The adapter THROWS on provider errors (bad number, closed 24h window,
  // template required) despite the `string | null` signature. A failed SEND
  // must never abort the ESCALATION itself - the human takeover and the
  // audit trail matter more than the courtesy message. Degrade to a FAILED
  // message row and continue.
  let extId: string | null = null;
  let escSendError: ProviderSendError | null = null;
  let escSendErrorMessage: string | null = null;
  try {
    extId = await adapter.sendTextMessage(
      sendContext.credentials,
      sendContext.channelAccountExternalId,
      sendContext.recipientId,
      escalationMessage,
    );
  } catch (err: any) {
    const described = describeSendError(err, sendContext.channel);
    escSendError = described.sendError;
    escSendErrorMessage = described.errorMessage;
    console.warn(`[AI-Bot] escalation handoff send failed (continuing with handover):`, JSON.stringify(escSendError));
  }

  await prisma.message.create({
    data: {
      tenantId,
      conversationId,
      channel: sendContext.channel,
      direction: "OUTBOUND",
      body: escalationMessage,
      senderName: "AI Bot",
      externalMessageId: extId,
      status: extId ? "SENT" : "FAILED",
      errorMessage: escSendErrorMessage || undefined,
      metadata: {
        source: "ai_bot",
        escalation: true,
        aiGenerated: escalationMessage !== fallbackMessage,
        ...(reason ? { escalationCase: reason.case, ...(reason.summary ? { escalationSummary: reason.summary } : {}) } : {}),
        ...(escSendError ? { sendError: escSendError } : {}),
      },
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      isHandedOver: true,
      status: "WAITING",
    },
  });

  await prisma.message.create({
    data: {
      tenantId,
      conversationId,
      channel: sendContext.channel,
      direction: "INBOUND",
      body: "",
      messageType: "system",
      senderName: "System",
      status: "DELIVERED",
      metadata: {
        systemEvent: "ai_bot_escalation",
        // Why the bot handed off - rendered on the inbox divider so the
        // handover is explainable, not a bare label.
        ...(reason ? { escalationCase: reason.case, ...(reason.summary ? { escalationSummary: reason.summary } : {}) } : {}),
      },
    },
  });

  await publishEvent({
    event: "conversation:updated",
    tenantId,
    data: { id: conversationId, isHandedOver: true, status: "WAITING", ...(reason ? { escalationCase: reason.case } : {}) },
  });
}

/**
 * Produce a natural-language escalation handoff message in the customer's
 * language by calling the AI service's oneshot endpoint. Mirrors the
 * approval-bridge-ack pattern: pulls the recent inbound messages so the
 * model can detect language even when the latest message is language-
 * less (an emoji, "ok", a number).
 *
 * Falls back to the agent's configured static `escalationMessage` when
 * the oneshot fails - never block the actual handoff because copywriting
 * hiccupped. The agent-level static remains the safety net that ships in
 * a known language and tone.
 */
async function generateEscalationHandoff(
  tenantId: string,
  conversationId: string,
  aiAgentId: string | undefined,
  fallback: string,
  outsideBusinessHours = false,
): Promise<string> {
  if (!aiAgentId) return fallback;
  try {
    const recentInbound = await prisma.message.findMany({
      where: { tenantId, conversationId, direction: "INBOUND" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { body: true },
    });
    const inboundSample = recentInbound
      .map((m) => m.body?.trim())
      .filter((s): s is string => !!s)
      .reverse()
      .join("\n");
    if (!inboundSample) return fallback;

    const userInput =
      `[INTERNAL CONTEXT - do not echo to the customer]\n` +
      `Customer's recent messages (oldest → newest):\n${inboundSample}\n\n` +
      `TASK: Send ONE short reply (max one sentence) telling the customer that you're connecting them with a human team member who will continue from here.\n` +
      `Rules:\n` +
      `- Detect the language from the FIRST customer message above (or any earlier non-trivial message). Reply in THAT language. If any message contains Hebrew characters, the language is Hebrew. If Arabic characters, the language is Arabic. Do not default to English.\n` +
      `- Tone: warm, brief, like a human typing a quick handoff note.\n` +
      `- Do NOT mention the CRM, lead creation, or any internal system.\n` +
      `- Do NOT promise a specific response time unless it is implicit in the conversation.\n` +
      `- Do NOT add greetings like "Hi" or sign-offs.\n` +
      (outsideBusinessHours
        ? `- The human team is OUTSIDE business hours right now: say a team member will follow up, but do NOT imply anyone is available immediately (no "right away", "shortly", "connecting you now").\n`
        : "");

    const res = await axios.post(
      `${AI_SERVICE_URL}/api/ai-bot/oneshot`,
      { tenantId, aiAgentId, userInput, feature: "escalation_handoff", maxTokens: 80 },
      {
        headers: { "X-Internal-Key": INTERNAL_SERVICE_KEY, "Content-Type": "application/json" },
        timeout: 15_000,
      },
    );
    const reply = (res.data as { reply?: string | null } | undefined)?.reply;
    if (reply && reply.trim()) return reply.trim();
  } catch (err: any) {
    console.warn("[AI-Bot] escalation oneshot failed; falling back to static:", err?.message);
  }
  return fallback;
}

// ─── One-shot reply (delegated to AI service) ──────────────
//
// Used by the comment-trigger walker for `send_comment_reply` (mode=ai).
// Worker keeps the public-comment side effect; the LLM call itself goes
// through AI service so all OpenAI traffic stays in one place.

export async function generateOneShotReply(
  tenantId: string,
  aiAgentId: string,
  userInput: string,
  options: { maxTokens?: number; feature?: string } = {},
): Promise<string | null> {
  try {
    const res = await axios.post(
      `${AI_SERVICE_URL}/api/ai-bot/oneshot`,
      {
        tenantId,
        aiAgentId,
        userInput,
        maxTokens: options.maxTokens,
        feature: options.feature,
      },
      {
        headers: { "X-Internal-Key": INTERNAL_SERVICE_KEY, "Content-Type": "application/json" },
        timeout: 30_000,
      },
    );
    const data = res.data as { reply: string | null };
    return data.reply || null;
  } catch (err: any) {
    console.error("[AI-OneShot] AI service call failed:", err.response?.data || err.message);
    return null;
  }
}
