import { getInternalServiceKey } from "@chatcenter/shared";
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
import { trackAIUsage, assertAiAllowed, meterAiUnits, reportOperationalFailure, recordExpectedOutcome, ERROR_CODES } from "@chatcenter/shared";
import { logAudit } from "./audit.service";
import { stablePrefixOf } from "./prompt-builder.service";

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
    /** Per-turn attribution (P1-6): groups every micro-call of one customer turn. */
    turnId?: string;
    type?: string; // "suggestion" | "chat" | "summary" | "classification" | "onboarding"
    /**
     * Hash of the cached system prefix (SYSTEM_CORE + SESSION_PROFILE).
     * Logged with usage so we can detect prefix drift within a session -
     * if this changes mid-session, the OpenAI prefix cache is invalidated.
     */
    systemPromptHash?: string;
    [key: string]: any;
  };
  /**
   * Stable identifier for the conversation/call. Passed to OpenAI as the
   * `user` parameter so requests within a session route consistently -
   * this is a prerequisite for OpenAI's automatic prompt-prefix caching
   * (https://platform.openai.com/docs/guides/prompt-caching).
   */
  sessionId?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" | "text" };
  /** OpenAI function-calling tool schemas. Passed through untouched. */
  tools?: any[];
  toolChoice?: any;
  /**
   * Cancellation signal. When aborted, the underlying fetch to OpenAI is
   * cancelled - the SDK throws `APIUserAbortError`. Used by the per-turn
   * cancellation registry (`turn-cancellation.service`) so a newer customer
   * message can drop the in-flight LLM call instead of letting both
   * complete and replying twice.
   */
  signal?: AbortSignal;
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
    /**
     * Subset of `input_tokens` that hit OpenAI's automatic prefix cache.
     * 0 when the prefix wasn't reused (cold cache, prefix < 1024 tokens,
     * or prefix bytes diverged from prior call in the session).
     */
    cached_tokens: number;
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
// Single source of truth for the default chat model. Overridden at init() from
// OPENAI_DEFAULT_MODEL (see index.ts). All call sites resolve the model via
// getDefaultModel() rather than hardcoding a literal, so swapping models is a
// one-env-var change.
let defaultModel = "gpt-5-mini";
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

// In-memory per-session cache-prefix tracker.
//
// Spec assertion contract: for a given sessionId, the system MUST keep the
// system-prompt prefix byte-identical across calls. If it drifts, the
// prefix cache breaks silently - that's a system design violation and the
// caller needs to see it. We capture a SHA-256 of the first system message
// here and compare on every subsequent call with the same sessionId.
//
// LRU-bounded so a long-lived process doesn't grow unbounded.
interface SessionPrefixRecord {
  hash: string;
  firstSeenAt: number;
  callCount: number;
}
const SESSION_PREFIX_CACHE = new Map<string, SessionPrefixRecord>();
const SESSION_PREFIX_CACHE_MAX = 500;

function recordAndAssertPrefix(
  sessionId: string,
  systemPrefix: string,
): { hash: string; drift: boolean; isFirstCall: boolean } {
  // Lazy import to avoid loading node:crypto when generateResponse is
  // never called (e.g. embedding-only entry points).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("crypto") as typeof import("crypto");
  const hash = createHash("sha256").update(systemPrefix).digest("hex").slice(0, 16);

  const existing = SESSION_PREFIX_CACHE.get(sessionId);
  if (!existing) {
    if (SESSION_PREFIX_CACHE.size >= SESSION_PREFIX_CACHE_MAX) {
      // Drop the oldest entry - Map preserves insertion order.
      const firstKey = SESSION_PREFIX_CACHE.keys().next().value;
      if (firstKey !== undefined) SESSION_PREFIX_CACHE.delete(firstKey);
    }
    SESSION_PREFIX_CACHE.set(sessionId, { hash, firstSeenAt: Date.now(), callCount: 1 });
    return { hash, drift: false, isFirstCall: true };
  }

  existing.callCount += 1;
  if (existing.hash !== hash) {
    console.warn(
      `[aiService] CACHE PREFIX DRIFT - sessionId=${sessionId} ` +
      `had hash=${existing.hash} (call #${existing.callCount - 1}) but now hash=${hash}. ` +
      `Prefix cache broken from this call onward. Check that the system prompt's per-agent + per-conv blocks render byte-identical across turns.`,
    );
    // Overwrite so future calls compare against the new prefix instead of
    // log-spamming every turn.
    existing.hash = hash;
    return { hash, drift: true, isFirstCall: false };
  }
  return { hash, drift: false, isFirstCall: false };
}

