import OpenAI from "openai";
import {
  prisma,
  getOutboundAdapter,
  decryptCredentials,
  publishEvent,
  trackAIUsage,
  buildAgentTools,
  buildAgentToolsForAIAgent,
  dispatchToolCall,
} from "@chatcenter/shared";
import type { ChannelCredentials, AgentToolContext } from "@chatcenter/shared";
import { retrieveRelevantChunks, buildKnowledgeContext } from "./knowledge-retrieval.service";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface SendContext {
  channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM";
  channelAccountExternalId: string;
  credentials: ChannelCredentials;
  recipientId: string;
}

/**
 * Resolve the AI Employee config for a conversation.
 * Priority: department-assigned AI agent → default tenant AI agent → any active agent.
 */
async function resolveAIAgent(tenantId: string, departmentId?: string | null) {
  // 1. Department-specific AI agent
  if (departmentId) {
    const rule = await prisma.routerRule.findFirst({
      where: { tenantId, routeType: "AI_AGENT", aiAgentId: { not: null }, enabled: true, routeTarget: departmentId },
      orderBy: { position: "asc" } as any,
    });
    if (rule?.aiAgentId) {
      const agent = await prisma.aIAgent.findUnique({ where: { id: rule.aiAgentId } });
      if (agent && agent.status !== "PAUSED") return agent;
    }
  }
  // 2. Default tenant AI agent
  const defaultRule = await prisma.routerRule.findFirst({
    where: { tenantId, routeType: "AI_AGENT", aiAgentId: { not: null }, enabled: true, isDefault: true },
    orderBy: { position: "asc" } as any,
  });
  if (defaultRule?.aiAgentId) {
    const agent = await prisma.aIAgent.findUnique({ where: { id: defaultRule.aiAgentId } });
    if (agent && agent.status !== "PAUSED") return agent;
  }
  // 3. Any active AI agent for this tenant
  return prisma.aIAgent.findFirst({
    where: { tenantId, status: { in: ["ACTIVE", "DRAFT"] } },
    orderBy: { createdAt: "asc" },
  });
}

