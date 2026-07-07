import { prisma } from "@chatcenter/shared";
import { ESCALATION_TOOL, AgentRecord } from "./prompt-builder.service";

export interface SentimentResult {
  /** positive | neutral | negative | mixed */
  sentiment: string;
  /** -1 (very negative) .. 1 (very positive) */
  score: number;
}

export interface AIProvider {
  suggestResponse(context: ConversationContext): Promise<AISuggestion[]>;
  summarize(context: ConversationContext): Promise<string>;
  classifyIntent(message: string): Promise<IntentClassification>;
  classifySentiment(text: string, locale?: string): Promise<SentimentResult>;
}

export interface ConversationContext {
  tenantId: string;
  conversationId: string;
  customerName?: string;
  messages: Array<{ direction: "INBOUND" | "OUTBOUND"; body: string; senderName?: string; createdAt: string }>;
  metadata?: Record<string, any>;
  copilotConfig?: CopilotConfigData | null;
  locale?: string;
  /**
   * Customer + conversation metadata for the copilot's "Customer &
   * Conversation Info" block. Sourced from the Conversation row by the
   * route handler - keep optional so non-inbox callers still work.
   * The provider treats every field as best-effort.
   */
  conversationMeta?: {
    channel?: string;
    status?: string;
    departmentName?: string;
    assignedAgentName?: string;
    isHandedOver?: boolean;
    createdAt?: string;
    lastMessageAt?: string;
    customerExternalId?: string;
    aiAgentId?: string;
  };
  /**
   * Cross-channel customer memory bundle, loaded by
   * customer-context.service.loadCustomerContext when CRM identity is
   * pinned for this conversation. Optional - when present, the provider
   * folds it into the prompt as a "what we remember about this customer"
   * block (open issues, recent summaries, sentiment trend, CRM notes).
   *
   * Wired by voice-assist + ai-bot turn paths on call-answer / bot-turn
   * so the AI has the same context the agent's side panel shows.
   */
  customerMemory?: {
    openIssues: Array<{ subject: string; status: string | null; priority: string | null; due_at: string | null }>;
    recentSummaries: Array<{ channel: string; summary: string; sentiment: string | null; qualification: string | null; occurredAt: string }>;
    recentCrmNotes: Array<{ body: string; occurred_at: string }>;
    sentimentTrend: ("positive" | "neutral" | "negative" | "unknown")[];
  };
  /**
   * Cancellation signal for the LLM calls inside the provider. Wired by
   * voice-assist.triggerAssist via the per-conversation turn registry so a
   * newer customer final aborts the still-pending copilot generation.
   */
  signal?: AbortSignal;
}

/**
 * Runtime config carried alongside the conversation. The full agent record
 * travels here so the provider can call `buildAgentPrompt` with it on every
 * turn (no precomputed prompt - the builder produces fresh output per turn
 * using the runtime context the provider has access to).
 */
export interface CopilotConfigData {
  agent: AgentRecord;
  tools: Array<{ id: string; name: string; enabled: boolean; config?: Record<string, any> }>;
  model: string;
  provider: string;
  temperature: number;
  maxTokens: number;
  isActive: boolean;
  copilotMode: "READY_MESSAGE" | "CONTEXT_ONLY" | "CHAT";
}

export interface AISuggestion {
  id: string;
  text: string;
  confidence: number;
  type: "reply" | "action" | "info" | "quick_action";
  /** One-line label of the tactic this suggestion takes (model-authored). */
  approach?: string;
  /** WHY this suggestion fits the plan/customer right now (model-authored). */
  rationale?: string;
  /**
   * Populated when type === "quick_action". Carries the tool name + args
   * the model proposed; the human agent in the inbox decides whether to
   * fire the action. Mirrors the proposeQuickAction side effect emitted
   * by the dispatcher in copilot mode.
   */
  quickAction?: {
    tool: string;
    args: Record<string, unknown>;
    reason: string;
  };
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
    return [{ id: "stub-1", text: "AI suggestions will appear here when a provider is configured.", confidence: 0, type: "info" }];
  }
  async summarize(_context: ConversationContext): Promise<string> { return "AI summarization not configured."; }
  async classifyIntent(_message: string): Promise<IntentClassification> { return { intent: "unknown", confidence: 0, entities: [] }; }
  async classifySentiment(_text: string): Promise<SentimentResult> { return { sentiment: "neutral", score: 0 }; }
}

let provider: AIProvider = new StubAIProvider();

export function setProvider(p: AIProvider): void { provider = p; }
export function getProvider(): AIProvider { return provider; }

// ─── Role-specific operating modes ──────────────────────────

export type AIEmployeeRole = "copilot" | "agent";

/**
 * Build a CopilotConfigData from a raw AIAgent row. The full agent record
 * is attached so the provider can call `buildAgentPrompt` with it at LLM
 * call time. No prompt string is precomputed here.
 */