// OpenAI requires tool function names to match ^[a-zA-Z0-9_-]+$ - but adapter
// tools are named `<provider>.<tool>` (e.g. "hubspot.create_lead"), and the dot
// is load-bearing for dispatch routing. Sanitize names for the API call (dots →
// "__", any other illegal char → "_") and map them back on the returned tool
// calls so downstream dispatch still sees the original dotted name. A single
// bad name otherwise 400s the WHOLE completion (the bot can't reply at all).
const ILLEGAL_TOOL_NAME_CHARS = /[^a-zA-Z0-9_-]/g;
function sanitizeToolName(name: string): string {
  return name.replace(/\./g, "__").replace(ILLEGAL_TOOL_NAME_CHARS, "_");
}
// A forced tool_choice must name the SANITIZED tool (OpenAI rejects the dotted
// adapter name `shopify.search_products`). Applied wherever tool_choice is set
// so a dotted forced tool (e.g. the Discovery-ready product search) works.
function sanitizeToolChoice(choice: any): any {
  if (choice && typeof choice === "object" && choice.type === "function" && choice.function?.name) {
    return { ...choice, function: { ...choice.function, name: sanitizeToolName(String(choice.function.name)) } };
  }
  return choice;
}
function sanitizeToolsForOpenAI(
  tools: any[],
): { tools: any[]; nameMap: Map<string, string> } {
  const nameMap = new Map<string, string>();
  let changed = false;
  const out = tools.map((t) => {
    const orig = t?.function?.name;
    if (typeof orig !== "string") return t;
    const safe = sanitizeToolName(orig);
    if (safe === orig) return t;
    changed = true;
    nameMap.set(safe, orig);
    return { ...t, function: { ...t.function, name: safe } };
  });
  return { tools: changed ? out : tools, nameMap };
}
function restoreToolCallNames(
  toolCalls: any[] | undefined,
  nameMap: Map<string, string> | null,
): any[] | undefined {
  if (!toolCalls || !nameMap || nameMap.size === 0) return toolCalls;
  return toolCalls.map((tc) => {
    const orig = tc?.function?.name ? nameMap.get(tc.function.name) : undefined;
    return orig ? { ...tc, function: { ...tc.function, name: orig } } : tc;
  });
}
// Same constraint, history side. After a tool round, callers echo the prior
// assistant message back to us with its `tool_calls` carrying the RESTORED
// dotted name (e.g. "google_calendar.check_availability") - because dispatch
// routing needs the dotted form. But that name now rides in `messages[].
// tool_calls[].function.name`, which OpenAI validates against the SAME
// ^[a-zA-Z0-9_-]+$ pattern as the tools array. An un-sanitized dotted name
// here 400s the follow-up completion ("not retryable") - the tool ran, but the
// bot can never turn the result into a reply, so the turn dies silently. Mirror
// the tools-array sanitization on the outgoing messages. tool_call_id (not the
// name) is what links assistant tool_calls to their tool results, so renaming
// is protocol-safe. Idempotent: already-"__" names are unchanged, preserving
// prefix-cache byte stability.
function sanitizeMessagesForOpenAI(messages: any[]): any[] {
  let changed = false;
  const out = messages.map((m) => {
    const toolCalls = m?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return m;
    let msgChanged = false;
    const safeCalls = toolCalls.map((tc: any) => {
      const name = tc?.function?.name;
      if (typeof name !== "string") return tc;
      const safe = sanitizeToolName(name);
      if (safe === name) return tc;
      msgChanged = true;
      return { ...tc, function: { ...tc.function, name: safe } };
    });
    if (!msgChanged) return m;
    changed = true;
    return { ...m, tool_calls: safeCalls };
  });
  return changed ? out : messages;
}

