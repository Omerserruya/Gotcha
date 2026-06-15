/**
 * Cost / token budget enforcer for the autonomous bot loop.
 *
 * Three caps stack:
 *
 *   1. Per-turn cap — hard ceiling on tokens spent in ONE bot turn,
 *      summed across all rounds of the tool-calling loop + any retry.
 *      Trips when the model keeps tool-calling and we keep paying.
 *
 *   2. Per-conversation cap — rolling total token spend for a single
 *      conversation, evaluated against `UsageLog` rows for that
 *      `metadata.conversationId`. Trips on long abuse threads.
 *
 *   3. Per-tenant daily cap — rolling 24h total token spend for the
 *      tenant. Last line of defence against bot/widget flooding.
 *
 * All three are configurable via env vars; sane defaults are baked in.
 * The enforcer is fail-open on DB errors — never block legitimate
 * traffic because of a transient lookup failure, but always abort and
 * audit when the in-memory per-turn counter trips.
 *
 * Usage shape:
 *
 *   const budget = createTurnBudget({ tenantId, conversationId });
 *   await budget.preflight();             // throws on conv/tenant cap breach
 *   ...inside the loop, after each LLM call:
 *   budget.addUsage(response.usage.total_tokens || 0);
 *   if (budget.exceededTurnCap()) { audit + break; }
 */

import { prisma } from "@chatcenter/shared";

const TOKENS_PER_TURN_DEFAULT = 25_000;
const TOKENS_PER_CONV_DEFAULT = 250_000;
const TOKENS_PER_TENANT_DAY_DEFAULT = 5_000_000;

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface BudgetCaps {
  perTurn: number;
  perConversation: number;
  perTenantDaily: number;
}

export function getDefaultCaps(): BudgetCaps {
  return {
    perTurn: envInt("AI_BUDGET_TOKENS_PER_TURN", TOKENS_PER_TURN_DEFAULT),
    perConversation: envInt("AI_BUDGET_TOKENS_PER_CONVERSATION", TOKENS_PER_CONV_DEFAULT),
    perTenantDaily: envInt("AI_BUDGET_TOKENS_PER_TENANT_DAY", TOKENS_PER_TENANT_DAY_DEFAULT),
  };
}

export class BudgetExceededError extends Error {
  constructor(public scope: "turn" | "conversation" | "tenant_day", public used: number, public cap: number) {
    super(`AI budget exceeded (${scope}): used=${used} cap=${cap}`);
    this.name = "BudgetExceededError";
  }
}

export interface TurnBudget {
  /** Run BEFORE the first OpenAI call. Throws BudgetExceededError on conv/tenant cap breach. */
  preflight: () => Promise<void>;
  /** Add tokens spent in the most recent round. */
  addUsage: (tokens: number) => void;
  /** True iff the per-turn cap was exceeded. */
  exceededTurnCap: () => boolean;
  /** Total tokens used in this turn so far. */
  tokensThisTurn: () => number;
  /** Caps in force for this turn. */
  caps: BudgetCaps;
}

interface CreateTurnBudgetOpts {
  tenantId: string;
  conversationId: string;
  capsOverride?: Partial<BudgetCaps>;
}

/**
 * Build a fresh per-turn budget. Caps come from env unless overridden in
 * tests. The conversation + tenant lookups happen once on `preflight()`,
 * so callers should invoke it before the first generateResponse() and
 * NOT inside the round loop.
 */
export function createTurnBudget(opts: CreateTurnBudgetOpts): TurnBudget {
  const baseline = getDefaultCaps();
  const caps: BudgetCaps = { ...baseline, ...(opts.capsOverride ?? {}) };
  let tokens = 0;

  return {
    caps,
    preflight: async () => {
      // Cheap "is this conversation already over budget?" check.
      const convoUsed = await sumUsage({ conversationId: opts.conversationId });
      if (convoUsed >= caps.perConversation) {
        throw new BudgetExceededError("conversation", convoUsed, caps.perConversation);
      }
      // 24h rolling tenant total.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const tenantUsed = await sumUsage({ tenantId: opts.tenantId, since });
      if (tenantUsed >= caps.perTenantDaily) {
        throw new BudgetExceededError("tenant_day", tenantUsed, caps.perTenantDaily);
      }
    },
    addUsage: (n: number) => {
      if (Number.isFinite(n) && n > 0) tokens += n;
    },
    exceededTurnCap: () => tokens >= caps.perTurn,
    tokensThisTurn: () => tokens,
  };
}

/**
 * Sum `UsageLog.tokensEquivalent` for the given scope. Resilient to schema
 * drift — falls back to `0` on any unexpected error. The audit doc is
 * the source of truth; budget enforcement is best-effort.
 */
async function sumUsage(scope: { tenantId?: string; conversationId?: string; since?: Date }): Promise<number> {
  try {
    const where: any = {};
    if (scope.tenantId) where.tenantId = scope.tenantId;
    if (scope.conversationId) where.metadata = { path: ["conversationId"], equals: scope.conversationId };
    if (scope.since) where.createdAt = { gte: scope.since };
    // The UsageLog model has `tokensEquivalent`, `promptTokens`, `completionTokens`.
    // We sum `tokensEquivalent` — the denormalized total filled on every
    // aiService completion (there is no `tokensTotal` column).
    const agg = await (prisma as any).usageLog.aggregate({
      where,
      _sum: { tokensEquivalent: true },
    });
    const v = agg?._sum?.tokensEquivalent;
    return typeof v === "number" ? v : 0;
  } catch {
    // Fail-open: never block real conversations because the usage table
    // had a hiccup. The per-turn in-memory cap still catches runaway loops.
    return 0;
  }
}

/**
 * Write an audit row when the budget enforcer aborts a turn. Caller
 * fires-and-forgets; failure here is logged but never throws.
 */
export async function auditBudgetAbort(opts: {
  tenantId: string;
  conversationId?: string;
  scope: "turn" | "conversation" | "tenant_day";
  used: number;
  cap: number;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: opts.tenantId,
        actorType: "system",
        action: `ai.budget.aborted.${opts.scope}`,
        targetType: opts.conversationId ? "conversation" : "tenant",
        targetId: opts.conversationId ?? opts.tenantId,
        metadata: {
          scope: opts.scope,
          tokensUsed: opts.used,
          tokensCap: opts.cap,
          source: "cost-budget",
          ...(opts.details || {}),
        } as any,
      },
    });
  } catch (err) {
    console.error("[cost-budget] audit write failed:", (err as Error)?.message);
  }
}
