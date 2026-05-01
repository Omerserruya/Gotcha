/**
 * Autonomous AI bot reply generator (server-side).
 *
 * This is the SOLE owner of the LLM call for the autonomous "/agent" mode.
 * It loads the agent config + conversation history, assembles the system
 * prompt, performs RAG, runs the tool-calling loop, and returns either:
 *   - a reply text to send to the customer,
 *   - an escalation request,
 *   - an "awaiting approval" pause signal.
 *
 * Side effects (sending the reply, persisting messages, escalating, pausing
 * the conversation, publishing socket events) are handled by the caller —
 * usually the incoming-worker. This module's contract is "compute the next
 * AI move"; the caller decides what to do with it.
 *
 * The OpenAI call goes through `generateResponse()` (services/ai.service.ts)
 * so token usage and `ai.responded` audit events flow through the central
 * gateway, exactly like the copilot path.
 */

import { prisma, buildAgentToolsForAIAgent, dispatchToolCall } from "@chatcenter/shared";
import type { AgentToolContext } from "@chatcenter/shared";
import { generateResponse } from "./ai.service";
import { retrieveRelevantChunks, buildKnowledgeContext } from "./knowledge.service";
import { ensureAgentPrompts } from "./prompt-assembler.service";
import { buildConfigFromAIAgent } from "./ai-assist.service";
import { shouldSearchKB } from "./openai.provider";
import { prefetchCrmContext, renderCrmContextBlock } from "./crm-prefetch.service";

export interface AIBotReplyResult {
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

/**
 * Build the autonomous-mode system prompt for an AIAgent row.
 *
 * Lazy-backfills `sharedPrompt` / `autonomousPrompt` for agents that pre-date
 * the prompt-parts column (so production agents like "Rotem" self-heal on
 * first run), then delegates to `assemblePrompt` via `buildConfigFromAIAgent`
 * — the SAME path /assist (copilot) uses, just with role="agent".
 *
 * This is the source of truth for autonomous-mode prompts. Both
 * `generateAIBotReply` and `generateAIBotOneshot` go through here.
 */
export async function buildAgentSystemPrompt(rawAgent: any): Promise<string> {
  const agent = await ensureAgentPrompts(rawAgent);
  return buildConfigFromAIAgent(agent as any, "agent").systemPrompt;
}

/**
 * Walk the recent inbound messages and return the first email address
 * the customer typed. Lets the CRM prefetch search by email even when
 * the only stable identifier on the conversation is the WhatsApp phone.
 * Best-effort — returns undefined if nothing looks like an email.
 */
function extractRecentEmail(messages: Array<{ direction: string; body: string | null }>): string | undefined {
  const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction !== "INBOUND" || !m.body) continue;
    const match = m.body.match(re);
    if (match) return match[0].toLowerCase();
  }
  return undefined;
}

