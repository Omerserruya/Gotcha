import OpenAI from "openai";
import type { AIProvider, ConversationContext, AISuggestion, IntentClassification } from "./ai-assist.service";
import { retrieveRelevantChunks, buildKnowledgeContext } from "./knowledge.service";

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private defaultModel: string;

  constructor(apiKey: string, baseURL?: string, defaultModel?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.defaultModel = defaultModel || "gpt-4o-mini";
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
    const temperature = config?.temperature ?? 0.7;
    const maxTokens = config?.maxTokens ?? 1024;

    try {
      const response = await this.client.chat.completions.create({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: chatMessages,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content;
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
      const response = await this.client.chat.completions.create({
        model,
        temperature: 0.3,
        max_tokens: 256,
        messages: [
          { role: "system", content: "Summarize this customer support conversation in 2-3 concise sentences. Focus on the customer's issue and current status." },
          { role: "user", content: messagesText },
        ],
      });
      return response.choices[0]?.message?.content || "Unable to generate summary.";
    } catch (err: any) {
      console.error("OpenAI summary error:", err.message);
      return "Failed to generate summary.";
    }
  }

  async classifyIntent(message: string): Promise<IntentClassification> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.defaultModel,
        temperature: 0,
        max_tokens: 128,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: 'Classify the customer message intent. Return JSON: { "intent": string, "confidence": number 0-1, "entities": [{ "type": string, "value": string }] }. Common intents: greeting, inquiry, complaint, cancellation, billing, technical_support, feedback, other.' },
          { role: "user", content: message },
        ],
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return { intent: "unknown", confidence: 0, entities: [] };
      return JSON.parse(content);
    } catch {
      return { intent: "unknown", confidence: 0, entities: [] };
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

  private getModeInstruction(copilotMode: "READY_MESSAGE" | "CONTEXT_ONLY"): string {
    if (copilotMode === "CONTEXT_ONLY") {
      return 'Analyze this conversation. Provide key points, sentiment, and suggested next actions. Do NOT draft replies.\n\nRespond with a JSON object containing a "suggestions" array. Each suggestion should have "text" (the analysis point), "confidence" (0-1), and "type" ("info"). Provide 2-4 insights.';
    }
    // READY_MESSAGE (default)
    return 'Based on this conversation, suggest 2-3 reply options the agent could send next.\n\nRespond with a JSON object containing a "suggestions" array. Each suggestion should have "text" (the suggested reply), "confidence" (0-1), and "type" ("reply", "action", or "info"). Provide 2-3 suggestions.';
  }

  private buildChatMessages(context: ConversationContext, systemPrompt: string): OpenAI.ChatCompletionMessageParam[] {
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

    // Build conversation transcript as a single user message with labels
    // This prevents OpenAI from confusing agent messages with its own prior responses
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

    // Mode-specific instruction as final user message
    const copilotMode = context.copilotConfig?.copilotMode || "READY_MESSAGE";
    messages.push({ role: "user", content: this.getModeInstruction(copilotMode) });

    return messages;
  }
}