export function buildConfigFromAIAgent(agent: {
  id?: string;
  name: string;
  role: string;
  description: string | null;
  tone: string;
  style: any;
  model: string;
  provider: string;
  temperature: number;
  maxTokens: number;
  identity: any;
  goals: any;
  toneConfig: any;
  behavioral: any;
  persona: any;
  conversationFlow?: any;
  customGuardrails?: any;
  escalationRules?: any;
  behavioralAnchors?: any;
  status: string;
}, role: AIEmployeeRole = "copilot"): CopilotConfigData {
  const tools: any[] = [];
  if (role === "agent") tools.push(ESCALATION_TOOL);

  const agentRecord: AgentRecord = {
    name: agent.name,
    role: agent.role,
    // description removed per spec - see prompt-builder AgentRecord.
    tone: agent.tone,
    style: agent.style,
    identity: agent.identity,
    goals: agent.goals,
    toneConfig: agent.toneConfig,
    behavioral: agent.behavioral,
    persona: agent.persona,
    conversationFlow: agent.conversationFlow,
    customGuardrails: agent.customGuardrails,
    escalationRules: agent.escalationRules,
    behavioralAnchors: agent.behavioralAnchors,
  };

  return {
    agent: agentRecord,
    tools,
    model: agent.model,
    provider: agent.provider,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    isActive: agent.status === "ACTIVE" || agent.status === "DRAFT",
    copilotMode: "READY_MESSAGE",
  };
}

// ─── Find AI employee for a department (via router rules) ───

async function findAIAgentForDepartment(tenantId: string, departmentId: string, role: AIEmployeeRole = "copilot"): Promise<CopilotConfigData | null> {
  const rule = await prisma.routerRule.findFirst({
    where: {
      tenantId,
      routeType: "AI_AGENT",
      aiAgentId: { not: null },
      enabled: true,
      routeTarget: departmentId,
    },
    orderBy: { position: "asc" } as any,
  });

  if (rule?.aiAgentId) {
    const agent = await prisma.aIAgent.findUnique({ where: { id: rule.aiAgentId } });
    if (agent) return buildConfigFromAIAgent(agent as any, role);
  }
  return null;
}

async function findDefaultAIAgent(tenantId: string, role: AIEmployeeRole = "copilot"): Promise<CopilotConfigData | null> {
  const defaultRule = await prisma.routerRule.findFirst({
    where: {
      tenantId,
      routeType: "AI_AGENT",
      aiAgentId: { not: null },
      enabled: true,
      isDefault: true,
    },
    orderBy: { position: "asc" } as any,
  });

  if (defaultRule?.aiAgentId) {
    const agent = await prisma.aIAgent.findUnique({ where: { id: defaultRule.aiAgentId } });
    if (agent) return buildConfigFromAIAgent(agent as any, role);
  }

  // Fall back to any active AI agent for this tenant
  const anyAgent = await prisma.aIAgent.findFirst({
    where: {
      tenantId,
      status: { in: ["ACTIVE", "DRAFT"] },
    },
    orderBy: { createdAt: "asc" },
  });

  if (anyAgent) return buildConfigFromAIAgent(anyAgent as any, role);

  return null;
}

// ─── Config resolution ──────────────────────────────────────

export async function getTenantCopilotConfig(tenantId: string, role: AIEmployeeRole = "copilot"): Promise<CopilotConfigData | null> {
  return findDefaultAIAgent(tenantId, role);
}

/**
 * Resolves AI config using a unified AI Employee entity.
 * The same AI Employee config is used for both copilot and agent roles.
 *
 * Priority:
 * 1. AI Employee assigned to the department (via router rules)
 * 2. Default AI Employee for the tenant (via default router rule or any active agent)
 */
export async function getEffectiveCopilotConfig(tenantId: string, departmentId?: string | null, role: AIEmployeeRole = "copilot"): Promise<CopilotConfigData | null> {
  if (departmentId) {
    const aiAgentConfig = await findAIAgentForDepartment(tenantId, departmentId, role);
    if (aiAgentConfig) return aiAgentConfig;
  }
  return getTenantCopilotConfig(tenantId, role);
}

/**
 * Get the raw AI Employee record assigned to a department (for display/assignment purposes).
 */
export async function getAIEmployeeForDepartment(tenantId: string, departmentId: string) {
  const rule = await prisma.routerRule.findFirst({
    where: {
      tenantId,
      routeType: "AI_AGENT",
      aiAgentId: { not: null },
      enabled: true,
      routeTarget: departmentId,
    },
    orderBy: { position: "asc" } as any,
  });

  if (rule?.aiAgentId) {
    return prisma.aIAgent.findUnique({
      where: { id: rule.aiAgentId },
      select: { id: true, name: true, role: true, status: true, avatarColor: true, persona: true },
    });
  }
  return null;
}

// ─── Provider delegation ────────────────────────────────────

export async function getSuggestions(context: ConversationContext): Promise<AISuggestion[]> { return provider.suggestResponse(context); }
export async function summarizeConversation(context: ConversationContext): Promise<string> { return provider.summarize(context); }
export async function classifyMessage(message: string): Promise<IntentClassification> { return provider.classifyIntent(message); }
export async function classifySentiment(text: string, locale?: string): Promise<SentimentResult> { return provider.classifySentiment(text, locale); }

export interface AgentChatParams extends ConversationContext {
  agentMessage: string;
  chatHistory: Array<{ role: "user" | "assistant"; content: string }>;
  customerData?: {
    externalId: string;
    name?: string;
    channel: string;
    status: string;
    department?: string;
    assignedAgent?: string;
    createdAt: string;
    lastMessageAt?: string;
    isHandedOver: boolean;
  };
}

export async function chatWithAgent(params: AgentChatParams): Promise<string> {
  if ("chatWithAgent" in provider && typeof (provider as any).chatWithAgent === "function") {
    return (provider as any).chatWithAgent(params);
  }
  return "AI Chat is not available. Please configure an AI provider.";
}

// Re-export for callers that previously imported from this module.
export { ESCALATION_TOOL };