export async function processAIBot(tenantId: string, conversationId: string, incomingMessage: string, aiAgentId?: string | null): Promise<boolean> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { channelAccount: true },
  });

  if (!conversation || conversation.isHandedOver || conversation.assignedAgentId) return false;

  // Use the explicitly provided AI agent, or resolve one
  let config: any = null;
  if (aiAgentId) {
    config = await prisma.aIAgent.findUnique({ where: { id: aiAgentId } });
  }
  if (!config) {
    config = await resolveAIAgent(tenantId, (conversation as any).departmentId);
  }
  if (!config) return false;

  // Build send context
  const sendContext = buildSendContext(conversation);
  if (!sendContext) return false;

  // Check escalation thresholds before processing
  const shouldEscalate = await checkEscalationThresholds(conversationId, tenantId, config);
  if (shouldEscalate) {
    await escalateToHuman(tenantId, conversationId, sendContext, config.escalationMessage);
    return true;
  }

  // Check if user explicitly requests a human
  if (isHumanRequest(incomingMessage)) {
    await escalateToHuman(tenantId, conversationId, sendContext, config.escalationMessage);
    return true;
  }

  // Get conversation history for context
  const messages = await prisma.message.findMany({
    where: { conversationId, tenantId },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  // Build system prompt from config
  const systemPrompt = buildSystemPrompt(config);

  // RAG: Retrieve relevant knowledge base context
  let finalPrompt = systemPrompt;
  try {
    const chunks = await retrieveRelevantChunks(tenantId, incomingMessage, 5);
    const kbContext = buildKnowledgeContext(chunks);
    if (kbContext) finalPrompt += "\n\n" + kbContext;
  } catch (err: any) {
    console.warn("[AI-Bot] Knowledge retrieval failed:", err.message);
  }

  // Build chat messages
  const chatMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: finalPrompt },
  ];

  for (const msg of messages) {
    if (!msg.body?.trim()) continue;
    if (msg.messageType === "system") continue;
    chatMessages.push({
      role: msg.direction === "INBOUND" ? "user" : "assistant",
      content: msg.body,
    });
  }

  try {
    const model = config.model || "gpt-4o-mini";

    // Resolve the Contact row for this conversation so the AI can link
    // identifiers it extracts from the customer's message.
    const contact = await prisma.contact.findFirst({
      where: { tenantId, channel: conversation.channel, externalId: conversation.customerExternalId },
      select: { id: true },
    });

    const agentToolCtx: AgentToolContext = {
      tenantId,
      conversationId,
      contactId: contact?.id,
      authToken: process.env.INTERNAL_SERVICE_TOKEN,
    };

    // Load integration tools the operator enabled for this AI agent in
    // AI Studio → Tools. Without this, the LLM only sees the two static
    // helpers (link_customer_identifier + escalate_to_human) and can
    // never call things like integration.create_lead.
    const tools = await buildAgentToolsForAIAgent(tenantId, config.id, {
      identityLinking: !!contact?.id,
      escalation: true,
    });

    // Tool-calling loop. Up to 3 rounds is plenty: the model either emits a
    // tool call once and then the final reply, or it replies directly. The
    // cap exists to bound the worst case without letting a buggy model
    // ping-pong forever.
    let pendingEscalation: { reason: string; priority?: "low"|"medium"|"high"; summary?: string } | null = null;
    let replyText: string | undefined;
    let totalTokens = 0;
    const toolCallLog: Array<{ tool: string; args: Record<string, unknown>; result: string; decision?: string; sideEffect?: string }> = [];

    for (let round = 0; round < 3; round++) {
      const response = await openai.chat.completions.create({
        model,
        temperature: config.temperature ?? 0.7,
        max_tokens: config.maxTokens ?? 1024,
        messages: chatMessages,
        tools: tools as any,
      });

      if (response.usage) {
        totalTokens += response.usage.total_tokens || 0;
        trackAIUsage({
          tenantId,
          feature: "ai_bot",
          model,
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          metadata: { conversationId, aiAgentId: config.id },
        }).catch((err: any) => console.error("[AI-Bot] Usage tracking failed:", err.message));
      }

      const choice = response.choices[0]?.message;
      if (!choice) break;

      const toolCalls = (choice as any).tool_calls as any[] | undefined;
      if (toolCalls && toolCalls.length > 0) {
        // Append the assistant turn that contained the tool_calls, then each
        // tool result message — required by OpenAI's tool-calling protocol.
        chatMessages.push({
          role: "assistant",
          content: choice.content ?? "",
          tool_calls: toolCalls,
        } as any);

        let pausedForApproval: { approvalRequestId: string; tool: string; reason: string } | null = null;
        for (const tc of toolCalls) {
          const toolName = tc.function?.name || "unknown";
          let toolArgs: Record<string, unknown> = {};
          try { toolArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}

          const result = await dispatchToolCall(
            { id: tc.id, function: { name: toolName, arguments: tc.function?.arguments || "{}" } },
            agentToolCtx,
          );

          // Log every tool call for audit trail
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

          // Audit each tool call individually
          prisma.auditLog.create({
            data: {
              tenantId,
              actorType: "ai",
              action: `ai.tool_call.${toolName}`,
              targetType: "conversation",
              targetId: conversationId,
              metadata: {
                tool: toolName,
                args: toolArgs,
                decision: sideEffectType || "executed",
                result: result.content.slice(0, 500),
                source: "ai_bot",
              },
            },
          }).catch((err: any) => console.error(`[AI-Bot] Tool call audit failed for ${toolName}:`, err.message));

          if (result.sideEffect?.escalate) pendingEscalation = result.sideEffect.escalate;
          if (result.sideEffect?.awaitingApproval && !pausedForApproval) {
            pausedForApproval = result.sideEffect.awaitingApproval;
          }
          chatMessages.push({
            role: "tool",
            tool_call_id: result.toolCallId,
            content: result.content,
          } as any);
        }
        // F4: if any tool call needs approval, pause the conversation
        // and STOP generating. The resume worker will pick up the
        // approval when a human decides and restart the bot turn with
        // the approved params merged into the tool result.
        if (pausedForApproval) {
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
                  approvalRequestId: pausedForApproval.approvalRequestId,
                  tool: pausedForApproval.tool,
                  reason: pausedForApproval.reason,
                },
              },
            });
          } catch (err: any) {
            console.error("[AI-Bot] Failed to pause conversation:", err.message);
          }
          // Don't leave the customer in silence while a human decides. Send a
          // short bridge ack in the same language as the incoming message.
          try {
            const isHebrew = /[֐-׿]/.test(incomingMessage);
            const ack = isHebrew
              ? "תודה! קיבלתי את הפרטים ואני מעביר אותם לצוות — נציג יחזור אליך בהקדם."
              : "Thanks — I've got your details and I'm passing them on to the team. Someone will reach out shortly.";
            const adapter = getOutboundAdapter(sendContext.channel);
            if (adapter) {
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
        // Loop again so the model can use the tool results to finalize its reply.
        continue;
      }

      // No tool calls — this is the final answer.
      replyText = choice.content?.trim();
      break;
    }

    // Audit the full AI interaction (fire-and-forget).
    prisma.auditLog.create({
      data: {
        tenantId,
        actorType: "ai",
        action: "ai.responded",
        targetType: "conversation",
        targetId: conversationId,
        metadata: {
          model,
          tokens: totalTokens,
          source: "ai_bot",
          escalated: !!pendingEscalation,
          toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
        },
      },
    }).catch((err: any) => console.error("[AI-Bot] Audit log failed:", err.message));

    // If the model escalated, route through the existing human-handoff path
    // and do not send an AI reply downstream.
    if (pendingEscalation) {
      await escalateToHuman(tenantId, conversationId, sendContext, config.escalationMessage);
      return true;
    }

    if (!replyText) return false;

    // Send the reply via channel adapter
    const adapter = getOutboundAdapter(sendContext.channel);
    if (!adapter) {
      console.error(`[AI-Bot] No outbound adapter for channel: ${sendContext.channel}`);
      return false;
    }

    const extId = await adapter.sendTextMessage(
      sendContext.credentials,
      sendContext.channelAccountExternalId,
      sendContext.recipientId,
      replyText
    );

    // Store the AI message
    const aiMessage = await prisma.message.create({
      data: {
        tenantId,
        conversationId,
        channel: sendContext.channel,
        direction: "OUTBOUND",
        body: replyText,
        senderName: "AI Bot",
        externalMessageId: extId,
        status: extId ? "SENT" : "FAILED",
        metadata: {
          source: "ai_bot",
          ...(toolCallLog.length > 0 && { toolCalls: toolCallLog.map(tc => ({ tool: tc.tool, decision: tc.decision })) }),
        },
      },
    });

    // Track message_sent usage
    trackMessageUsage(tenantId, conversationId, aiMessage.id, sendContext.channel).catch(() => {});

    // Update conversation timestamp
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });

    // Publish real-time event
    await publishEvent({
      event: "message:new",
      tenantId,
      data: { message: aiMessage, conversationId, channel: sendContext.channel },
    });

    return true;
  } catch (err: any) {
    console.error("[AI-Bot] OpenAI error:", err.message);
    return false;
  }
}

