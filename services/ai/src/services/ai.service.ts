/**
 * Central AI Service - ALL LLM calls MUST go through this service.
 *
 * Responsibilities:
 * - Single gateway for all LLM API calls (chat completions, embeddings)
 * - Extracts and returns token usage from every call
 * - Automatically tracks usage via usageService
 * - Automatically logs audit events via auditService
 */

import OpenAI from "openai";
import { trackAIUsage } from "@chatcenter/shared";
import { logAudit } from "./audit.service";

// ─── Types ──────────────────────────────────────────────────

export interface AIRequestParams {
  tenantId: string;
  model?: string;
  // Loosened to `any[]` so callers can pass tool/tool-call roles (OpenAI's
  // ChatCompletionMessageParam is a union that includes those variants).
  messages: any[];
  metadata?: {
    conversationId?: string;
    aiAgentId?: string;
    type?: string; // "suggestion" | "chat" | "summary" | "classification" | "onboarding"
    [key: string]: any;
  };
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" | "text" };
  /** OpenAI function-calling tool schemas. Passed through untouched. */
  tools?: any[];
  toolChoice?: any;
}

export interface AIResponse {
  content: string;
  /** Raw tool_calls from the assistant message if the model emitted any. */
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export interface EmbeddingRequestParams {
  tenantId: string;
  input: string;
  model?: string;
  metadata?: {
    documentId?: string;
    [key: string]: any;
  };
}

export interface EmbeddingResponse {
  embedding: number[];
  usage: {
    input_tokens: number;
    total_tokens: number;
  };
}

// ─── Singleton Client ───────────────────────────────────────

let openaiClient: OpenAI | null = null;
let defaultModel = "gpt-4o-mini";
let defaultEmbeddingModel = "text-embedding-3-small";

export function initAIService(config: {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
  defaultEmbeddingModel?: string;
}) {
  openaiClient = new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });
  if (config.defaultModel) defaultModel = config.defaultModel;
  if (config.defaultEmbeddingModel) defaultEmbeddingModel = config.defaultEmbeddingModel;
  console.log("[aiService] Initialized (model: %s, embedding: %s)", defaultModel, defaultEmbeddingModel);
}

function getClient(): OpenAI {
  if (!openaiClient) {
    throw new Error("[aiService] Not initialized. Call initAIService() first.");
  }
  return openaiClient;
}

// ─── Core: Generate Response ────────────────────────────────

export async function generateResponse(params: AIRequestParams): Promise<AIResponse> {
  const client = getClient();
  const model = params.model || defaultModel;
  const type = params.metadata?.type || "chat";

  const requestParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages: params.messages,
    temperature: params.temperature ?? 0.7,
    max_tokens: params.maxTokens ?? 1024,
  };

  if (params.responseFormat) {
    requestParams.response_format = params.responseFormat;
  }
  if (params.tools && params.tools.length > 0) {
    (requestParams as any).tools = params.tools;
    if (params.toolChoice) (requestParams as any).tool_choice = params.toolChoice;
  }

  const response = await client.chat.completions.create(requestParams);

  const usage = {
    input_tokens: response.usage?.prompt_tokens ?? 0,
    output_tokens: response.usage?.completion_tokens ?? 0,
    total_tokens: response.usage?.total_tokens ?? 0,
  };

  const content = response.choices[0]?.message?.content || "";
  const rawToolCalls = (response.choices[0]?.message as any)?.tool_calls as any[] | undefined;

  // Track usage (fire-and-forget, never block the response)
  trackAIUsage({
    tenantId: params.tenantId,
    feature: type,
    model,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    metadata: {
      conversationId: params.metadata?.conversationId,
      aiAgentId: params.metadata?.aiAgentId,
    },
  }).catch((err) => console.error("[aiService] Usage tracking failed:", err.message));

  // Audit log (fire-and-forget)
  logAudit({
    tenantId: params.tenantId,
    actor: {
      type: "ai",
      id: params.metadata?.aiAgentId,
    },
    action: "ai.responded",
    target: params.metadata?.conversationId
      ? { type: "conversation", id: params.metadata.conversationId }
      : undefined,
    metadata: {
      model,
      type,
      tokens: usage,
    },
  }).catch((err) => console.error("[aiService] Audit logging failed:", err.message));

  return {
    content,
    toolCalls: rawToolCalls as AIResponse["toolCalls"],
    usage,
  };
}

// ─── Core: Generate Embedding ───────────────────────────────

export async function generateEmbedding(params: EmbeddingRequestParams): Promise<EmbeddingResponse> {
  const client = getClient();
  const model = params.model || defaultEmbeddingModel;

  const response = await client.embeddings.create({
    model,
    input: params.input.replace(/\n/g, " ").trim(),
  });

  const usage = {
    input_tokens: response.usage?.prompt_tokens ?? 0,
    total_tokens: response.usage?.total_tokens ?? 0,
  };

  // Track usage (fire-and-forget)
  trackAIUsage({
    tenantId: params.tenantId,
    feature: "embedding",
    model,
    promptTokens: usage.input_tokens,
    completionTokens: 0,
    totalTokens: usage.total_tokens,
    metadata: {
      documentId: params.metadata?.documentId,
    },
  }).catch((err) => console.error("[aiService] Embedding usage tracking failed:", err.message));

  return {
    embedding: response.data[0].embedding,
    usage,
  };
}

// ─── Convenience: Get default model ─────────────────────────

export function getDefaultModel(): string {
  return defaultModel;
}

export function getDefaultEmbeddingModel(): string {
  return defaultEmbeddingModel;
}
