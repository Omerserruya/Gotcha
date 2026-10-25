/**
 * What a bot turn really costs in input: the tokens the provider did NOT serve
 * from its prefix cache (2026-10-25). The nominal sum over-reports a
 * multi-round turn about threefold: a lookup turn read 64k "input tokens" and
 * cost $0.008, because rounds 2 and 3 re-sent a prompt that was 95% cached.
 * Budgets and alerts are judged on this number, not the nominal one.
 */

/** Alert above this many uncached input tokens in one turn. */
export const UNCACHED_INPUT_ALERT = Number(process.env.AI_TURN_UNCACHED_ALERT || 30_000);

export function uncachedInputOf(usage: { input_tokens?: number; cached_tokens?: number } | null | undefined): number {
  const input = Number(usage?.input_tokens) || 0;
  const cached = Number(usage?.cached_tokens) || 0;
  return Math.max(0, input - cached);
}

/** True, and one structured log line, when the turn went over the budget. */
export function alertIfOverBudget(opts: {
  tenantId: string;
  conversationId: string;
  aiAgentId: string;
  uncachedInputTokens: number;
  totalTokens: number;
  limit?: number;
}): boolean {
  const limit = opts.limit ?? UNCACHED_INPUT_ALERT;
  if (opts.uncachedInputTokens <= limit) return false;
  console.warn(JSON.stringify({
    tag: "ai.turn.uncached_over_budget",
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    aiAgentId: opts.aiAgentId,
    uncachedInputTokens: opts.uncachedInputTokens,
    totalTokens: opts.totalTokens,
    limit,
  }));
  return true;
}
