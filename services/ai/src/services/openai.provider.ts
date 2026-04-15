/**
 * OpenAI Provider — refactored to use central aiService for ALL LLM calls.
 * No direct OpenAI SDK usage here anymore.
 */

import type { AIProvider, ConversationContext, AISuggestion, IntentClassification, AgentChatParams } from "./ai-assist.service";
import { retrieveRelevantChunks, buildKnowledgeContext } from "./knowledge.service";
import { generateResponse, getDefaultModel } from "./ai.service";
import { prisma, buildAgentTools, dispatchToolCall } from "@chatcenter/shared";
import type { AgentToolContext } from "@chatcenter/shared";

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

    let systemPrompt = this.buildSystemPrompt(config);

    // RAG: Retrieve relevant knowledge base context
    if (context.tenantId) {
      const lastInbound = [...context.messages].reverse().find((m) => m.direction === "INBOUND");
      if (lastInbound?.body) {
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

    try {
      const result = await generateResponse({
        tenantId: context.tenantId || "",
        model,
        messages: chatMessages,
        temperature: config?.temperature ?? 0.7,
        maxTokens: config?.maxTokens ?? 1024,
        responseFormat: { type: "json_object" },
        metadata: {
          type: "suggestion",
          conversationId: context.conversationId,
        },
      });

      const content = result.content;
      if (!content) return [{ id: "empty", text: "No suggestions available.", confidence: 0, type: "info" }];

      const parsed = JSON.parse(content);
      const suggestions: AISuggestion[] = (parsed.suggestions || []).map((s: any, i: number) => ({
        id: `openai-${i}`,
        text: s.text || s,
        confidence: s.confidence ?? 0.8,
        type: (s.type as AISuggestion["type"]) || "reply",
      }));

      return suggestions.length > 0 ? suggestions : [{ id: "no-match", text: "No relevant suggestions for this context.", confidence: 0, type: "info" }];
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
          { role: "system", content: "Summarize this customer support conversation in 2-3 concise sentences. Focus on the customer's issue and current status." },
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
    const systemPrompt = this.buildSystemPrompt(config);
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
      messages.push({ role: "user", content: `## Conversation Transcript\n${transcript}` });
      messages.push({ role: "assistant", content: "I've reviewed the conversation. How can I help you?" });
    }

    // Add KB context if available
    try {
      const lastCustomerMsg = [...params.messages].reverse().find((m) => m.direction === "INBOUND");
      const query = params.agentMessage || lastCustomerMsg?.body || "";
      if (query) {
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

  private buildSystemPrompt(config?: ConversationContext["copilotConfig"] | null): string {
    let prompt = config?.systemPrompt || "You are a helpful customer support co-pilot. Suggest professional, empathetic replies for the agent to send to the customer.";

    if (config?.rules && Array.isArray(config.rules) && config.rules.length > 0) {
      prompt += "\n\nRules you must follow:\n" + config.rules.map((r) => `- ${r}`).join("\n");
    }

    prompt += "\n\n## Truthfulness & Knowledge Base Rules\n- When knowledge base context is provided, base your suggestions on that information.\n- NEVER suggest responses that fabricate information not present in the knowledge base or conversation context.\n- If there is insufficient information to answer, suggest the agent tell the customer they will look into it.\n- Accuracy is more important than sounding helpful — do not invent details.";

    return prompt;
  }

  private getModeInstruction(copilotMode: "READY_MESSAGE" | "CONTEXT_ONLY" | "CHAT"): string {
    if (copilotMode === "CONTEXT_ONLY") {
      return 'Analyze this conversation. Provide key points, sentiment, and suggested next actions. Do NOT draft replies.\n\nRespond with a JSON object containing a "suggestions" array. Each suggestion should have "text" (the analysis point), "confidence" (0-1), and "type" ("info"). Provide 2-4 insights.';
    }
    if (copilotMode === "CHAT") {
      return 'You are an AI assistant for the agent. The agent can ask you anything about this conversation, the customer, or for help drafting responses. Use the knowledge base and available tools to provide accurate, helpful answers. Respond naturally in plain text — do NOT use JSON format. Be concise and actionable.';
    }
    // READY_MESSAGE (default)
    return 'Based on this conversation, suggest 2-3 reply options the agent could send next.\n\nRespond with a JSON object containing a "suggestions" array. Each suggestion should have "text" (the suggested reply), "confidence" (0-1), and "type" ("reply", "action", or "info"). Provide 2-3 suggestions.';
  }

  private buildChatMessages(context: ConversationContext, systemPrompt: string): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "system", content: systemPrompt }];

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
