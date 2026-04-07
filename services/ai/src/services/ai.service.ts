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
import { trackUsage } from "./usage.service";
import { logAudit } from "./audit.service";

// ─── Types ──────────────────────────────────────────────────

export interface AIRequestParams {
  tenantId: string;
  model?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  metadata?: {
    conversationId?: string;
    aiAgentId?: string;
    type?: string; // "suggestion" | "chat" | "summary" | "classification" | "onboarding"
    [key: string]: any;
  };
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" | "text" };
}

export interface AIResponse {
  content: string;
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

  const response = await client.chat.completions.create(requestParams);

  const usage = {
    input_tokens: response.usage?.prompt_tokens ?? 0,
    output_tokens: response.usage?.completion_tokens ?? 0,
    total_tokens: response.usage?.total_tokens ?? 0,
  };

  const content = response.choices[0]?.message?.content || "";

  // Track usage (fire-and-forget, never block the response)
  trackUsage({
    tenantId: params.tenantId,
    type: "ai_tokens",
    quantity: usage.total_tokens,
    metadata: {
      model,
      conversationId: params.metadata?.conversationId,
      type,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
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

  return { content, usage };
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
  trackUsage({
    tenantId: params.tenantId,
    type: "ai_tokens",
    quantity: usage.total_tokens,
    metadata: {
      model,
      type: "embedding",
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
