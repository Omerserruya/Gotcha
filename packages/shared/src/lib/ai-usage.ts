/**
 * Centralized AI usage logger.
 *
 * Every AI call in the platform — chat completion, embedding, classification,
 * suggestion, onboarding, bot responder — MUST call trackAIUsage() with the
 * provider's usage numbers so the Platform Usage admin view can show a single
 * unified number per tenant, model, and feature.
 *
 * Writes to `usage_logs` (the authoritative table). Never throws —
 * instrumentation must never break business logic.
 */
import { prisma } from "./prisma";

/**
 * OpenAI pricing per 1M tokens (USD). Keep this list small and in sync with
 * the models actually used by the platform. Unknown models fall back to
 * gpt-4o-mini rates so the cost stays meaningful rather than zero.
 */
export const AI_MODEL_PRICING: Record<string, { prompt: number; completion: number }> = {
  "gpt-4o-mini":            { prompt: 0.15,  completion: 0.60  },
  "gpt-4o":                 { prompt: 2.50,  completion: 10.00 },
  "gpt-4-turbo":            { prompt: 10.00, completion: 30.00 },
  "gpt-3.5-turbo":          { prompt: 0.50,  completion: 1.50  },
  "text-embedding-3-small": { prompt: 0.02,  completion: 0     },
  "text-embedding-3-large": { prompt: 0.13,  completion: 0     },
};
const DEFAULT_PRICING = AI_MODEL_PRICING["gpt-4o-mini"]!;

export function estimateAICost(
  promptTokens: number,
  completionTokens: number,
  model?: string | null,
): number {
  const pricing = (model && AI_MODEL_PRICING[model]) || DEFAULT_PRICING;
  return (
    (promptTokens / 1_000_000) * pricing.prompt +
    (completionTokens / 1_000_000) * pricing.completion
  );
}

export interface AIUsageEvent {
  tenantId: string;
  /**
   * High-level feature label — what PART of the product spent the tokens.
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
    // OpenAI bills cached prompt tokens at 50% of the standard rate.
    // Bill uncached at full rate, cached at half rate so the cost number
    // reflects the actual savings rather than over-charging post-cache.
    const uncachedPromptTokens = Math.max(0, event.promptTokens - cachedPromptTokens);
    const costUsd =
      estimateAICost(uncachedPromptTokens, completionTokens, event.model) +
      estimateAICost(cachedPromptTokens, 0, event.model) * 0.5;
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
        metadata: {
          ...(event.metadata ?? {}),
          ...(cachedPromptTokens > 0 ? { cachedPromptTokens } : {}),
        } as any,
      },
    });
  } catch (err: any) {
    // Never throw — instrumentation must never break business logic.
    console.error("[trackAIUsage] failed:", err?.message ?? err);
  }
}