export async function generateAIBotReply(opts: {
  tenantId: string;
  conversationId: string;
  aiAgentId: string;
  incomingMessage: string;
}): Promise<AIBotReplyResult> {
  const config = await prisma.aIAgent.findUnique({ where: { id: opts.aiAgentId } });
  if (!config || config.tenantId !== opts.tenantId) {
    throw Object.assign(new Error("AI Agent not found for tenant"), { status: 404 });
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: opts.conversationId, tenantId: opts.tenantId },
  });
  if (!conversation) {
    throw Object.assign(new Error("Conversation not found"), { status: 404 });
  }

  // History: same shape the worker used — last 50 messages, mapped to
  // user/assistant turns. Skip empty + system-tagged messages.
  const messages = await prisma.message.findMany({
    where: { conversationId: opts.conversationId, tenantId: opts.tenantId },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  // System prompt + RAG augmentation.
  let systemPrompt = await buildAgentSystemPrompt(config);

  // Language directive: the autonomous path doesn't have a `locale` like
  // the copilot does, so we instruct the model explicitly to mirror the
  // customer's language. This is the strongest signal we can give without
  // burning a separate detection call.
  systemPrompt +=
    `\n\n## Language — STRICT\n` +
    `Detect the language of the customer's MOST RECENT message and reply in THAT SAME language. ` +
    `If the customer wrote in Hebrew, reply in Hebrew. If they wrote in English, reply in English. ` +
    `Never default to English unless that's the language the customer is using. ` +
    `Maintain the chosen language for the entire conversation unless the customer switches.`;

  // KB retrieval — gated. Skip Qdrant for greetings, confirmations, bare
  // emails/phones, and other semantically-empty messages. Saves a vector
  // search per turn and keeps irrelevant chunks out of the prompt.
  if (shouldSearchKB(opts.incomingMessage)) {
    try {
      const chunks = await retrieveRelevantChunks(opts.tenantId, opts.incomingMessage, 5);
      const kbContext = buildKnowledgeContext(chunks);
      if (kbContext) systemPrompt += "\n\n" + kbContext;
    } catch (err: any) {
      console.warn("[ai-bot] Knowledge retrieval failed:", err.message);
    }
  }

  // If a HITL approval is already pending on this conversation, surface
  // it to the model so it doesn't propose the same gated action again.
  // We also drop integration_* tools from the surface for this turn —
  // the bot can chat freely while we wait for the human, and can't
  // double-fire the gated call. The dispatcher dedupes by tool as a
  // belt-and-suspenders second line of defense.
  let pendingApprovals: Array<{ id: string; tool: string }> = [];
  try {
    pendingApprovals = await prisma.approvalRequest.findMany({
      where: {
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        status: "PENDING",
      },
      select: { id: true, tool: true },
      orderBy: { createdAt: "desc" },
    });
  } catch (err: any) {
    console.warn("[ai-bot] pending-approval lookup failed:", err?.message);
  }
  if (pendingApprovals.length > 0) {
    const list = pendingApprovals.map((a) => `\`${a.tool}\``).join(", ");
    systemPrompt +=
      `\n\n## Pending Approval — IMPORTANT\n` +
      `The following tool(s) you proposed earlier are awaiting human approval: ${list}.\n` +
      `Do NOT call them again in this turn — the request is already in front of the team. ` +
      `Keep the conversation moving with the customer in a natural way: answer their question, ` +
      `clarify, qualify, or move toward the next step. Do not mention the approval to the customer.`;
  }

  const chatMessages: any[] = [{ role: "system", content: systemPrompt }];

  // Customer & Conversation Info — same idea as the copilot block. Gives
  // the model the customer's phone (WhatsApp wa_id), name, channel, and
  // timing UP-FRONT so it doesn't have to ask for things we already know,
  // and so background actions (e.g. create_lead) get filled with the
  // existing data instead of half-empty payloads.
  try {
    const infoLines: string[] = [];
    if ((conversation as any).customerName) infoLines.push(`- Customer Name: ${(conversation as any).customerName}`);
    if (conversation.customerExternalId) {
      const isPhone = /^\+?\d{6,}$/.test(String(conversation.customerExternalId).replace(/[\s-]/g, ""));
      const label = conversation.channel === "WHATSAPP" || isPhone ? "Phone (WhatsApp)" : "External ID";
      const value = conversation.channel === "WHATSAPP" && !String(conversation.customerExternalId).startsWith("+")
        ? `+${conversation.customerExternalId}`
        : conversation.customerExternalId;
      infoLines.push(`- ${label}: ${value}`);
    }
    if (conversation.channel) infoLines.push(`- Channel: ${conversation.channel}`);
    if ((conversation as any).status) infoLines.push(`- Conversation Status: ${(conversation as any).status}`);
    if (conversation.createdAt) infoLines.push(`- Conversation Started: ${conversation.createdAt.toISOString()}`);
    if ((conversation as any).lastMessageAt) infoLines.push(`- Last Message: ${(conversation as any).lastMessageAt.toISOString()}`);
    if (infoLines.length > 0) {
      chatMessages.push({
        role: "user",
        content:
          `## Customer & Conversation Info\n${infoLines.join("\n")}\n\n` +
          `Use these values when running background actions (CRM lookup, lead create/update, tagging). ` +
          `Do NOT ask the customer for information that is already listed here.`,
      });
    }
  } catch (err: any) {
    console.warn("[ai-bot] Customer info block build failed:", err?.message);
  }

  for (const m of messages) {
    if (!m.body?.trim()) continue;
    if ((m as any).messageType === "system") continue;
    chatMessages.push({
      role: m.direction === "INBOUND" ? "user" : "assistant",
      content: m.body,
    });
  }

  // Tool context for dispatchToolCall — link_customer_identifier,
  // escalate_to_human, and any tenant integrations the agent has enabled.
  const contact = await prisma.contact.findFirst({
    where: { tenantId: opts.tenantId, channel: conversation.channel, externalId: conversation.customerExternalId },
    select: { id: true },
  });
  const agentToolCtx: AgentToolContext = {
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    contactId: contact?.id,
    authToken: process.env.INTERNAL_SERVICE_TOKEN,
  };

  let tools = await buildAgentToolsForAIAgent(opts.tenantId, config.id, {
    identityLinking: !!contact?.id,
    escalation: true,
  });

  // CRM prefetch: hit lead_search + contact_search up-front using the
  // customer's WhatsApp phone (and email if we can find one in the
  // recent transcript). If a match comes back, we (a) inject the record
  // into the system prompt as `## Existing CRM Records` and (b) STRIP
  // create_lead / create_contact from the tool surface for this turn —
  // so the model literally cannot mint a duplicate. The model still has
  // update / add-note / add-tag tools to act on the existing record.
  try {
    const recentEmail = extractRecentEmail(messages);
    const prefetch = await prefetchCrmContext(opts.tenantId, opts.conversationId, {
      externalId: conversation.customerExternalId,
      email: recentEmail,
    });
    if (prefetch) {
      const block = renderCrmContextBlock(prefetch);
      if (block) {
        systemPrompt += "\n\n" + block;
      }
      if (prefetch.leadMatches.length > 0) {
        tools = tools.filter((t: any) => t?.function?.name !== "integration_create_lead");
      }
      if (prefetch.contactMatches.length > 0) {
        tools = tools.filter((t: any) => t?.function?.name !== "integration_create_contact");
      }
    }
  } catch (err: any) {
    console.warn("[ai-bot] CRM prefetch failed (non-fatal):", err?.message);
  }

  if (pendingApprovals.length > 0) {
    // Strip integration tools while a HITL approval is pending. Keeps
    // link_customer_identifier and escalate_to_human (and submit_*) so
    // the bot can still pick up identifiers or escalate if the customer
    // gets upset, but can't queue another gated CRM action.
    tools = tools.filter((t: any) => {
      const fnName: string | undefined = t?.function?.name;
      if (!fnName) return true;
      return !fnName.startsWith("integration_");
    });
  }

  const model = config.model || "gpt-4o-mini";
  let pendingEscalation: AIBotReplyResult["escalation"] = null;
  let awaitingApproval: AIBotReplyResult["awaitingApproval"] = null;
  let replyText: string | null = null;
  let totalTokens = 0;
  const toolCallLog: AIBotReplyResult["toolCallLog"] = [];

  // Tool-calling loop — same 3-round cap as before.
  for (let round = 0; round < 3; round++) {
    const response = await generateResponse({
      tenantId: opts.tenantId,
      model,
      messages: chatMessages,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 1024,
      tools: tools as any[],
      metadata: { type: "ai_bot", conversationId: opts.conversationId, aiAgentId: config.id },
    });

    totalTokens += response.usage.total_tokens || 0;

    const toolCalls = response.toolCalls;
    if (toolCalls && toolCalls.length > 0) {
      // Append the assistant turn (with tool_calls) and each tool result —
      // required by OpenAI's tool-calling protocol.
      chatMessages.push({
        role: "assistant",
        content: response.content || "",
        tool_calls: toolCalls,
      });

      let pausedForApproval: AIBotReplyResult["awaitingApproval"] = null;
      for (const tc of toolCalls) {
        const toolName = tc.function?.name || "unknown";
        let toolArgs: Record<string, unknown> = {};
        try { toolArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}

        const result = await dispatchToolCall(
          { id: tc.id, function: { name: toolName, arguments: tc.function?.arguments || "{}" } },
          agentToolCtx,
        );

        const sideEffectType = result.sideEffect?.awaitingApproval ? "awaiting_approval"
          : result.sideEffect?.denied ? "denied"
          : result.sideEffect?.escalate ? "escalate"
          : undefined;
        toolCallLog.push({
          tool: toolName,
          args: toolArgs,
          result: result.content,
          decision: sideEffectType || "executed",
          sideEffect: sideEffectType,
        });

        prisma.auditLog.create({
          data: {
            tenantId: opts.tenantId,
            actorType: "ai",
            action: `ai.tool_call.${toolName}`,
            targetType: "conversation",
            targetId: opts.conversationId,
            metadata: {
              tool: toolName,
              args: toolArgs,
              decision: sideEffectType || "executed",
              result: result.content.slice(0, 500),
              source: "ai_bot",
            },
          },
        }).catch((err: any) => console.error(`[ai-bot] Tool call audit failed for ${toolName}:`, err.message));

        if (result.sideEffect?.escalate) pendingEscalation = result.sideEffect.escalate;
        if (result.sideEffect?.awaitingApproval && !pausedForApproval) {
          pausedForApproval = result.sideEffect.awaitingApproval;
        }
        chatMessages.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          content: result.content,
        });
      }

      if (pausedForApproval) {
        // Stop the loop — caller will set conversation state and send the
        // bridge ack to the customer. We only return the signal.
        awaitingApproval = pausedForApproval;
        break;
      }
      // Continue so the model can use the tool results to finalize its reply.
      continue;
    }

    // No tool calls — final answer.
    replyText = response.content?.trim() || null;
    break;
  }

  // Audit the AI interaction summary. `ai.responded` is already logged inside
  // generateResponse() per LLM call; this entry summarizes the whole turn
  // (including tool calls and escalation outcome).
  prisma.auditLog.create({
    data: {
      tenantId: opts.tenantId,
      actorType: "ai",
      action: "ai.bot_turn",
      targetType: "conversation",
      targetId: opts.conversationId,
      metadata: {
        model,
        tokens: totalTokens,
        source: "ai_bot",
        escalated: !!pendingEscalation,
        awaitingApproval: !!awaitingApproval,
        toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
      },
    },
  }).catch((err: any) => console.error("[ai-bot] Audit log failed:", err.message));

  return {
    reply: awaitingApproval ? null : replyText,
    escalation: pendingEscalation,
    awaitingApproval,
    toolCallLog,
    modelUsed: model,
    totalTokens,
  };
}

