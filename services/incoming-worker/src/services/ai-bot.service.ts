/**
 * Autonomous AI bot — worker side.
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
} from "@chatcenter/shared";
import type { ChannelCredentials } from "@chatcenter/shared";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";

interface SendContext {
  channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM";
  channelAccountExternalId: string;
  credentials: ChannelCredentials;
  recipientId: string;
}

interface AIBotReplyResult {
  reply: string | null;
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
  // No legacy RouterRule fallback — if the graph never picked an agent for
  // this conversation, the AI bot does nothing and the conversation stays
  // unassigned for a human to claim.
  let resolvedAgentId: string | null = aiAgentId || null;
  if (!resolvedAgentId && (conversation as any).assignedAiAgentId) {
    resolvedAgentId = (conversation as any).assignedAiAgentId as string;
  }
  if (!resolvedAgentId) return false;

  // Validate the agent row before we round-trip — this catches "agent
  // deleted but assignedAiAgentId still set" without burning a network call.
  const agentLite = await prisma.aIAgent.findUnique({
    where: { id: resolvedAgentId },
    select: { id: true, tenantId: true, escalationMessage: true, maxAutonomousMessages: true, maxAutonomousMinutes: true, status: true },
  });
  if (!agentLite || agentLite.tenantId !== tenantId) return false;

  const sendContext = buildSendContext(conversation);
  if (!sendContext) return false;

  // Pre-check: hard limits set on the agent row. These are enforced by the
  // worker, not the AI service, because they're side-effect decisions
  // (escalate vs. continue) tied to the conversation's channel pipeline.
  const shouldEscalate = await checkEscalationThresholds(conversationId, tenantId, agentLite);
  if (shouldEscalate) {
    await escalateToHuman(tenantId, conversationId, sendContext, agentLite.escalationMessage, agentLite.id);
    return true;
  }

  // Pre-check: explicit human request — short-circuits the LLM call.
  if (isHumanRequest(incomingMessage)) {
    await escalateToHuman(tenantId, conversationId, sendContext, agentLite.escalationMessage, agentLite.id);
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
      },
      {
        headers: { "X-Internal-Key": INTERNAL_SERVICE_KEY, "Content-Type": "application/json" },
        timeout: 60_000,
      },
    );
    result = res.data as AIBotReplyResult;
  } catch (err: any) {
    console.error("[AI-Bot] AI service /reply call failed:", err.response?.data || err.message);
    return false;
  }

  // Side-effect: pause for human approval. Don't reply — set state, audit,
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
      // customer's language and stays in-character — never says "team
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
          `[INTERNAL CONTEXT — do not echo to the customer]\n` +
          `Customer's recent messages (oldest → newest):\n${inboundSample || incomingMessage}\n\n` +
          `Customer's latest message: "${incomingMessage}"\n\n` +
          `TASK: Send ONE very short reply (max one sentence) to acknowledge the customer and tell them you're handling their request right now.\n` +
          `Rules:\n` +
          `- Detect the language from the FIRST customer message above (or any earlier non-trivial message). Reply in THAT language. If any message contains Hebrew characters, the language is Hebrew. Do not default to English.\n` +
          `- Do NOT say "a team member will reach out", "we'll get back to you", or anything that implies a handoff — you are handling this yourself.\n` +
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
    await escalateToHuman(tenantId, conversationId, sendContext, agentLite.escalationMessage, agentLite.id);
    return true;
  }

  // Side-effect: send the AI reply.
  if (!result.reply) return false;

  const adapter = getOutboundAdapter(sendContext.channel);
  if (!adapter) {
    console.error(`[AI-Bot] No outbound adapter for channel: ${sendContext.channel}`);
    return false;
  }

  const extId = await adapter.sendTextMessage(
    sendContext.credentials,
    sendContext.channelAccountExternalId,
    sendContext.recipientId,
    result.reply,
  );

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
      metadata: {
        source: "ai_bot",
        ...(result.toolCallLog.length > 0 && {
          toolCalls: result.toolCallLog.map((tc) => ({ tool: tc.tool, decision: tc.decision })),
        }),
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
    credentials: { accessToken: creds.accessToken, appSecret: creds.appSecret },
    recipientId: conversation.customerExternalId,
  };
}

async function checkEscalationThresholds(
  conversationId: string,
  tenantId: string,
  config: { maxAutonomousMessages: number | null; maxAutonomousMinutes: number | null },
): Promise<boolean> {
  const aiMessageCount = await prisma.message.count({
    where: {
      conversationId,
      tenantId,
      direction: "OUTBOUND",
      metadata: { path: ["source"], equals: "ai_bot" },
    },
  });

  const maxMsgs = config.maxAutonomousMessages || 10;
  if (aiMessageCount >= maxMsgs) {
    console.log(`[AI-Bot] Max messages reached (${aiMessageCount}/${maxMsgs}) for conversation ${conversationId}`);
    return true;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { createdAt: true },
  });

  if (conversation) {
    const minutesElapsed = (Date.now() - conversation.createdAt.getTime()) / 60000;
    const maxMins = config.maxAutonomousMinutes || 15;
    if (minutesElapsed >= maxMins) {
      console.log(`[AI-Bot] Max time reached (${Math.round(minutesElapsed)}m/${maxMins}m) for conversation ${conversationId}`);
      return true;
    }
  }

  return false;
}

function isHumanRequest(message: string): boolean {
  const lower = message.toLowerCase().trim();
  const humanKeywords = [
    "speak to a human", "talk to a human", "human agent", "real person",
    "speak to someone", "talk to someone", "agent please", "representative",
    "speak to agent", "talk to agent", "transfer me", "connect me",
    "נציג", "נציג אנושי", "לדבר עם נציג", "אדם אמיתי",
  ];
  return humanKeywords.some((kw) => lower.includes(kw));
}

async function escalateToHuman(
  tenantId: string,
  conversationId: string,
  sendContext: SendContext,
  fallbackMessage: string,
  aiAgentId?: string,
): Promise<void> {
  const adapter = getOutboundAdapter(sendContext.channel);
  if (!adapter) return;

  // Generate the customer-facing handoff message via AI so it lands in
  // the conversation's language (Hebrew/English/Arabic/…) and stays in
  // the agent's voice. Falls back to the agent's configured static
  // `escalationMessage` if the oneshot fails — never block the actual
  // escalation just because copywriting hiccupped.
  const escalationMessage = await generateEscalationHandoff(
    tenantId,
    conversationId,
    aiAgentId,
    fallbackMessage,
  );

  const extId = await adapter.sendTextMessage(
    sendContext.credentials,
    sendContext.channelAccountExternalId,
    sendContext.recipientId,
    escalationMessage,
  );

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
      metadata: { source: "ai_bot", escalation: true, aiGenerated: escalationMessage !== fallbackMessage },
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
      metadata: { systemEvent: "ai_bot_escalation" },
    },
  });

  await publishEvent({
    event: "conversation:updated",
    tenantId,
    data: { id: conversationId, isHandedOver: true, status: "WAITING" },
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
 * the oneshot fails — never block the actual handoff because copywriting
 * hiccupped. The agent-level static remains the safety net that ships in
 * a known language and tone.
 */
async function generateEscalationHandoff(
  tenantId: string,
  conversationId: string,
  aiAgentId: string | undefined,
  fallback: string,
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
      `[INTERNAL CONTEXT — do not echo to the customer]\n` +
      `Customer's recent messages (oldest → newest):\n${inboundSample}\n\n` +
      `TASK: Send ONE short reply (max one sentence) telling the customer that you're connecting them with a human team member who will continue from here.\n` +
      `Rules:\n` +
      `- Detect the language from the FIRST customer message above (or any earlier non-trivial message). Reply in THAT language. If any message contains Hebrew characters, the language is Hebrew. If Arabic characters, the language is Arabic. Do not default to English.\n` +
      `- Tone: warm, brief, like a human typing a quick handoff note.\n` +
      `- Do NOT mention the CRM, lead creation, or any internal system.\n` +
      `- Do NOT promise a specific response time unless it is implicit in the conversation.\n` +
      `- Do NOT add greetings like "Hi" or sign-offs.\n`;

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
