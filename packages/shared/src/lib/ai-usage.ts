/**
 * Centralized AI usage logger.
 *
 * Every AI call in the platform - chat completion, embedding, classification,
 * suggestion, onboarding, bot responder - MUST call trackAIUsage() with the
 * provider's usage numbers so the Platform Usage admin view can show a single
 * unified number per tenant, model, and feature.
 *
 * Writes to `usage_logs` (the authoritative table). Never throws -
 * instrumentation must never break business logic.
 */
import { prisma } from "./prisma";

/**
 * OpenAI pricing per 1M tokens (USD). Keep this list small and in sync with
 * the models actually used by the platform. Lookup is exact-match first, then
 * longest-prefix (so dated ids like "gpt-5-mini-2025-08-07" price correctly).
 * Unknown models fall back to the platform default model's rates
 * (gpt-5-mini) so the cost stays meaningful rather than zero.
 *
 * `cachedPrompt` is the per-1M rate for prompt tokens served from OpenAI's
 * prefix cache (gpt-5 family: 90% off; older models billed at 50% of prompt
 * when the provider reports cached tokens — expressed here explicitly).
 */
export const AI_MODEL_PRICING: Record<string, { prompt: number; completion: number; cachedPrompt?: number }> = {
  "gpt-5":                  { prompt: 1.25,  completion: 10.00, cachedPrompt: 0.125  },
  "gpt-5-mini":             { prompt: 0.25,  completion: 2.00,  cachedPrompt: 0.025  },
  "gpt-5-nano":             { prompt: 0.05,  completion: 0.40,  cachedPrompt: 0.005  },
  "gpt-4o-mini":            { prompt: 0.15,  completion: 0.60,  cachedPrompt: 0.075  },
  "gpt-4o":                 { prompt: 2.50,  completion: 10.00, cachedPrompt: 1.25   },
  "gpt-4-turbo":            { prompt: 10.00, completion: 30.00 },
  "gpt-3.5-turbo":          { prompt: 0.50,  completion: 1.50  },
  "text-embedding-3-small": { prompt: 0.02,  completion: 0     },
  "text-embedding-3-large": { prompt: 0.13,  completion: 0     },
};
const DEFAULT_PRICING = AI_MODEL_PRICING["gpt-5-mini"]!;

