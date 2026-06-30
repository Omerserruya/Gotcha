/**
 * Plan Context Assembly — the single source of truth for the per-turn inputs the
 * Action Planner (`computeCurrentPlan` via `buildAgentPrompt`) consumes.
 *
 * The AI Employee (executes) and the AI Copilot (recommends) are ONE brain with
 * two execution modes. The reasoning — goal, objective, situation, best next
 * action, capabilities — must be derived IDENTICALLY for both. This module owns
 * the four per-turn derivations that feed the planner so neither caller computes
 * them inline:
 *
 *   1. completedActionTools — action tools that already SUCCEEDED this
 *      conversation (drives action-complete objectives like BOOK_MEETING).
 *   2. priorGoal            — the goal committed last turn (Goal Ownership,
 *      resumed per-customer across their conversations).
 *   3. wizardFacts          — the structured wizard→runtime binding (goal /
 *      qualification / fit) the objective engine consumes.
 *   4. toolCapabilityHints  — integration tool → Integration.category, so the
 *      Capability Layer groups tools by their real domain.
 *
 * `crmFlags`, `calendarBookable` and `hasActiveBooking` are resolved by the
 * caller's CONTEXT layer (CRM prefetch, calendar capability, booking store) and
 * passed in — both modes already have them and re-resolving here would duplicate
 * that work. This function performs no LLM call beyond the wizard binding and is
 * fully fail-soft: every derivation degrades to an empty/neutral value.
 */

import { prisma } from "@chatcenter/shared";
import { evaluateWizardBinding } from "./wizard-binding.service";
import type { ActiveGoalSnapshot, WizardRuntimeFacts } from "./objectives";
import type { CrmStateFlags } from "./prospect-state";

// Local copy of the "tool succeeded" probe (ai-bot.service.ts keeps its own for
// the many other call sites). A primitive constant, not assembly logic.
const TOOL_OK_RE = /"ok"\s*:\s*true/;

/**
 * Action tools that already SUCCEEDED in this conversation. Reads the per-turn
 * `ai.bot_turn` audits' `toolCalls[]` (NOT the per-tool `ai.tool_call.X` rows):
 * the bot_turn log captures EVERY execution including tools that ran on a
 * retry/regen path (decision="executed_on_retry"), which the per-tool audit
 * misses. A booking that landed on retry must still count as committed, or
 * BOOK_MEETING would re-activate next turn and double-book.
 */