// ─── Legacy helper (no longer used — kept stubbed for any stale imports) ──

async function trackUsageAndAudit(_tenantId: string, _conversationId: string, _totalTokens: number, _model: string) {
  // Replaced by trackAIUsage() from @chatcenter/shared + inline auditLog.create.
  // See the call site inside processAIBot().
  try {
    /* noop */
  } catch (err: any) {
    console.error("[AI-Bot] (legacy) tracking failed:", err.message);
  }
}

async function trackMessageUsage(tenantId: string, conversationId: string, messageId: string, channel: string) {
  try {
    await prisma.usageLog.create({
      data: {
        tenantId,
        type: "message_sent",
        quantity: 1,
        tokensEquivalent: 1, // actual: 1 message sent
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

// ─── Existing helpers (unchanged) ───────────────────────────

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

function buildSystemPrompt(config: any): string {
  let prompt = config.systemPrompt || "You are a helpful customer support AI assistant.";

  // Add rules
  const rules = Array.isArray(config.rules) ? config.rules : [];
  if (rules.length > 0) {
    prompt += "\n\nRules you must follow:\n" + rules.map((r: string) => `- ${r}`).join("\n");
  }

  // Add structured personality blocks if present
  if (config.identity) {
    const id = config.identity as any;
    if (id.role) prompt += `\n\nYour role: ${id.role}`;
    if (id.responsibility) prompt += `\nYour responsibility: ${id.responsibility}`;
    if (id.representationGuidelines?.length) {
      prompt += "\nRepresentation guidelines:\n" + id.representationGuidelines.map((g: string) => `- ${g}`).join("\n");
    }
  }

  if (config.tone) {
    const t = config.tone as any;
    const toneDetails: string[] = [];
    if (t.formalityLevel) toneDetails.push(`Formality: ${t.formalityLevel}`);
    if (t.empathyLevel) toneDetails.push(`Empathy: ${t.empathyLevel}`);
    if (t.assertiveness) toneDetails.push(`Assertiveness: ${t.assertiveness}`);
    if (t.brandAlignment) toneDetails.push(`Brand voice: ${t.brandAlignment}`);
    if (toneDetails.length) prompt += "\n\nTone guidelines:\n" + toneDetails.map((d) => `- ${d}`).join("\n");
  }

  if (config.behavioral) {
    const b = config.behavioral as any;
    if (b.forbiddenActions?.length) {
      prompt += "\n\nForbidden actions:\n" + b.forbiddenActions.map((a: string) => `- ${a}`).join("\n");
    }
    if (b.safetyBoundaries?.length) {
      prompt += "\n\nSafety boundaries:\n" + b.safetyBoundaries.map((s: string) => `- ${s}`).join("\n");
    }
  }

  prompt += "\n\n## Truthfulness & Knowledge Base Rules\n- If knowledge base context is provided above, BASE your answers on that information.\n- NEVER fabricate information, product details, prices, policies, or facts that are not in the knowledge base or conversation.\n- If you don't have enough information to answer a question, say so honestly and offer to connect the customer with a human agent.\n- When citing information from the knowledge base, be accurate — do not paraphrase in a way that changes the meaning.\n- If the customer asks about something not covered in the knowledge base, clearly state that you don't have that information rather than guessing.";

  prompt += "\n\nIMPORTANT: You are chatting directly with the customer. Respond naturally and helpfully. If you cannot help with something, let them know you'll connect them with a human agent.";

  return prompt;
}

async function checkEscalationThresholds(
  conversationId: string,
  tenantId: string,
  config: any
): Promise<boolean> {
  const aiMessageCount = await prisma.message.count({
    where: {
      conversationId,
      tenantId,
      direction: "OUTBOUND",
      metadata: { path: ["source"], equals: "ai_bot" },
    },
  });

  if (aiMessageCount >= (config.maxAutonomousMessages || 10)) {
    console.log(`[AI-Bot] Max messages reached (${aiMessageCount}/${config.maxAutonomousMessages}) for conversation ${conversationId}`);
    return true;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { createdAt: true },
  });

  if (conversation) {
    const minutesElapsed = (Date.now() - conversation.createdAt.getTime()) / 60000;
    if (minutesElapsed >= (config.maxAutonomousMinutes || 15)) {
      console.log(`[AI-Bot] Max time reached (${Math.round(minutesElapsed)}m/${config.maxAutonomousMinutes}m) for conversation ${conversationId}`);
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
  escalationMessage: string
): Promise<void> {
  const adapter = getOutboundAdapter(sendContext.channel);
  if (!adapter) return;

  const extId = await adapter.sendTextMessage(
    sendContext.credentials,
    sendContext.channelAccountExternalId,
    sendContext.recipientId,
    escalationMessage
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
      metadata: { source: "ai_bot", escalation: true },
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
