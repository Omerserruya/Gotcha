import { prisma } from "@chatcenter/shared";

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
  copilotConfig?: CopilotConfigData | null;
}

export interface CopilotConfigData {
  systemPrompt: string;
  rules: string[];
  tools: Array<{ id: string; name: string; enabled: boolean; config?: Record<string, any> }>;
  model: string;
  provider: string;
  temperature: number;
  maxTokens: number;
  isActive: boolean;
  copilotMode: "READY_MESSAGE" | "CONTEXT_ONLY";
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
  async suggestResponse(context: ConversationContext): Promise<AISuggestion[]> {
    const config = context.copilotConfig;
    if (config && !config.isActive) {
      return [{ id: "disabled", text: "Co-Pilot is disabled for this tenant.", confidence: 0, type: "info" }];
    }
    // When a real provider is configured, it will use config.systemPrompt, config.rules, config.tools, etc.
    return [{ id: "stub-1", text: "AI suggestions will appear here when a provider is configured.", confidence: 0, type: "info" }];
  }
  async summarize(_context: ConversationContext): Promise<string> { return "AI summarization not configured."; }
  async classifyIntent(_message: string): Promise<IntentClassification> { return { intent: "unknown", confidence: 0, entities: [] }; }
}

let provider: AIProvider = new StubAIProvider();

export function setProvider(p: AIProvider): void { provider = p; }
export function getProvider(): AIProvider { return provider; }

export async function getTenantCopilotConfig(tenantId: string): Promise<CopilotConfigData | null> {
  const config = await prisma.copilotConfig.findUnique({ where: { tenantId } });
  if (!config) return null;
  return {
    systemPrompt: config.systemPrompt,
    rules: config.rules as string[],
    tools: config.tools as CopilotConfigData["tools"],
    model: config.model,
    provider: config.provider,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    isActive: config.isActive,
    copilotMode: (config as any).copilotMode || "READY_MESSAGE",
  };
}

export async function getEffectiveCopilotConfig(tenantId: string, departmentId?: string | null): Promise<CopilotConfigData | null> {
  // Try department config first
  if (departmentId) {
    const deptConfig = await prisma.departmentCopilotConfig.findUnique({ where: { departmentId } });
    if (deptConfig) {
      return {
        systemPrompt: deptConfig.systemPrompt,
        rules: deptConfig.rules as string[],
        tools: deptConfig.tools as CopilotConfigData["tools"],
        model: deptConfig.model,
        provider: deptConfig.provider,
        temperature: deptConfig.temperature,
        maxTokens: deptConfig.maxTokens,
        isActive: deptConfig.isActive,
        copilotMode: deptConfig.copilotMode as "READY_MESSAGE" | "CONTEXT_ONLY",
      };
    }
  }
  // Fall back to tenant config
  return getTenantCopilotConfig(tenantId);
}

export async function getSuggestions(context: ConversationContext): Promise<AISuggestion[]> { return provider.suggestResponse(context); }
export async function summarizeConversation(context: ConversationContext): Promise<string> { return provider.summarize(context); }
export async function classifyMessage(message: string): Promise<IntentClassification> { return provider.classifyIntent(message); }
