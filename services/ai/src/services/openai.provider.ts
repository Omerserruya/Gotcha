/**
 * OpenAI Provider — refactored to use central aiService for ALL LLM calls.
 * No direct OpenAI SDK usage here anymore.
 */

import type { AIProvider, ConversationContext, AISuggestion, IntentClassification, AgentChatParams } from "./ai-assist.service";
import { retrieveRelevantChunks, buildKnowledgeContext } from "./knowledge.service";
import { generateResponse, getDefaultModel } from "./ai.service";
import { prisma, buildAgentTools, buildAgentToolsForAIAgent, dispatchToolCall } from "@chatcenter/shared";
import type { AgentToolContext } from "@chatcenter/shared";

// Terminator tool: instead of forcing JSON output via responseFormat, we
// tell the model to "finish" by calling this. That keeps regular
// tool-calling alive (read-only context tools, HITL quick-action proposals)
// while still getting a structured suggestions payload back.
const SUBMIT_SUGGESTIONS_TOOL = {
  type: "function" as const,
  function: {
    name: "submit_suggestions",
    description:
      "Call this to FINISH and return your final suggestions to the human agent. " +
      "Call it exactly once, after you've used any read-only tools you need. " +
      "Do NOT call it before you have what you need — call read-only tools first if they would help.",
    parameters: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          description:
            "2–3 suggestions. Each is one of: a reply draft (type=reply), an analysis insight (type=info), a recommended action description (type=action). Quick-action proposals are added separately by the dispatcher — do not include them here.",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The suggestion text. For replies, write it exactly as the customer should receive it, in the customer's language." },
              confidence: { type: "number", description: "0–1. Your confidence in this suggestion." },
              type: {
                type: "string",
                enum: ["reply", "action", "info"],
                description: "What kind of suggestion this is.",
              },
            },
            required: ["text", "confidence", "type"],
          },
        },
      },
      required: ["suggestions"],
    },
  },
};

/** Map locale code to language name for prompt injection */
const LOCALE_LANGUAGE: Record<string, string> = {
  he: "Hebrew",
  ar: "Arabic",
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  ru: "Russian",
  zh: "Chinese",
  ja: "Japanese",
};

function getLanguageInstruction(locale?: string): string {
  if (!locale) return "";
  const lang = LOCALE_LANGUAGE[locale];
  if (!lang || lang === "English") return "";
  return `\n\n## Language Requirement\nYou MUST respond in ${lang}. All suggestions, summaries, analysis, and responses must be written in ${lang}. This is a strict requirement.`;
}

/**
 * Quick heuristic: does this message look like it would benefit from a KB lookup?
 * Skip KB for greetings, thank-yous, confirmations, very short non-question
 * messages, and "data fragments" the customer typed in response to an
 * earlier ask (a bare email, phone, or order number — those carry no
 * semantic signal for the vector store).
 *
 * Exported so the autonomous bot path (services/ai-bot.service.ts) and
 * the copilot path can share the same gate. Cheap pure function — safe
 * to call on every turn.
 */
export function shouldSearchKB(text: string): boolean {
  if (!text || text.trim().length < 8) return false;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  // Pure email or pure phone — nothing to retrieve from KB; the customer
  // is just providing identifying info in response to an earlier ask.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return false;
  if (/^\+?\d[\d\s().-]{5,}$/.test(trimmed)) return false;
  // Common patterns that don't need KB
  const skipPatterns = [
    /^(hi|hello|hey|shalom|שלום|היי|מה קורה|בוקר טוב|ערב טוב|לילה טוב)\b/,
    /^(thanks?|thank you|thx|ty|תודה|מעולה|סבבה|אחלה)\b/,
    /^(ok|okay|sure|yes|no|yep|nope|בסדר|כן|לא|אוקי|נכון)\b/,
    /^(bye|goodbye|see you|להתראות|ביי)\b/,
    /^(good morning|good evening|good night)\b/,
    /^👍|^❤️|^🙏|^😊|^👋/,
  ];
  for (const pattern of skipPatterns) {
    if (pattern.test(lower)) return false;
  }
  return true;
}

