import { prisma, resolveEffectiveLocale } from "@chatcenter/shared";
import { getProvider, summarizeConversation, classifyMessage, classifySentiment, ConversationContext } from "./ai-assist.service";

export async function analyzeConversation(tenantId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
  });
  if (!conversation) throw new Error("Conversation not found");

  const messages = await prisma.message.findMany({
    where: { conversationId, tenantId },
    orderBy: { createdAt: "asc" },
    select: { direction: true, body: true, senderName: true, createdAt: true, metadata: true, messageType: true },
  });

  // Classify intent from last inbound message
  const lastInbound = [...messages].reverse().find((m) => m.direction === "INBOUND" && m.messageType !== "system");
  let detectedIntent = "general";
  let intentConfidence = 0;
  if (lastInbound?.body) {
    try {
      const classification = await classifyMessage(lastInbound.body);
      detectedIntent = classification.intent;
      intentConfidence = classification.confidence;
    } catch {
      detectedIntent = "general";
      intentConfidence = 0;
    }
  }

  // Resolve the tenant's effective system language so the summary is written
  // in the same tongue as the rest of the workspace AND the CRM note labels -
  // otherwise the summary comes out English while the note frame is localized.
  const summaryLocale = await resolveEffectiveLocale({ tenantId })
    .then((r) => r.effective)
    .catch(() => undefined);

  // Summarize conversation
  let summary: string | undefined;
  try {
    const context: ConversationContext = {
      tenantId,
      conversationId,
      customerName: conversation.customerName || undefined,
      locale: summaryLocale,
      messages: messages.map((m) => ({
        direction: m.direction as "INBOUND" | "OUTBOUND",
        body: m.body || "",
        senderName: m.senderName || undefined,
        createdAt: m.createdAt.toISOString(),
      })),
    };
    summary = await summarizeConversation(context);
  } catch {
    summary = undefined;
  }

  // Determine sentiment from the customer's messages via the LLM (judges the
  // substance of the whole thread - an engaged, curious customer reads as
  // positive even without explicit "thanks"). Falls back to neutral on error.
  const inboundText = messages
    .filter((m) => m.direction === "INBOUND" && m.body)
    .map((m) => m.body!)
    .join("\n");

  let sentiment = "neutral";
  let sentimentScore = 0;
  if (inboundText.trim()) {
    try {
      const s = await classifySentiment(inboundText, summaryLocale);
      sentiment = s.sentiment;
      sentimentScore = s.score;
    } catch {
      sentiment = "neutral";
      sentimentScore = 0;
    }
  }

  // Resolution outcome from conversation status
  let resolutionOutcome = "open";
  if (conversation.status === "CLOSED") {
    const lastOutbound = [...messages].reverse().find((m) => m.direction === "OUTBOUND");
    const meta = lastOutbound?.metadata as any;
    if (meta?.systemEvent === "ai_bot_escalation") {
      resolutionOutcome = "escalated";
    } else if (lastOutbound) {
      resolutionOutcome = "resolved";
    } else {
      resolutionOutcome = "abandoned";
    }
  }

  // Count tools used
  const toolExecutions = await prisma.toolExecution.findMany({
    where: { conversationId, tenantId },
    select: { id: true },
  });
  const toolsUsed = [toolExecutions.length];

  // Customer effort based on total message count
  const msgCount = messages.filter((m) => m.messageType !== "system").length;
  let customerEffort: number;
  if (msgCount <= 2) customerEffort = 1;
  else if (msgCount <= 5) customerEffort = 2;
  else if (msgCount <= 10) customerEffort = 3;
  else if (msgCount <= 15) customerEffort = 4;
  else customerEffort = 5;

  // The conversation existed when we started, but LLM work above takes
  // seconds - the user may have deleted it in the meantime, dropping the FK
  // target. Catch P2003 and return null instead of a 500.
  try {
    const intelligence = await prisma.conversationIntelligence.upsert({
      where: { conversationId },
      create: {
        tenantId,
        conversationId,
        summary,
        detectedIntent,
        intentConfidence,
        sentiment,
        sentimentScore,
        topics: [],
        toolsUsed,
        resolutionOutcome,
        customerEffort,
        aiConfidence: intentConfidence,
        analyzedAt: new Date(),
      },
      update: {
        summary,
        detectedIntent,
        intentConfidence,
        sentiment,
        sentimentScore,
        topics: [],
        toolsUsed,
        resolutionOutcome,
        customerEffort,
        aiConfidence: intentConfidence,
        analyzedAt: new Date(),
      },
    });
    return intelligence;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "P2003" || code === "P2025") {
      console.warn(
        "[conversation-intelligence] conversation gone before upsert - skipping",
        conversationId,
      );
      return null;
    }
    throw err;
  }
}

