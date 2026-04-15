import OpenAI from "openai";
import { prisma, getOutboundAdapter, decryptCredentials, publishEvent, trackAIUsage } from "@chatcenter/shared";
import type { ChannelCredentials } from "@chatcenter/shared";
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
      orderBy: { priority: "asc" },
    });
    if (rule?.aiAgentId) {
      const agent = await prisma.aIAgent.findUnique({ where: { id: rule.aiAgentId } });
      if (agent && agent.status !== "PAUSED") return agent;
    }
  }
  // 2. Default tenant AI agent
  const defaultRule = await prisma.routerRule.findFirst({
    where: { tenantId, routeType: "AI_AGENT", aiAgentId: { not: null }, enabled: true, isDefault: true },
    orderBy: { priority: "asc" },
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
    const response = await openai.chat.completions.create({
      model,
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 1024,
      messages: chatMessages,
    });

    const usage = response.usage;

    // Track token usage via centralized shared helper (fire-and-forget)
    if (usage) {
      trackAIUsage({
        tenantId,
        feature: "ai_bot",
        model,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        metadata: { conversationId, aiAgentId: config.id },
      }).catch((err: any) => console.error("[AI-Bot] Usage tracking failed:", err.message));

      // Audit log (separate from usage)
      prisma.auditLog.create({
        data: {
          tenantId,
          actorType: "ai",
          action: "ai.responded",
          targetType: "conversation",
          targetId: conversationId,
          metadata: { model, tokens: usage.total_tokens, source: "ai_bot" },
        },
      }).catch((err: any) => console.error("[AI-Bot] Audit log failed:", err.message));
    }

    const replyText = response.choices[0]?.message?.content?.trim();
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
        metadata: { source: "ai_bot" },
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