export class OpenAIProvider implements AIProvider {
  private defaultModel: string;

  constructor(_apiKey: string, _baseURL?: string, defaultModel?: string) {
    // API key and baseURL are now managed by aiService.initAIService()
    this.defaultModel = defaultModel || getDefaultModel();
  }

  async suggestResponse(context: ConversationContext): Promise<AISuggestion[]> {
    const config = context.copilotConfig;
    if (config && !config.isActive) {
      return [{ id: "disabled", text: "Co-Pilot is disabled for this tenant.", confidence: 0, type: "info" }];
    }

    let systemPrompt = this.buildSystemPrompt(config, context.locale);

    // RAG: Retrieve relevant knowledge base context (only when the message warrants it)
    if (context.tenantId) {
      const lastInbound = [...context.messages].reverse().find((m) => m.direction === "INBOUND");
      if (lastInbound?.body && shouldSearchKB(lastInbound.body)) {
        try {
          const chunks = await retrieveRelevantChunks(context.tenantId, lastInbound.body, 5);
          const kbContext = buildKnowledgeContext(chunks);
          if (kbContext) systemPrompt += "\n\n" + kbContext;
        } catch (err: any) {
          console.warn("[RAG] Knowledge retrieval failed:", err.message);
        }
      }
    }

    const chatMessages = this.buildChatMessages(context, systemPrompt);
    const model = config?.model || this.defaultModel;

    // Resolve contactId so link_customer_identifier (and any HITL gate
    // that fires) has the right target.
    let contactId: string | undefined;
    if (context.tenantId && context.conversationMeta?.customerExternalId && context.conversationMeta?.channel) {
      try {
        const contact = await prisma.contact.findFirst({
          where: {
            tenantId: context.tenantId,
            channel: context.conversationMeta.channel as any,
            externalId: context.conversationMeta.customerExternalId,
          },
          select: { id: true },
        });
        contactId = contact?.id;
      } catch { /* best-effort */ }
    }
    const toolCtx: AgentToolContext = {
      tenantId: context.tenantId || "",
      conversationId: context.conversationId,
      contactId,
      authToken: process.env.INTERNAL_SERVICE_TOKEN,
      mode: "copilot",
    };

    // Tool surface for copilot:
    //   - submit_suggestions terminator (always)
    //   - link_customer_identifier — copilot still needs to detect when
    //     a customer shares their email/phone in chat and attach it to
    //     their record. Only included when we have a contact to target.
    //   - integration tools the agent has permission for, filtered to
    //     those with allowedModes containing "ASSIST"
    // escalate_to_human is excluded — copilot doesn't escalate; the
    // human agent is already in the loop.
    const aiAgentId = context.conversationMeta?.aiAgentId;
    let tools: any[] = [SUBMIT_SUGGESTIONS_TOOL];
    if (aiAgentId && context.tenantId) {
      try {
        const surface = await buildAgentToolsForAIAgent(context.tenantId, aiAgentId, {
          identityLinking: !!contactId,
          escalation: false,
          allowedMode: "ASSIST",
        });
        tools = [SUBMIT_SUGGESTIONS_TOOL, ...surface];
      } catch (err: any) {
        console.warn("[copilot] Integration tool load failed:", err?.message);
      }
    }

    const quickActions: AISuggestion[] = [];
    let finalSuggestions: AISuggestion[] = [];

    try {
      // Tool loop, capped at 4 rounds. Read-only tools execute and feed
      // back; HITL tools are diverted into quickActions; submit_suggestions
      // terminates the loop.
      for (let round = 0; round < 4; round++) {
        const result = await generateResponse({
          tenantId: context.tenantId || "",
          model,
          messages: chatMessages,
          temperature: config?.temperature ?? 0.7,
          maxTokens: config?.maxTokens ?? 1024,
          metadata: { type: "suggestion", conversationId: context.conversationId },
          tools,
        });

        const toolCalls = result.toolCalls;
        if (!toolCalls || toolCalls.length === 0) {
          // Model finished without calling submit_suggestions — fall back
          // to whatever plain text we got, surfaced as a single info card.
          if (result.content?.trim()) {
            finalSuggestions = [{ id: "openai-text", text: result.content.trim(), confidence: 0.5, type: "info" }];
          }
          break;
        }

        chatMessages.push({
          role: "assistant",
          content: result.content || "",
          tool_calls: toolCalls,
        } as any);

        let terminated = false;
        for (const tc of toolCalls) {
          const toolName = tc.function?.name || "";
          if (toolName === "submit_suggestions") {
            try {
              const parsed = JSON.parse(tc.function?.arguments || "{}");
              const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
              finalSuggestions = list.map((s: any, i: number) => ({
                id: `openai-${i}`,
                text: typeof s === "string" ? s : (s.text || ""),
                confidence: typeof s === "object" ? (s.confidence ?? 0.8) : 0.8,
                type: (typeof s === "object" ? s.type : "reply") as AISuggestion["type"],
              })).filter((s: AISuggestion) => s.text);
            } catch (err: any) {
              console.warn("[copilot] submit_suggestions JSON parse failed:", err.message);
            }
            chatMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ ok: true }),
            } as any);
            terminated = true;
            continue;
          }