/** Exact match, else longest-prefix match ("gpt-5-mini-2025-08-07" → "gpt-5-mini"). */
export function resolveModelPricing(model?: string | null): { prompt: number; completion: number; cachedPrompt?: number } {
  if (!model) return DEFAULT_PRICING;
  const exact = AI_MODEL_PRICING[model];
  if (exact) return exact;
  let best: string | null = null;
  for (const key of Object.keys(AI_MODEL_PRICING)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? AI_MODEL_PRICING[best]! : DEFAULT_PRICING;
}

export function estimateAICost(
  promptTokens: number,
  completionTokens: number,
  model?: string | null,
): number {
  const pricing = resolveModelPricing(model);
  return (
    (promptTokens / 1_000_000) * pricing.prompt +
    (completionTokens / 1_000_000) * pricing.completion
  );
}

/**
 * Full cost of one call, splitting prompt tokens into uncached (full rate)
 * and cached (model's cachedPrompt rate; 50% of prompt when unlisted).
 * Single source of truth — trackAIUsage and any reporting must use this.
 */
export function computeAICostUsd(opts: {
  model?: string | null;
  promptTokens: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
}): number {
  const pricing = resolveModelPricing(opts.model);
  const cached = Math.max(0, Math.min(opts.cachedPromptTokens ?? 0, opts.promptTokens));
  const uncached = Math.max(0, opts.promptTokens - cached);
  const cachedRate = pricing.cachedPrompt ?? pricing.prompt * 0.5;
  return (
    (uncached / 1_000_000) * pricing.prompt +
    (cached / 1_000_000) * cachedRate +
    ((opts.completionTokens ?? 0) / 1_000_000) * pricing.completion
  );
}

export interface AIUsageEvent {
  tenantId: string;
  /**
   * High-level feature label - what PART of the product spent the tokens.
   * The Platform Usage page aggregates by this field to answer
   * "who ate my tokens this month".
   * Examples: "chat", "suggestion", "summary", "classification", "embedding",
   * "action_plan", "intent_classify", "onboarding", "followup", "ai_bot",
   * "knowledge_retrieval".
   */
  feature: string;
  model: string;
  promptTokens: number;
  completionTokens?: number;
  totalTokens: number;
  /**
   * Per-turn attribution (P1-6). turnId groups every micro-call of ONE customer
   * turn (knowledge_resolve + wizard_binding + ai_bot + …); durationMs is this
   * call's wall time; aiAgentId is the employee (denormalized for rollups).
   * All optional — legacy callers keep working.
   */
  turnId?: string;
  durationMs?: number;
  aiAgentId?: string;
  /**
   * Subset of `promptTokens` that hit OpenAI's automatic prefix cache.
   * 0 when the prefix wasn't reused. Used to measure cache hit rate per
   * tenant/feature so we can verify the AIWorker prefix-stability contract
   * is actually delivering token savings.
   */
  cachedPromptTokens?: number;
  metadata?: {
    conversationId?: string;
    messageId?: string;
    documentId?: string;
    aiAgentId?: string;
    /** Stable session id (conversation/call). Pinned via OpenAI `user` param. */
    sessionId?: string;
    /** Hash of SYSTEM_CORE+SESSION_PROFILE. Must be constant per sessionId. */
    systemPromptHash?: string;
    /** True iff the OpenAI response reported cached_tokens > 0. */
    cachedPrefixUsed?: boolean;
    [key: string]: unknown;
  };
}

export async function trackAIUsage(event: AIUsageEvent): Promise<void> {
  try {
    const completionTokens = event.completionTokens ?? 0;
    const cachedPromptTokens = event.cachedPromptTokens ?? 0;
    const costUsd = computeAICostUsd({
      model: event.model,
      promptTokens: event.promptTokens,
      completionTokens,
      cachedPromptTokens,
    });
    await prisma.usageLog.create({
      data: {
        tenantId: event.tenantId,
        type: "ai_tokens",
        quantity: event.totalTokens,
        tokensEquivalent: event.totalTokens,
        feature: event.feature,
        model: event.model,
        promptTokens: event.promptTokens,
        completionTokens,
        costUsd: costUsd.toFixed(6) as any, // Prisma Decimal accepts string
        // Per-turn attribution (P1-6). aiAgentId falls back to metadata for
        // callers that still only set it there.
        turnId: event.turnId ?? null,
        durationMs: event.durationMs ?? null,
        aiAgentId: event.aiAgentId ?? (event.metadata?.aiAgentId as string | undefined) ?? null,
        metadata: {
          ...(event.metadata ?? {}),
          ...(cachedPromptTokens > 0 ? { cachedPromptTokens } : {}),
        } as any,
      },
    });
  } catch (err: any) {
    // Never throw - instrumentation must never break business logic.
    console.error("[trackAIUsage] failed:", err?.message ?? err);
  }
}

export interface EmployeeUsageRollup {
  aiAgentId: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Distinct customer turns attributed to this employee (turnId cardinality). */
  turns: number;
  /** Mean wall time per micro-call (ms), when durationMs was recorded. */
  avgDurationMs: number | null;
  /** Cache-hit rate = cached prompt tokens / prompt tokens (prefix reuse). */
  cacheHitRate: number | null;
}

/**
 * Per-employee AI usage rollup (P1-6): cost, tokens, turns, latency and
 * cache-hit rate grouped by aiAgentId over a window. Reads the denormalized
 * columns (no metadata join). Cache-hit rate uses the persisted
 * `metadata.cachedPromptTokens` sum vs prompt tokens.
 */
export async function getEmployeeUsageRollup(
  tenantId: string,
  opts: { since?: Date; until?: Date } = {},
): Promise<EmployeeUsageRollup[]> {
  const where: Record<string, unknown> = { tenantId, type: "ai_tokens", aiAgentId: { not: null } };
  if (opts.since || opts.until) {
    where.createdAt = { ...(opts.since ? { gte: opts.since } : {}), ...(opts.until ? { lte: opts.until } : {}) };
  }
  const rows = await prisma.usageLog.findMany({
    where: where as any,
    select: {
      aiAgentId: true, promptTokens: true, completionTokens: true, tokensEquivalent: true,
      costUsd: true, turnId: true, durationMs: true, metadata: true,
    },
  });

  const acc = new Map<string, {
    calls: number; prompt: number; completion: number; total: number; cost: number;
    turns: Set<string>; durSum: number; durCount: number; cachedPrompt: number;
  }>();
  for (const r of rows as any[]) {
    const id = r.aiAgentId as string;
    const a = acc.get(id) ?? { calls: 0, prompt: 0, completion: 0, total: 0, cost: 0, turns: new Set<string>(), durSum: 0, durCount: 0, cachedPrompt: 0 };
    a.calls += 1;
    a.prompt += r.promptTokens ?? 0;
    a.completion += r.completionTokens ?? 0;
    a.total += r.tokensEquivalent ?? 0;
    a.cost += r.costUsd ? Number(r.costUsd) : 0;
    if (r.turnId) a.turns.add(r.turnId);
    if (typeof r.durationMs === "number") { a.durSum += r.durationMs; a.durCount += 1; }
    const cached = Number((r.metadata as any)?.cachedPromptTokens ?? 0);
    if (cached > 0) a.cachedPrompt += cached;
    acc.set(id, a);
  }

  return [...acc.entries()].map(([aiAgentId, a]) => ({
    aiAgentId,
    calls: a.calls,
    promptTokens: a.prompt,
    completionTokens: a.completion,
    totalTokens: a.total,
    costUsd: Number(a.cost.toFixed(6)),
    turns: a.turns.size,
    avgDurationMs: a.durCount > 0 ? Math.round(a.durSum / a.durCount) : null,
    cacheHitRate: a.prompt > 0 ? Number((a.cachedPrompt / a.prompt).toFixed(4)) : null,
  })).sort((x, y) => y.costUsd - x.costUsd);
}