export async function loadCommittedActionTools(tenantId: string, conversationId: string): Promise<string[]> {
  try {
    const rows = await prisma.auditLog.findMany({
      where: { tenantId, targetId: conversationId, action: "ai.bot_turn" },
      select: { metadata: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const out = new Set<string>();
    for (const r of rows) {
      const calls = (r.metadata as any)?.toolCalls;
      if (!Array.isArray(calls)) continue;
      for (const c of calls) {
        const decision = String(c?.decision ?? "");
        if ((decision === "executed" || decision === "executed_on_retry") && TOOL_OK_RE.test(String(c?.result ?? ""))) {
          const tool = String(c?.tool ?? "");
          if (tool) out.add(tool);
        }
      }
    }
    return [...out];
  } catch (err: any) {
    console.warn("[plan-context] committed-action-tools load failed (non-fatal):", err?.message);
    return [];
  }
}

/**
 * GOAL OWNERSHIP (Unit A). Reload the goal the agent committed to on the most
 * recent turn from the `ai.bot_turn` audit metadata (`activeGoal`). Lets
 * `commitObjective` carry the objective across turns so a transient fact loss
 * can't regress it. Fail-soft → null (stateless first-incomplete selection).
 *
 * PER-CUSTOMER GOAL CONTINUITY: a goal belongs to the relationship, not the
 * thread. When the customer's identity is known, resume the most recent
 * meaningful goal across ALL their conversations so a returning customer in a
 * NEW conversation picks up where they left off instead of restarting. Falls
 * back to the current conversation when identity is absent. Bounded by a recency
 * window so a months-old goal doesn't haunt a fresh intent.
 */
export async function loadCommittedGoal(
  tenantId: string,
  conversationId: string,
  customer?: { channel: string; externalId: string | null | undefined },
): Promise<ActiveGoalSnapshot | null> {
  try {
    let conversationIds: string[] = [conversationId];
    if (customer?.externalId) {
      const RESUME_WINDOW_DAYS = 14;
      const since = new Date(Date.now() - RESUME_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const convs = await prisma.conversation.findMany({
        where: {
          tenantId,
          channel: customer.channel as any,
          customerExternalId: customer.externalId,
          updatedAt: { gte: since },
        },
        select: { id: true },
        orderBy: { lastMessageAt: "desc" },
        take: 20,
      });
      conversationIds = [...new Set([conversationId, ...convs.map((c) => c.id)])];
    }
    // Latest turns across the customer's conversations; pick the most recent one
    // that actually carries a committed goal (a completed-then-empty turn has
    // none — keep looking back so we resume the last MEANINGFUL goal).
    const rows = await prisma.auditLog.findMany({
      where: { tenantId, targetId: { in: conversationIds }, action: "ai.bot_turn" },
      select: { metadata: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    for (const row of rows) {
      const g = (row?.metadata as any)?.activeGoal;
      if (!g || typeof g !== "object" || typeof g.objectiveId !== "string") continue;
      return {
        objectiveId: g.objectiveId,
        stepIndex: Number.isFinite(g.stepIndex) ? g.stepIndex : 0,
        achieved: Array.isArray(g.achieved) ? g.achieved.map(String) : [],
        missingRequired: Array.isArray(g.missingRequired) ? g.missingRequired.map(String) : [],
        stalledTurns: Number.isFinite(g.stalledTurns) ? g.stalledTurns : 0,
      };
    }
    return null;
  } catch (err: any) {
    console.warn("[plan-context] committed-goal load failed (non-fatal):", err?.message);
    return null;
  }
}

/**
 * Build the toolName → Integration.category map for the Capability Layer, so
 * integration tools group under their real domain (CRM, HELPDESK, …) instead of
 * the CUSTOM fallback. Generic + data-driven: read straight from
 * AgentToolPermission → CatalogTool → Integration.category. Built-ins don't need
 * a hint (they carry their own capability). Fail-soft → {} (built-in grouping
 * still works). Integration tools are surfaced as `integration_<slug>`.
 */
export async function loadToolCapabilityHints(
  tenantId: string,
  aiAgentId: string | null | undefined,
): Promise<Record<string, string>> {
  if (!aiAgentId) return {};
  try {
    const rows: any[] = await (prisma as any).agentToolPermission.findMany({
      where: { tenantId, aiAgentId, isAllowed: true },
      select: {
        tenantTool: {
          select: { catalogTool: { select: { slug: true, integration: { select: { category: true } } } } },
        },
      },
    });
    const hints: Record<string, string> = {};
    for (const r of rows) {
      const ct = r?.tenantTool?.catalogTool;
      const cat = ct?.integration?.category;
      if (ct?.slug && cat) hints[`integration_${ct.slug}`] = String(cat);
    }
    return hints;
  } catch (err: any) {
    console.warn("[plan-context] loadToolCapabilityHints failed (non-fatal):", err?.message);
    return {};
  }
}

/** Resolved context blocks the wizard transcript is built from. */
export interface PlanContextBlocks {
  customerBlock?: string;
  crmBlock?: string;
  memoryBlock?: string;
  sessionFactsBlock?: string;
}

export interface AssemblePlanContextInput {
  tenantId: string;
  conversationId: string;
  /** Agent role → objective chain. */
  role: string;
  /** AI agent id → tool capability hints. */
  agentId: string | null | undefined;
  /** Agent's configured free-text goal (wizard binding input). */
  goal?: string | null;
  /** Agent's sales/qualification context (wizard binding input). */
  salesContext?: unknown;
  /** Customer identity → per-customer goal continuity. */
  customer: { channel: string; externalId: string | null | undefined };
  /** CRM presence flags resolved by the caller's CRM prefetch. Echoed through. */
  crmFlags: CrmStateFlags;
  /** Resolved context blocks → wizard transcript. */
  contextBlocks: PlanContextBlocks;
  /** Conversation messages → wizard transcript (last turns). */
  messages: Array<{ direction: string; body?: string | null }>;
  signal?: AbortSignal;
}

/** Everything the planner needs that's DERIVED per turn (no LLM beyond wizard). */
export interface AssembledPlanContext {
  crmFlags: CrmStateFlags;
  completedActionTools: string[];
  priorGoal: ActiveGoalSnapshot | null;
  wizardFacts: WizardRuntimeFacts;
  toolCapabilityHints: Record<string, string>;
}

/**
 * Assemble the per-turn plan context ONCE for both the Employee and the Copilot.
 * Faithful aggregation of the four derivations above — no business decisions, no
 * mode branching. Both callers feed the result into `buildAgentPrompt` (which
 * runs `computeCurrentPlan`) so the rendered `# Current Plan` is identical.
 */
export async function assemblePlanContext(input: AssemblePlanContextInput): Promise<AssembledPlanContext> {
  // Cross-turn action completion — which action tools already SUCCEEDED.
  const completedActionTools = await loadCommittedActionTools(input.tenantId, input.conversationId);

  // Goal Ownership (Unit A): the goal committed last turn, resumed per-customer.
  const priorGoal = await loadCommittedGoal(input.tenantId, input.conversationId, input.customer);

  // Wizard → Runtime binding: the single structured evaluation step. Converts the
  // agent's free-text config + this conversation into typed facts the objective
  // engine / readiness / recovery / prioritization consume. One judgment call per
  // turn; skipped (no cost) when the agent has no bindable config; fail-safe to
  // EMPTY facts.
  const wizardTranscript = [
    input.contextBlocks.customerBlock,
    input.contextBlocks.crmBlock,
    input.contextBlocks.memoryBlock,
    input.contextBlocks.sessionFactsBlock,
    ...input.messages
      .filter((m) => m.body?.trim())
      .slice(-12)
      .map((m) => `${m.direction === "INBOUND" ? "Customer" : "Agent"}: ${m.body}`),
  ]
    .filter((s): s is string => !!s && !!s.trim())
    .join("\n");
  const wizardFacts: WizardRuntimeFacts = await evaluateWizardBinding({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    role: input.role,
    goal: input.goal ?? null,
    salesContext: input.salesContext as any,
    transcript: wizardTranscript,
    signal: input.signal,
  });

  // Capability Layer hints: integration tool → Integration.category.
  const toolCapabilityHints = await loadToolCapabilityHints(input.tenantId, input.agentId);

  return {
    crmFlags: input.crmFlags,
    completedActionTools,
    priorGoal,
    wizardFacts,
    toolCapabilityHints,
  };
}