          // Read-only or HITL tool — dispatch normally; copilot mode in
          // the ctx makes the dispatcher divert REQUIRE_APPROVAL into
          // proposeQuickAction.
          const res = await dispatchToolCall(
            { id: tc.id, function: { name: toolName, arguments: tc.function?.arguments || "{}" } },
            toolCtx,
          );
          if (res.sideEffect?.proposeQuickAction) {
            const qa = res.sideEffect.proposeQuickAction;
            quickActions.push({
              id: `quick-${quickActions.length}`,
              text: humanizeQuickAction(qa.tool, qa.args),
              confidence: 0.9,
              type: "quick_action",
              quickAction: qa,
            });
          }
          chatMessages.push({
            role: "tool",
            tool_call_id: res.toolCallId,
            content: res.content,
          } as any);
        }

        if (terminated) break;
      }

      const out = [...finalSuggestions, ...quickActions];
      if (out.length === 0) {
        return [{ id: "no-match", text: "No relevant suggestions for this context.", confidence: 0, type: "info" }];
      }
      return out;
    } catch (err: any) {
      console.error("OpenAI suggestion error:", err.message);
      return [{ id: "error", text: "Failed to get AI suggestions. Check API key and model configuration.", confidence: 0, type: "info" }];
    }
  }

  async summarize(context: ConversationContext): Promise<string> {
    const config = context.copilotConfig;
    if (config && !config.isActive) return "Co-Pilot is disabled.";

    const model = config?.model || this.defaultModel;
    const messagesText = context.messages
      .filter((m) => m.body?.trim())
      .map((m) => `${m.direction === "INBOUND" ? "Customer" : (m.senderName || "Agent")}: ${m.body}`)
      .join("\n");

    if (!messagesText) return "No messages to summarize.";

    try {
      const result = await generateResponse({
        tenantId: context.tenantId || "",
        model,
        messages: [
          { role: "system", content: "Summarize this customer conversation concisely as bullet points (2-4 key points). Structure:\n• **Why they contacted**: the customer's original reason/intent from their first message\n• **What they need now**: what the customer is asking for or waiting on right now (from their latest message)\n• **Status**: where things stand (resolved, pending, escalated, etc.)\n• **Next step**: what the agent should do next\nBe brief — one line per point." + getLanguageInstruction(context.locale) },
          { role: "user", content: messagesText },
        ],
        temperature: 0.3,
        maxTokens: 256,
        metadata: {
          type: "summary",
          conversationId: context.conversationId,
        },
      });

      return result.content || "Unable to generate summary.";
    } catch (err: any) {
      console.error("OpenAI summary error:", err.message);
      return "Failed to generate summary.";
    }
  }

  async classifyIntent(message: string): Promise<IntentClassification> {
    try {
      const result = await generateResponse({
        tenantId: "", // intent classification may not have tenant context
        model: this.defaultModel,
        messages: [
          { role: "system", content: 'Classify the customer message intent. Return JSON: { "intent": string, "confidence": number 0-1, "entities": [{ "type": string, "value": string }] }. Common intents: greeting, inquiry, complaint, cancellation, billing, technical_support, feedback, other.' },
          { role: "user", content: message },
        ],
        temperature: 0,
        maxTokens: 128,
        responseFormat: { type: "json_object" },
        metadata: { type: "classification" },
      });

      const content = result.content;
      if (!content) return { intent: "unknown", confidence: 0, entities: [] };
      return JSON.parse(content);
    } catch {
      return { intent: "unknown", confidence: 0, entities: [] };
    }
  }

  async chatWithAgent(params: AgentChatParams): Promise<string> {
    const config = params.copilotConfig;
    if (config && !config.isActive) return "Co-Pilot is disabled.";

    const model = config?.model || this.defaultModel;
    const systemPrompt = this.buildSystemPrompt(config, params.locale);
    const chatMode = this.getModeInstruction("CHAT");

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt + "\n\n" + chatMode },
    ];

    // Add conversation transcript as context
    const transcript = params.messages
      .filter((m) => m.body?.trim())
      .map((m) => {
        if (m.direction === "INBOUND") {
          return `[Customer${params.customerName ? ` - ${params.customerName}` : ""}]: ${m.body}`;
        }
        return `[Agent${m.senderName ? ` - ${m.senderName}` : ""}]: ${m.body}`;
      })
      .join("\n");

    // Add customer data context
    if (params.customerData) {
      const cd = params.customerData;
      const customerBlock = [
        `- Name: ${cd.name || "Unknown"}`,
        `- External ID / Phone: ${cd.externalId}`,
        `- Channel: ${cd.channel}`,
        `- Conversation Status: ${cd.status}`,
        cd.department && `- Department: ${cd.department}`,
        cd.assignedAgent && `- Assigned Agent: ${cd.assignedAgent}`,
        `- Conversation Started: ${cd.createdAt}`,
        cd.lastMessageAt && `- Last Message: ${cd.lastMessageAt}`,
        `- Handed Over to Human: ${cd.isHandedOver ? "Yes" : "No"}`,
      ].filter(Boolean).join("\n");
      messages.push({ role: "user", content: `## Customer & Conversation Info\n${customerBlock}` });
      messages.push({ role: "assistant", content: "Noted. I have the customer and conversation details." });
    }

    if (transcript) {
      messages.push({ role: "user", content: `## Live Conversation Transcript (between customer and agent)\n${transcript}` });
      messages.push({ role: "assistant", content: "I've reviewed the conversation. How can I help you, agent?" });
    }

    // Add KB context only when the query warrants it (skip greetings, small talk, etc.)
    try {
      const lastCustomerMsg = [...params.messages].reverse().find((m) => m.direction === "INBOUND");
      const query = params.agentMessage || lastCustomerMsg?.body || "";
      if (query && shouldSearchKB(query)) {
        const chunks = await retrieveRelevantChunks(params.tenantId, query, 5);
        if (chunks.length > 0) {
          const kbContext = buildKnowledgeContext(chunks);
          messages.push({ role: "user", content: `## Knowledge Base\n${kbContext}` });
          messages.push({ role: "assistant", content: "I've reviewed the knowledge base context. What would you like to know?" });
        }
      }
    } catch { /* KB not available, continue without */ }

    // Add agent chat history
    for (const msg of params.chatHistory) {
      messages.push({ role: msg.role === "user" ? "user" : "assistant", content: msg.content });
    }

    // Add current agent message
    messages.push({ role: "user", content: params.agentMessage });

    // Resolve contactId so link_customer_identifier can target the right row.
    let contactId: string | undefined;
    if (params.tenantId && params.customerData?.externalId && params.customerData?.channel) {
      const contact = await prisma.contact.findFirst({
        where: {
          tenantId: params.tenantId,
          channel: params.customerData.channel as any,
          externalId: params.customerData.externalId,
        },
        select: { id: true },
      });
      contactId = contact?.id;
    }
    const toolCtx: AgentToolContext = {
      tenantId: params.tenantId || "",
      conversationId: params.conversationId,
      contactId,
      authToken: process.env.INTERNAL_SERVICE_TOKEN,
    };
    const tools = buildAgentTools({ identityLinking: !!contactId, escalation: true });

    try {
      // Tool-calling loop, capped at 3 rounds. The assist path will rarely
      // need more than one round — the agent asks a question, the model
      // maybe calls a tool, then produces final text.
      for (let round = 0; round < 3; round++) {
        const result = await generateResponse({
          tenantId: params.tenantId || "",
          model,
          messages,
          temperature: config?.temperature ?? 0.7,
          maxTokens: config?.maxTokens ?? 1024,
          metadata: { type: "chat", conversationId: params.conversationId },
          tools,
        });

        const toolCalls = result.toolCalls;
        if (!toolCalls || toolCalls.length === 0) {
          return result.content || "I couldn't generate a response. Please try again.";
        }

        messages.push({
          role: "assistant",
          content: result.content || "",
          tool_calls: toolCalls,
        } as any);

        for (const tc of toolCalls) {
          const res = await dispatchToolCall(
            { id: tc.id, function: { name: tc.function.name, arguments: tc.function.arguments } },
            toolCtx,
          );
          messages.push({
            role: "tool",
            tool_call_id: res.toolCallId,
            content: res.content,
          } as any);
        }
      }
      return "I couldn't finalize a response after using tools. Please try again.";
    } catch (err: any) {
      console.error("OpenAI agent chat error:", err.message);
      return "Failed to get AI response. Please check API configuration.";
    }
  }

  private buildSystemPrompt(config?: ConversationContext["copilotConfig"] | null, locale?: string): string {
    let prompt = config?.systemPrompt || "You are a helpful customer support co-pilot. Suggest professional, empathetic replies for the agent to send to the customer.";

    if (config?.rules && Array.isArray(config.rules) && config.rules.length > 0) {
      prompt += "\n\nRules you must follow:\n" + config.rules.map((r) => `- ${r}`).join("\n");
    }

    prompt += "\n\n## Truthfulness & Knowledge Base Rules\n- When knowledge base context is provided, base your suggestions on that information.\n- NEVER suggest responses that fabricate information not present in the knowledge base or conversation context.\n- If there is insufficient information to answer, suggest the agent tell the customer they will look into it.\n- Accuracy is more important than sounding helpful — do not invent details.";

    prompt += getLanguageInstruction(locale);

    return prompt;
  }

  private getModeInstruction(copilotMode: "READY_MESSAGE" | "CONTEXT_ONLY" | "CHAT"): string {
    return getModeInstruction(copilotMode);
  }

  private buildChatMessages(context: ConversationContext, systemPrompt: string): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "system", content: systemPrompt }];

    // Customer & Conversation Info — sourced by the route handler. Only
    // emitted when we actually have something to put in it.
    const meta = context.conversationMeta;
    if (meta || context.customerName) {
      const lines: string[] = [];
      lines.push(`- Customer: ${context.customerName || "Unknown"}`);
      if (meta?.customerExternalId) lines.push(`- External ID / Phone: ${meta.customerExternalId}`);
      if (meta?.channel) lines.push(`- Channel: ${meta.channel}`);
      if (meta?.status) lines.push(`- Conversation Status: ${meta.status}`);
      if (meta?.departmentName) lines.push(`- Department: ${meta.departmentName}`);
      if (meta?.assignedAgentName) lines.push(`- Assigned Agent: ${meta.assignedAgentName}`);
      if (meta?.createdAt) lines.push(`- Conversation Started: ${meta.createdAt}`);
      if (meta?.lastMessageAt) lines.push(`- Last Message: ${meta.lastMessageAt}`);
      if (meta?.isHandedOver !== undefined) lines.push(`- Handed Over to Human: ${meta.isHandedOver ? "Yes" : "No"}`);
      messages.push({ role: "user", content: `## Customer & Conversation Info\n${lines.join("\n")}` });
    }

    const transcript = context.messages
      .filter((msg) => msg.body?.trim())
      .map((msg) => {
        if (msg.direction === "INBOUND") {
          return `[Customer${context.customerName ? ` - ${context.customerName}` : ""}]: ${msg.body}`;
        }
        return `[Agent${msg.senderName ? ` - ${msg.senderName}` : ""}]: ${msg.body}`;
      })
      .join("\n");

    if (transcript) {
      messages.push({ role: "user", content: `## Conversation Transcript\n${transcript}` });
    }

    const copilotMode = context.copilotConfig?.copilotMode || "READY_MESSAGE";
    messages.push({ role: "user", content: this.getModeInstruction(copilotMode) });

    return messages;
  }
}