// ─── One-shot reply (no conversation, no tools) ─────────────
//
// Used by surfaces that need an AI Employee to draft a single response
// without participating in the inbox-conversation pipeline (e.g. comment
// trigger walker's `send_comment_reply` mode=ai). No history, no tools,
// no KB retrieval.

export async function generateAIBotOneshot(opts: {
  tenantId: string;
  aiAgentId: string;
  userInput: string;
  maxTokens?: number;
  feature?: string;
}): Promise<{ reply: string | null; modelUsed: string; totalTokens: number }> {
  const config = await prisma.aIAgent.findUnique({ where: { id: opts.aiAgentId } });
  if (!config || config.tenantId !== opts.tenantId) {
    throw Object.assign(new Error("AI Agent not found for tenant"), { status: 404 });
  }
  if (config.status === "PAUSED") {
    return { reply: null, modelUsed: config.model || "gpt-4o-mini", totalTokens: 0 };
  }

  const systemPrompt = await buildAgentSystemPrompt(config);
  const model = config.model || "gpt-4o-mini";
  const maxTokens = opts.maxTokens ?? Math.min(config.maxTokens ?? 1024, 400);

  const result = await generateResponse({
    tenantId: opts.tenantId,
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: opts.userInput },
    ],
    temperature: config.temperature ?? 0.7,
    maxTokens,
    metadata: { type: opts.feature || "comment_reply", aiAgentId: config.id },
  });

  return {
    reply: result.content?.trim() || null,
    modelUsed: model,
    totalTokens: result.usage.total_tokens || 0,
  };
}