// gpt-5 family + o-series reasoning models changed the chat-completions
// contract: `max_tokens` is rejected (use `max_completion_tokens`), and only the
// default temperature (1) is accepted. Detect by model id so a single
// OPENAI_DEFAULT_MODEL swap doesn't 400 every call.
function modelRequiresCompletionTokens(model: string): boolean {
  return /^(gpt-5|o[1-9])/i.test(model);
}

// Set the token cap + temperature on a chat-completions request in the shape the
// target model accepts. Mutates `req`.
function applyTokenAndTemperatureParams(
  req: Record<string, any>,
  model: string,
  temperature: number | undefined,
  maxTokens: number | undefined,
): void {
  const tokens = maxTokens ?? 1024;
  if (modelRequiresCompletionTokens(model)) {
    // Reasoning models (gpt-5 / o-series) spend HIDDEN reasoning tokens BEFORE
    // any visible output, and `max_completion_tokens` caps the COMBINED total.
    // Capping at just the intended output size starves the reply: the whole
    // budget goes to reasoning and content comes back '' with
    // finish_reason='length' (the bot then "doesn't respond"). So add reasoning
    // headroom ON TOP of the requested output budget. This is only a ceiling -
    // you pay for tokens actually generated, so a generous cap is safe.
    const headroom = Number(process.env.OPENAI_REASONING_HEADROOM_TOKENS) || 2048;
    req.max_completion_tokens = tokens + headroom;
    // Keep reasoning light so the bot stays responsive (default 'medium' on
    // gpt-5 makes chat turns slow and reasoning-token heavy). Override via env;
    // "none" omits the param entirely.
    const effort = process.env.OPENAI_REASONING_EFFORT || "low";
    if (effort && effort !== "none") req.reasoning_effort = effort;
    // Only the default temperature (1) is supported - send it only when it is
    // exactly the default, otherwise omit so the model uses its required value.
    if (temperature === 1) req.temperature = temperature;
  } else {
    req.max_tokens = tokens;
    req.temperature = temperature ?? 0.7;
  }
}

const BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "http://billing:4009";

/**
 * Debit AI Units for a completed model call and, when balance crosses an alert
 * threshold (80/90/95/100%), notify billing so it can fan out owner alerts and
 * trigger auto-purchase. Fully best-effort: any failure is logged, never thrown.
 */
async function meterAndReact(
  tenantId: string,
  model: string,
  usage: { input_tokens: number; output_tokens: number; cached_tokens: number },
  conversationId?: string,
): Promise<void> {
  try {
    const m = await meterAiUnits({
      tenantId,
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedInputTokens: usage.cached_tokens,
      referenceId: conversationId,
    });
    if (!m || m.thresholds.length === 0) return;
    await fetch(`${BILLING_SERVICE_URL}/api/internal/billing/usage-threshold`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-key": getInternalServiceKey(),
      },
      body: JSON.stringify({ tenantId, thresholds: m.thresholds }),
    }).catch(() => {});
  } catch (err: any) {
    console.error("[aiService] meterAndReact failed:", err?.message ?? err);
  }
}

