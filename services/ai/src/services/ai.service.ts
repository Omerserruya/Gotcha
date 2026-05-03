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

// ─── Streaming variant ──────────────────────────────────────
//
// Used by the System Copilot (Command Center) so tokens reach the operator's
// UI as they're generated. Maintains the same audit + usage-tracking
// contracts as `generateResponse` — the totals just land at the END of the
// stream, after we've consumed all chunks.

export interface AIStreamEvent {
  /** Content delta. Empty string is a no-op (skip). */
  contentDelta?: string;
  /** Accumulated tool_calls (OpenAI delivers them piecewise across chunks). */
  toolCallsDelta?: any[];
  /** Final assistant content (only on `done`). */
  content?: string;
  /** Final tool_calls (only on `done`). */
  toolCalls?: AIResponse["toolCalls"];
  usage?: AIResponse["usage"];
  done?: boolean;
}

export async function* streamResponse(params: AIRequestParams): AsyncGenerator<AIStreamEvent, void, void> {
  const client = getClient();
  const model = params.model || defaultModel;
  const type = params.metadata?.type || "chat";

  const requestParams: OpenAI.ChatCompletionCreateParamsStreaming = {
    model,
    messages: params.messages,
    temperature: params.temperature ?? 0.7,
    max_tokens: params.maxTokens ?? 1024,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (params.tools && params.tools.length > 0) {
    (requestParams as any).tools = params.tools;
    if (params.toolChoice) (requestParams as any).tool_choice = params.toolChoice;
  }

  const stream = await client.chat.completions.create(requestParams);

  let accumulatedContent = "";
  // OpenAI delivers tool_calls in deltas keyed by an `index`. We assemble
  // them as we go and only emit a finalised list on `done`.
  const toolCallAcc: Record<number, { id?: string; type: "function"; function: { name?: string; arguments?: string } }> = {};
  let usage: AIResponse["usage"] = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const delta: any = choice?.delta;
    if (delta?.content) {
      accumulatedContent += delta.content;
      yield { contentDelta: delta.content };
    }
    if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const tcd of delta.tool_calls) {
        const idx = typeof tcd.index === "number" ? tcd.index : 0;
        const slot = (toolCallAcc[idx] ||= { type: "function", function: {} });
        if (tcd.id) slot.id = tcd.id;
        if (tcd.function?.name) slot.function.name = (slot.function.name || "") + tcd.function.name;
        if (tcd.function?.arguments)
          slot.function.arguments = (slot.function.arguments || "") + tcd.function.arguments;
      }
      yield { toolCallsDelta: Object.values(toolCallAcc) };
    }
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens ?? 0,
        output_tokens: chunk.usage.completion_tokens ?? 0,
        total_tokens: chunk.usage.total_tokens ?? 0,
      };
    }
  }

  const finalToolCalls = Object.values(toolCallAcc)
    .filter((s) => s.id && s.function.name)
    .map((s) => ({
      id: s.id!,
      type: "function" as const,
      function: { name: s.function.name!, arguments: s.function.arguments || "{}" },
    }));

  // Same fire-and-forget tracking + audit as the non-streaming path.
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
  }).catch((err) => console.error("[aiService] Usage tracking (stream) failed:", err.message));

  logAudit({
    tenantId: params.tenantId,
    actor: { type: "ai", id: params.metadata?.aiAgentId },
    action: "ai.responded",
    target: params.metadata?.conversationId
      ? { type: "conversation", id: params.metadata.conversationId }
      : undefined,
    metadata: { model, type, tokens: usage, streamed: true },
  }).catch((err) => console.error("[aiService] Audit logging (stream) failed:", err.message));

  yield {
    done: true,
    content: accumulatedContent,
    toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
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
