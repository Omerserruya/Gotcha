import OpenAI from "openai";
import type { AIProvider, ConversationContext, AISuggestion, IntentClassification } from "./ai-assist.service";

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

    const systemPrompt = this.buildSystemPrompt(config);
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

    prompt += '\n\nRespond with a JSON object containing a "suggestions" array. Each suggestion should have "text" (the suggested reply), "confidence" (0-1), and "type" ("reply", "action", or "info"). Provide 2-3 suggestions.';

    return prompt;
  }

  private buildChatMessages(context: ConversationContext, systemPrompt: string): OpenAI.ChatCompletionMessageParam[] {
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

    // Add conversation history
    for (const msg of context.messages) {
      if (!msg.body?.trim()) continue;
      if (msg.direction === "INBOUND") {
        messages.push({ role: "user", content: `[Customer${context.customerName ? ` - ${context.customerName}` : ""}]: ${msg.body}` });
      } else {
        messages.push({ role: "assistant", content: `[Agent${msg.senderName ? ` - ${msg.senderName}` : ""}]: ${msg.body}` });
      }
    }

    // Final instruction
    messages.push({ role: "user", content: "Based on this conversation, suggest 2-3 reply options the agent could send next." });

    return messages;
  }
}