export function getModeInstruction(copilotMode: "READY_MESSAGE" | "CONTEXT_ONLY" | "CHAT"): string {
  if (copilotMode === "CONTEXT_ONLY") {
    return `You are reading a live conversation between a customer and a human agent and producing context cards for the agent.

Use every block above:
- Customer & Conversation Info — for status, channel, assignment, timing
- Conversation Transcript — for what was actually said and the latest customer message
- Knowledge Base (if present) — for facts; do NOT invent any not present here

Produce 2–4 short insights covering, in order: original reason for contact, what they need NOW (latest message), sentiment, recommended next step. Each insight is one sentence. Do NOT draft replies.

Call the \`submit_suggestions\` tool to deliver them.`;
  }
  if (copilotMode === "CHAT") {
    return `You are an AI Co-Pilot. You are talking to the HUMAN AGENT, not the customer. The agent is handling the conversation shown in the blocks above.

Sources of truth (in this order):
1. Customer & Conversation Info — customer, channel, status, assignment, timing
2. Conversation Transcript — what was actually said
3. Knowledge Base (if present) — facts; never fabricate beyond it
4. Tools — call them when they can answer the agent's question (lookup customer history, fetch lead, etc.) instead of guessing. Do not mention tool names to the agent unless asked.

What the agent can ask you for:
- Answer questions about the customer, conversation, or policy
- Draft a message they can send to the customer (write it as the customer should receive it, in the customer's language)
- Suggest the next action — including proposing a tool call when a write/HITL action is the right next step
- Summarize sentiment, intent, or risk

Respond in plain text — no JSON. Be concise and actionable. Reply in the same language the agent uses to talk to you.`;
  }
  // READY_MESSAGE (default)
  return `You are drafting reply options the agent could send next to the customer.

Use every block above:
- Customer & Conversation Info — for tone, status, and assignment
- Conversation Transcript — for what was already said and the customer's latest message
- Knowledge Base (if present) — for facts; never fabricate beyond it

Produce 2–3 short reply options that address the customer's CURRENT need (their latest message), informed by their original reason for contacting. Each reply is 1–3 sentences, ready to send as-is, written in the customer's language and in the tone of the existing transcript.

Call the \`submit_suggestions\` tool to deliver them.`;
}

/**
 * Render a one-line, human-friendly description of a proposed quick action
 * for the suggestions panel. Falls back to "<tool>(args)" when we can't
 * make sense of the args. The agent UI can prettify further; this is the
 * default label.
 */
function humanizeQuickAction(toolName: string, args: Record<string, unknown>): string {
  const slug = toolName.startsWith("integration_") ? toolName.slice("integration_".length) : toolName;
  const verb = slug.replace(/_/g, " ");
  const preview = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return preview ? `${verb} — ${preview}` : verb;
}