export async function getConversationIntelligence(tenantId: string, conversationId: string) {
  const existing = await prisma.conversationIntelligence.findFirst({
    where: { conversationId, tenantId },
  });
  if (existing) return existing;
  return analyzeConversation(tenantId, conversationId);
}

export async function getConversationReplay(tenantId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
  });
  if (!conversation) throw new Error("Conversation not found");

  const [messages, toolExecutions] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId, tenantId },
      orderBy: { createdAt: "asc" },
      select: { id: true, direction: true, body: true, senderName: true, createdAt: true, metadata: true, messageType: true },
    }),
    prisma.toolExecution.findMany({
      where: { conversationId, tenantId },
      orderBy: { createdAt: "asc" },
      include: { tenantTool: { include: { catalogTool: { select: { name: true } } } } },
    }),
  ]);

  const intelligence = await getConversationIntelligence(tenantId, conversationId);

  // Build timeline
  const timeline: Array<{
    type: string;
    timestamp: string;
    data: Record<string, any>;
  }> = [];

  // Merge messages and tool executions by timestamp
  let toolIdx = 0;

  for (const msg of messages) {
    // Insert any tool executions that occurred before this message
    while (
      toolIdx < toolExecutions.length &&
      toolExecutions[toolIdx].createdAt <= msg.createdAt
    ) {
      const te = toolExecutions[toolIdx];
      timeline.push({
        type: "tool_executed",
        timestamp: te.createdAt.toISOString(),
        data: {
          tenantToolId: te.tenantToolId,
          toolName: (te as any).tenantTool?.catalogTool?.name || te.tenantToolId,
          input: te.input,
          output: te.output,
          success: te.success,
          durationMs: te.durationMs,
        },
      });
      toolIdx++;
    }

    const meta = msg.metadata as any;

    if (msg.messageType === "system") {
      timeline.push({
        type: "system_event",
        timestamp: msg.createdAt.toISOString(),
        data: { body: msg.body, metadata: msg.metadata },
      });
    } else if (msg.direction === "INBOUND") {
      timeline.push({
        type: "customer_message",
        timestamp: msg.createdAt.toISOString(),
        data: { id: msg.id, body: msg.body, senderName: msg.senderName },
      });
    } else if (msg.direction === "OUTBOUND" && meta?.source === "ai_bot") {
      // AI analysis event before AI reply
      timeline.push({
        type: "ai_analysis",
        timestamp: msg.createdAt.toISOString(),
        data: { intent: intelligence?.detectedIntent, sentiment: intelligence?.sentiment },
      });
      timeline.push({
        type: "ai_reply",
        timestamp: msg.createdAt.toISOString(),
        data: { id: msg.id, body: msg.body },
      });
    } else if (msg.direction === "OUTBOUND") {
      timeline.push({
        type: "agent_reply",
        timestamp: msg.createdAt.toISOString(),
        data: { id: msg.id, body: msg.body, senderName: msg.senderName },
      });
    }
  }

  // Remaining tool executions after all messages
  while (toolIdx < toolExecutions.length) {
    const te = toolExecutions[toolIdx];
    timeline.push({
      type: "tool_executed",
      timestamp: te.createdAt.toISOString(),
      data: {
        tenantToolId: te.tenantToolId,
        toolName: (te as any).tenantTool?.catalogTool?.name || te.tenantToolId,
        input: te.input,
        output: te.output,
        success: te.success,
        durationMs: te.durationMs,
      },
    });
    toolIdx++;
  }

  if (conversation.status === "CLOSED") {
    timeline.push({
      type: "resolved",
      timestamp: (conversation.closedAt || conversation.lastMessageAt || new Date()).toISOString(),
      data: { resolutionOutcome: intelligence?.resolutionOutcome },
    });
  }

  const duration =
    messages.length >= 2
      ? messages[messages.length - 1].createdAt.getTime() - messages[0].createdAt.getTime()
      : 0;

  return {
    conversation,
    intelligence,
    timeline,
    summary: {
      duration,
      messageCount: messages.length,
      toolsUsedCount: toolExecutions.length,
    },
  };
}
