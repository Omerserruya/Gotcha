export interface AIProvider {
  suggestResponse(context: ConversationContext): Promise<AISuggestion[]>;
  summarize(context: ConversationContext): Promise<string>;
  classifyIntent(message: string): Promise<IntentClassification>;
}

export interface ConversationContext {
  tenantId: string;
  conversationId: string;
  customerName?: string;
  messages: Array<{ direction: "INBOUND" | "OUTBOUND"; body: string; senderName?: string; createdAt: string }>;
  metadata?: Record<string, any>;
}

export interface AISuggestion {
  id: string;
  text: string;
  confidence: number;
  type: "reply" | "action" | "info";
}

export interface IntentClassification {
  intent: string;
  confidence: number;
  entities: Array<{ type: string; value: string }>;
}

class StubAIProvider implements AIProvider {
  async suggestResponse(_context: ConversationContext): Promise<AISuggestion[]> {
    return [{ id: "stub-1", text: "AI suggestions will appear here when a provider is configured.", confidence: 0, type: "info" }];
  }
  async summarize(_context: ConversationContext): Promise<string> { return "AI summarization not configured."; }
  async classifyIntent(_message: string): Promise<IntentClassification> { return { intent: "unknown", confidence: 0, entities: [] }; }
}

let provider: AIProvider = new StubAIProvider();

export function setProvider(p: AIProvider): void { provider = p; }
export function getProvider(): AIProvider { return provider; }

export async function getSuggestions(context: ConversationContext): Promise<AISuggestion[]> { return provider.suggestResponse(context); }
export async function summarizeConversation(context: ConversationContext): Promise<string> { return provider.summarize(context); }
export async function classifyMessage(message: string): Promise<IntentClassification> { return provider.classifyIntent(message); }
