import { prisma, analyticsQueue } from "@chatcenter/shared";
import axios from "axios";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";

function classifyIntentLocally(message: string): { intent: string; department: string | null } {
  const lower = message.toLowerCase();
  if (/\b(price|pricing|buy|purchase|plan|upgrade|demo|trial|quote)\b/.test(lower))
    return { intent: "sales_inquiry", department: "Sales" };
  if (/\b(invoice|bill|payment|charge|refund|subscription|cancel.*plan)\b/.test(lower))
    return { intent: "billing", department: "Billing" };
  if (/\b(bug|error|broken|crash|not working|issue|problem|fix|debug)\b/.test(lower))
    return { intent: "technical_support", department: "Support" };
  if (/\b(return|ship|deliver|track|order|package)\b/.test(lower))
    return { intent: "order_inquiry", department: "Support" };
  return { intent: "general", department: null };
}

function detectSentiment(messages: { body: string | null; direction: string }[]): { sentiment: string; score: number } {
  const inbound = messages.filter((m) => m.direction === "INBOUND" && m.body);
  const text = inbound.map((m) => m.body!).join(" ").toLowerCase();

  const positiveWords = /\b(thank|thanks|great|awesome|good|excellent|happy|satisfied|love|perfect|helpful)\b/g;
  const negativeWords = /\b(bad|terrible|awful|worst|horrible|angry|frustrated|useless|disappointed|hate|problem|broken)\b/g;

  const posMatches = (text.match(positiveWords) || []).length;
  const negMatches = (text.match(negativeWords) || []).length;

  if (posMatches === 0 && negMatches === 0) return { sentiment: "neutral", score: 0 };
  const total = posMatches + negMatches;
  const score = (posMatches - negMatches) / total; // -1.0 to 1.0
  const sentiment = score > 0.1 ? "positive" : score < -0.1 ? "negative" : "neutral";
  return { sentiment, score };
}

function determineResolutionOutcome(messages: { direction: string; metadata: any }[]): string {
  // If last message is from agent/AI and conversation closed, consider resolved
  const lastOutbound = [...messages].reverse().find((m) => m.direction === "OUTBOUND");
  if (!lastOutbound) return "abandoned";

  const meta = lastOutbound.metadata as any;
  if (meta?.systemEvent === "ai_bot_escalation") return "escalated";
  if (meta?.source === "ai_bot" || lastOutbound.direction === "OUTBOUND") return "resolved";
  return "abandoned";
}

/**
 * Run full intelligence analysis on a conversation.
 *
 * Name kept historically as `analyzeClosedConversation` but the function
 * is no longer close-only — it now also fires on bot→human handoff
 * milestones so the incoming human gets an instant summary. The
 * `analyzeConversation` alias below is the preferred name for new callers.
 */
export async function analyzeClosedConversation(tenantId: string, conversationId: string): Promise<void> {
  // Try AI service first
  try {
    await axios.post(
      `${AI_SERVICE_URL}/api/ai-assist/${conversationId}/analyze`,
      { tenantId },
      { timeout: 5000 }
    );
    console.log(`[intelligence] AI service analyzed conversation ${conversationId}`);

    // Trigger agent scoring after analysis (fire-and-forget)
    axios.post(
      `${AI_SERVICE_URL}/api/ai-assist/${conversationId}/score`,
      { tenantId },
      { timeout: 10000 }
    ).then(() => {
      console.log(`[intelligence] Agent scored for conversation ${conversationId}`);
    }).catch((err: any) => {
      console.warn(`[intelligence] Agent scoring failed for ${conversationId}:`, err.message);
    });

    await analyticsQueue.add("conversation-analyzed", {
      tenantId,
      event: "conversation_analyzed",
      data: { conversationId, source: "ai_service" },
      timestamp: new Date().toISOString(),
    });
    return;
  } catch (err: any) {
    console.warn(`[intelligence] AI service unavailable for ${conversationId}, using heuristics:`, err.message);
  }

  // Fallback: local heuristic analysis
  try {
    const messages = await prisma.message.findMany({
      where: { conversationId, tenantId },
      orderBy: { createdAt: "asc" },
      select: { body: true, direction: true, metadata: true, messageType: true },
    });

    if (messages.length === 0) return;

    // Detect intent from first inbound message
    const firstInbound = messages.find((m) => m.direction === "INBOUND" && m.messageType !== "system");
    const { intent } = firstInbound?.body
      ? classifyIntentLocally(firstInbound.body)
      : { intent: "general" };

    // Detect sentiment
    const { sentiment, score: sentimentScore } = detectSentiment(messages);

    // Customer effort: number of inbound messages (more messages = higher effort)
    const inboundCount = messages.filter((m) => m.direction === "INBOUND" && m.messageType !== "system").length;
    const customerEffort = Math.min(5, Math.max(1, Math.ceil(inboundCount / 2)));

    // Resolution outcome
    const resolutionOutcome = determineResolutionOutcome(messages);

    // Upsert ConversationIntelligence record
    await prisma.conversationIntelligence.upsert({
      where: { conversationId },
      create: {
        tenantId,
        conversationId,
        detectedIntent: intent,
        intentConfidence: 0.7,
        sentiment,
        sentimentScore,
        customerEffort,
        resolutionOutcome,
        analyzedAt: new Date(),
      },
      update: {
        detectedIntent: intent,
        intentConfidence: 0.7,
        sentiment,
        sentimentScore,
        customerEffort,
        resolutionOutcome,
        analyzedAt: new Date(),
      },
    });

    await analyticsQueue.add("conversation-analyzed", {
      tenantId,
      event: "conversation_analyzed",
      data: { conversationId, source: "heuristic", intent, sentiment, resolutionOutcome },
      timestamp: new Date().toISOString(),
    });

    console.log(`[intelligence] Heuristic analysis complete for ${conversationId}: intent=${intent} sentiment=${sentiment} outcome=${resolutionOutcome}`);
  } catch (err: any) {
    console.error(`[intelligence] Analysis failed for ${conversationId}:`, err.message);
  }
}

/**
 * Preferred name for new callers. Runs the same analysis pipeline as
 * `analyzeClosedConversation` but labels the trigger so log lines and
 * future AuditLog entries can distinguish close / handoff / manual
 * invocations.
 */
export async function analyzeConversation(
  tenantId: string,
  conversationId: string,
  trigger: "close" | "handoff" | "manual" | "reopen" = "close",
): Promise<void> {
  console.log(`[intelligence] analyzeConversation(${conversationId}) triggeredBy=${trigger}`);
  return analyzeClosedConversation(tenantId, conversationId);
}