export async function generateResponse(params: AIRequestParams): Promise<AIResponse> {
  const client = getClient();
  const model = params.model || defaultModel;
  const type = params.metadata?.type || "chat";

  // Billing pre-flight: refuse AI when the tenant is out of AI Units or the
  // subscription isn't serviceable. Throws AiUnitsExhaustedError ONLY in
  // BILLING_ENFORCEMENT_MODE=hard; off/observe/soft never block. Callers map
  // the error to graceful degradation (bot escalates, copilot disables).
  await assertAiAllowed(params.tenantId);

  const requestParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages: sanitizeMessagesForOpenAI(params.messages),
  };
  applyTokenAndTemperatureParams(requestParams as any, model, params.temperature, params.maxTokens);

  // Pin to a stable backend route so OpenAI's automatic prefix cache can
  // hit consistently across turns in the same conversation/call.
  if (params.sessionId) {
    (requestParams as any).user = params.sessionId;
  }

  if (params.responseFormat) {
    requestParams.response_format = params.responseFormat;
  }
  let toolNameMap: Map<string, string> | null = null;
  if (params.tools && params.tools.length > 0) {
    const s = sanitizeToolsForOpenAI(params.tools);
    (requestParams as any).tools = s.tools;
    toolNameMap = s.nameMap.size > 0 ? s.nameMap : null;
    if (params.toolChoice) (requestParams as any).tool_choice = sanitizeToolChoice(params.toolChoice);
  }

  // Compute + compare the per-session system-prompt-prefix hash BEFORE the
  // API call so any drift is logged even if the call throws. We hash ONLY the
  // STABLE prefix (BLOCK 1 + BLOCK 2) - NOT the per-turn block, which is fresh
  // every message and would otherwise make the hash "drift" every turn even
  // when the cacheable prefix is perfectly stable. `stablePrefixOf` strips the
  // final per-turn block; single-block system prompts hash in full.
  let prefixAssertion: { hash: string; drift: boolean; isFirstCall: boolean } | null = null;
  if (params.sessionId) {
    const firstSystem = params.messages.find((m: any) => m.role === "system");
    const systemContent = typeof firstSystem?.content === "string" ? firstSystem.content : "";
    const systemPrefix = systemContent ? stablePrefixOf(systemContent) : "";
    if (systemPrefix) {
      prefixAssertion = recordAndAssertPrefix(params.sessionId, systemPrefix);
    }
  }

  const llmStartedAt = Date.now();
  const response = await callWithRetry(
    () => client.chat.completions.create(
      requestParams,
      params.signal ? { signal: params.signal } : undefined,
    ),
    params.signal,
  );
  const llmDurationMs = Date.now() - llmStartedAt;

  const cachedTokens =
    (response.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0;
  const usage = {
    input_tokens: response.usage?.prompt_tokens ?? 0,
    output_tokens: response.usage?.completion_tokens ?? 0,
    total_tokens: response.usage?.total_tokens ?? 0,
    cached_tokens: cachedTokens,
  };

  // Spec assertion #2: once we're past the first call for a session AND the
  // prefix hash didn't drift, we expect cached_tokens > 0. A miss here means
  // either (a) under 1024 prompt tokens (cache minimum) or (b) the OpenAI
  // backend evicted the prefix (~5min TTL). Logged as warn - not an error,
  // because both conditions are legitimate, but operators need to see it.
  if (
    params.sessionId &&
    prefixAssertion &&
    !prefixAssertion.drift &&
    !prefixAssertion.isFirstCall &&
    cachedTokens === 0
  ) {
    console.warn(
      `[aiService] expected cache hit but cached_tokens=0 - sessionId=${params.sessionId} ` +
      `hash=${prefixAssertion.hash} promptTokens=${usage.input_tokens}. ` +
      `Likely cause: prompt prefix < 1024 tokens, or >5min since last call (cache TTL).`,
    );
  }
  // Positive telemetry too - operators need cache HEALTH visible in both directions.
  if (params.sessionId && cachedTokens > 0) {
    console.log(
      `[aiService] cache HIT sessionId=${params.sessionId} cached=${cachedTokens}/${usage.input_tokens} promptTokens`,
    );
  }

  const content = response.choices[0]?.message?.content || "";
  const rawToolCalls = restoreToolCallNames(
    (response.choices[0]?.message as any)?.tool_calls as any[] | undefined,
    toolNameMap,
  );

  // Track usage (fire-and-forget, never block the response)
  trackAIUsage({
    tenantId: params.tenantId,
    feature: type,
    model,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cachedPromptTokens: cachedTokens,
    // Per-turn attribution (P1-6): wall time of THIS call; turnId + aiAgentId
    // from the caller's metadata so every micro-call of one turn shares a key.
    durationMs: llmDurationMs,
    turnId: params.metadata?.turnId,
    aiAgentId: params.metadata?.aiAgentId,
    metadata: {
      conversationId: params.metadata?.conversationId,
      aiAgentId: params.metadata?.aiAgentId,
      turnId: params.metadata?.turnId,
      sessionId: params.sessionId,
      // Spec assertion fields surfaced on every usage row so the platform
      // dashboard can detect violations: hash drift = prompt instability;
      // cached_prefix_used=false post-first-call = caching not working.
      systemPromptHash: prefixAssertion?.hash ?? params.metadata?.systemPromptHash,
      systemPromptHashDrift: prefixAssertion?.drift ?? false,
      cachedPrefixUsed: cachedTokens > 0,
    },
  }).catch((err) => console.error("[aiService] Usage tracking failed:", err.message));

  // Meter AI Units (cost-driven debit) + react to crossed thresholds. No-op
  // when BILLING_ENFORCEMENT_MODE=off. Fire-and-forget: never delays the reply.
  void meterAndReact(params.tenantId, model, usage, params.metadata?.conversationId);

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
// contracts as `generateResponse` - the totals just land at the END of the
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

  // Billing pre-flight - identical gate to the non-streaming generateResponse().
  // Without this, every streamed AI path (autonomous worker, agent-runtime,
  // agent-builder) would bypass the AI-Unit gate entirely. Throws
  // AiUnitsExhaustedError ONLY in BILLING_ENFORCEMENT_MODE=hard; off/observe/soft
  // never block. Callers map the error to graceful degradation.
  await assertAiAllowed(params.tenantId);

  const requestParams: OpenAI.ChatCompletionCreateParamsStreaming = {
    model,
    messages: sanitizeMessagesForOpenAI(params.messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  applyTokenAndTemperatureParams(requestParams as any, model, params.temperature, params.maxTokens);
  if (params.sessionId) {
    (requestParams as any).user = params.sessionId;
  }
  let toolNameMap: Map<string, string> | null = null;
  if (params.tools && params.tools.length > 0) {
    const s = sanitizeToolsForOpenAI(params.tools);
    (requestParams as any).tools = s.tools;
    toolNameMap = s.nameMap.size > 0 ? s.nameMap : null;
    if (params.toolChoice) (requestParams as any).tool_choice = sanitizeToolChoice(params.toolChoice);
  }

  const stream = await client.chat.completions.create(requestParams);

  let accumulatedContent = "";
  // OpenAI delivers tool_calls in deltas keyed by an `index`. We assemble
  // them as we go and only emit a finalised list on `done`.
  const toolCallAcc: Record<number, { id?: string; type: "function"; function: { name?: string; arguments?: string } }> = {};
  let usage: AIResponse["usage"] = { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_tokens: 0 };

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
        cached_tokens: (chunk.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0,
      };
    }
  }

  const finalToolCalls = restoreToolCallNames(
    Object.values(toolCallAcc)
      .filter((s) => s.id && s.function.name)
      .map((s) => ({
        id: s.id!,
        type: "function" as const,
        function: { name: s.function.name!, arguments: s.function.arguments || "{}" },
      })),
    toolNameMap,
  )!;

  // Same fire-and-forget tracking + audit + AI-Unit metering as the
  // non-streaming path. meterAndReact debits the wallet, writes the billing
  // ledger, and fires threshold notifications - without it the streaming path
  // would consume model capacity without ever billing it.
  void meterAndReact(params.tenantId, model, usage, params.metadata?.conversationId);

  trackAIUsage({
    tenantId: params.tenantId,
    feature: type,
    model,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cachedPromptTokens: usage.cached_tokens,
    metadata: {
      conversationId: params.metadata?.conversationId,
      aiAgentId: params.metadata?.aiAgentId,
      sessionId: params.sessionId,
      systemPromptHash: params.metadata?.systemPromptHash,
      cachedPrefixUsed: usage.cached_tokens > 0,
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

/**
 * Micro-call tier (P1-7). The cheap, high-frequency helper calls that block
 * EVERY turn (knowledge_resolve, wizard_binding) don't need the flagship
 * reasoning model - they extract/classify from a bounded prompt. Route them to
 * a smaller/faster model (default gpt-5-nano) to cut per-turn latency and cost.
 * Override with OPENAI_MICRO_MODEL; falls back to the default model if unset so
 * the tier can be disabled by pointing it at the same model.
 */
export function getMicroModel(): string {
  return process.env.OPENAI_MICRO_MODEL || "gpt-5-nano";
}

export function getDefaultEmbeddingModel(): string {
  return defaultEmbeddingModel;
}

// ─── Provider retry/backoff (P1-7) ──────────────────────────
// The OpenAI SDK retries some errors itself, but not uniformly and not with a
// jittered backoff we control. Wrap terminal LLM calls so a transient 429/5xx
// or network blip doesn't fail a whole customer turn. NEVER retries a user
// abort (turn cancellation) or a non-retryable 4xx (bad request / auth).
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function isAbort(err: any): boolean {
  return err?.name === "APIUserAbortError" || err?.name === "AbortError" || err?.code === "ABORT_ERR";
}
function isRetryable(err: any): boolean {
  if (isAbort(err)) return false;
  const status = err?.status ?? err?.response?.status;
  if (typeof status === "number") return RETRYABLE_STATUS.has(status);
  // No HTTP status → network/timeout class (ECONNRESET, ETIMEDOUT, fetch failed).
  return true;
}

/**
 * Which alert this failure belongs to.
 *
 * Separate from the retry logic and exported so the mapping can be tested
 * without a provider: the classification IS the alert contract, and a rate-limit
 * misfiled as a provider outage sends someone looking at the wrong dashboard.
 */
export function classifyLlmFailure(err: any) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429) return ERROR_CODES.ai_rate_limit;
  if (status === 408) return ERROR_CODES.ai_timeout;
  const code = String(err?.code ?? "");
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || /timeout/i.test(String(err?.message ?? ""))) {
    return ERROR_CODES.ai_timeout;
  }
  return ERROR_CODES.ai_provider_failure;
}

export async function callWithRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  opts: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 400;
  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt === maxRetries || !isRetryable(err) || signal?.aborted) {
        // A cancelled turn is the user changing their mind, not an incident.
        // Filing it would bury real provider outages in cancellation noise.
        if (isAbort(err) || signal?.aborted) {
          recordExpectedOutcome("ai_turn_cancelled", { attempts: attempt + 1 });
        } else {
          // Reported once, AFTER retries are exhausted - alerting on each
          // attempt would triple the rate of every transient blip.
          reportOperationalFailure({
            errorCode: classifyLlmFailure(err),
            domain: "ai",
            service: "ai",
            provider: "openai",
            cause: err,
            context: { attempts: attempt + 1, status: err?.status ?? null, retryable: isRetryable(err) },
          });
        }
        throw err;
      }
      // Exponential backoff with jitter; honour a Retry-After header when present.
      const retryAfterSec = Number(err?.headers?.["retry-after"] ?? err?.response?.headers?.get?.("retry-after"));
      const backoff = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : baseDelayMs * 2 ** attempt + Math.floor(Math.random() * baseDelayMs);
      console.warn(`[aiService] LLM call failed (attempt ${attempt + 1}/${maxRetries + 1}, status=${err?.status ?? "net"}); retrying in ${backoff}ms`);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, backoff);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(err); }, { once: true });
      });
    }
  }
  throw lastErr;
}
