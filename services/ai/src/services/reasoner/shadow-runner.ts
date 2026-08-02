/**
 * Shadow runner - per turn, compute the Reasoner's decision over the SAME Oracle
 * Facts, compare it to the (production-driving) Planner's decision, and persist a
 * row of the permanent evaluation corpus.
 *
 * SAFETY: this is dark. It runs only when AGENT_ARCHITECTURE_ENABLED=true, is
 * fire-and-forget, and is fully try/caught - it can NEVER affect the live turn
 * (the Planner still drives; the Reasoner never executes anything here).
 *
 * PROVIDER-NEUTRAL: it persists only neutral data (ReasonerInput, canonical
 * decisions, neutral usage). No OpenAI request/response ever reaches this layer -
 * that stays behind the ReasonerProvider boundary.
 */

import {
  prisma,
  compareDecisions,
  plannerMoveToDecision,
  isAgentArchitectureEnabled,
  SHADOW_EVAL_SCHEMA_VERSION,
  EMPTY_AGENT_MEMORY,
  type PlannerMove,
  type ReasonerInput,
  type Context,
  type AgentMemory,
  type ShadowEvalRecord,
  type DivergenceAxis,
  type AvailableOperation,
} from "@chatcenter/shared";
import { getReasonerProvider } from "./index";
import { computeFacts, type TurnSignals } from "./oracle-producer";

/**
 * Both sides must speak the SAME vocabulary or the corpus shows false
 * divergence: the Planner emits TOOLS (schedule_meeting), the Reasoner emits
 * OPERATIONS (BOOK_MEETING). This first-pass map aligns the known pilot tools;
 * unknown names pass through unchanged (refined against the first corpus rows).
 */
const TOOL_TO_OPERATION: Record<string, string> = {
  schedule_meeting: "BOOK_MEETING",
  reschedule_meeting: "MOVE_MEETING",
  cancel_meeting: "CANCEL_MEETING",
  check_availability: "CHECK_AVAILABILITY",
  integration_create_lead: "UPSERT_CUSTOMER",
  integration_create_contact: "UPSERT_CUSTOMER",
  integration_create_deal: "CREATE_DEAL",
  escalate_to_human: "ESCALATE",
};
function toOperation(tool: string | undefined): string {
  if (!tool) return "";
  return TOOL_TO_OPERATION[tool] ?? tool;
}

/** The reasoning prompt/strategy version - the key regression axis in the corpus. */
export const PROMPT_VERSION = "reasoner-v0.1";

export interface ShadowTurnContext {
  tenantId: string;
  conversationId: string;
  turnId: string;
  agentId?: string;
  sessionId?: string;
  /** Live signals for the Oracle. */
  turnSignals: TurnSignals;
  /** Interpretive material (transcript, mission, guidance, catalog, brand). */
  context: Context;
  /** Advisory continuity. */
  memory: AgentMemory;
  /** The Planner's chosen move this turn (mapped into the canonical vocabulary). */
  plannerMove: PlannerMove;
  /** What actually executed on the live turn, if known (for correlation). */
  executedOperation?: string;
  runtimeResult?: string;
  signal?: AbortSignal;
}

/** Fire-and-forget entry point. Safe to call unconditionally from the live turn. */
export function runShadowEvaluationInBackground(ctx: ShadowTurnContext): void {
  if (!isAgentArchitectureEnabled()) return;
  void runShadowEvaluation(ctx).catch((e) =>
    console.warn("[reasoner-shadow] evaluation failed:", e?.message ?? e),
  );
}

async function runShadowEvaluation(ctx: ShadowTurnContext): Promise<void> {
  const facts = await computeFacts(ctx.tenantId, ctx.turnSignals);
  const input: ReasonerInput = { facts, context: ctx.context, memory: ctx.memory };

  const provider = getReasonerProvider();
  const res = await provider.reason(input, {
    context: { tenantId: ctx.tenantId, conversationId: ctx.conversationId, sessionId: ctx.sessionId },
    signal: ctx.signal,
  });

  const plannerDecision = plannerMoveToDecision(ctx.plannerMove);
  const reasonerDecision = res.output.decision;
  const divergence = compareDecisions(plannerDecision, reasonerDecision);

  const record: ShadowEvalRecord = {
    schemaVersion: SHADOW_EVAL_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    tenantId: ctx.tenantId,
    conversationId: ctx.conversationId,
    turnId: ctx.turnId,
    agentId: ctx.agentId,
    reasonerInput: input,
    plannerDecision,
    reasonerDecision,
    divergence,
    executedOperation: ctx.executedOperation,
    runtimeResult: ctx.runtimeResult,
    provider: provider.name,
    model: provider.model,
    promptVersion: PROMPT_VERSION,
    latencyMs: res.usage?.latencyMs,
    inputTokens: res.usage?.inputTokens,
    outputTokens: res.usage?.outputTokens,
    reasoningTrace: res.output.read.rationale,
  };
  await persistShadowEval(record);
}

/** Provider-neutral persistence into the permanent corpus. */
export async function persistShadowEval(r: ShadowEvalRecord): Promise<void> {
  await (prisma as any).reasonerShadowEval.create({
    data: {
      schemaVersion: r.schemaVersion,
      tenantId: r.tenantId,
      conversationId: r.conversationId,
      turnId: r.turnId,
      agentId: r.agentId,
      reasonerInput: r.reasonerInput as any,
      plannerDecision: r.plannerDecision as any,
      reasonerDecision: r.reasonerDecision as any,
      agree: r.divergence.agree,
      moveTypeMatch: r.divergence.moveTypeMatch,
      detailMatch: r.divergence.detailMatch,
      divergenceAxis: r.divergence.axis,
      executedOperation: r.executedOperation,
      runtimeResult: r.runtimeResult,
      finalBusinessOutcome: r.finalBusinessOutcome,
      provider: r.provider,
      model: r.model,
      promptVersion: r.promptVersion,
      latencyMs: r.latencyMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      reasoningTrace: r.reasoningTrace,
      metadata: r.metadata as any,
    },
  });
}

// ── Agreement dashboard (query over the corpus) ─────────────────────────────

export interface AgreementSummary {
  total: number;
  agreementRate: number;
  byAxis: Record<DivergenceAxis, number>;
  avgLatencyMs: number | null;
}

// ── Bridge from a Planner turn → ShadowTurnContext (loose types, decoupled) ──

/** The minimal, decoupled fields the live turn passes in (no Planner imports). */
export interface PlannerTurnInputs {
  tenantId: string;
  conversationId: string;
  turnId: string;
  sessionId?: string;
  agentId?: string;
  /** The Planner's chosen candidate (kind + tool/field), or null for "just talk". */
  bestNextAction?: { kind: "act" | "propose" | "ask" | "escalate"; tool?: string; field?: string } | null;
  prospectFlags?: { hasLead?: boolean; hasContact?: boolean; hasOpportunity?: boolean };
  toolFunctionNames?: string[];
  calendarBookable?: boolean;
  hasActiveBooking?: boolean;
  activeBookingWhen?: string;
  transcript?: { role: "customer" | "agent" | "system"; text: string }[];
  goalOutcome?: string;
  guidance?: string;
}

/** Build a ShadowTurnContext from a Planner turn. Pure; never throws. */
export function toShadowContext(p: PlannerTurnInputs): ShadowTurnContext {
  const operations = Array.from(new Set((p.toolFunctionNames ?? []).map(toOperation).filter(Boolean)));
  const availableOperations: AvailableOperation[] = operations.map((name) => ({ name, meaning: name, params: [] }));

  const plannerMove: PlannerMove = p.bestNextAction
    ? {
        kind: p.bestNextAction.kind,
        operation: toOperation(p.bestNextAction.tool),
        field: p.bestNextAction.field,
      }
    : { kind: "none" };

  const context: Context = {
    transcript: p.transcript ?? [],
    mission: { goalOutcome: p.goalOutcome },
    guidance: p.guidance,
    operationCatalog: availableOperations.map((o) => ({ name: o.name, meaning: o.meaning })),
  };

  const turnSignals: TurnSignals = {
    customer: { knownFields: {}, identityResolved: false },
    crm: {
      hasLead: !!p.prospectFlags?.hasLead,
      hasContact: !!p.prospectFlags?.hasContact,
      hasOpportunity: !!p.prospectFlags?.hasOpportunity,
    },
    scheduling: {
      activeBooking: p.hasActiveBooking ? { when: p.activeBookingWhen ?? "", ref: "active" } : undefined,
      calendarConnected: p.calendarBookable !== false,
      bookable: p.calendarBookable !== false,
    },
    permissions: { allowedOperations: operations },
    availableOperations,
  };

  return {
    tenantId: p.tenantId,
    conversationId: p.conversationId,
    turnId: p.turnId,
    agentId: p.agentId,
    sessionId: p.sessionId,
    turnSignals,
    context,
    memory: EMPTY_AGENT_MEMORY as AgentMemory,
    plannerMove,
  };
}

/** Aggregate agreement over the corpus, sliced by the eval axes. */
export async function getAgreementSummary(opts?: {
  tenantId?: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
  since?: Date;
}): Promise<AgreementSummary> {
  const where: Record<string, unknown> = {};
  if (opts?.tenantId) where.tenantId = opts.tenantId;
  if (opts?.provider) where.provider = opts.provider;
  if (opts?.model) where.model = opts.model;
  if (opts?.promptVersion) where.promptVersion = opts.promptVersion;
  if (opts?.since) where.createdAt = { gte: opts.since };

  const rows: Array<{ agree: boolean; divergenceAxis: string; latencyMs: number | null }> =
    await (prisma as any).reasonerShadowEval.findMany({
      where,
      select: { agree: true, divergenceAxis: true, latencyMs: true },
    });

  const byAxis: Record<DivergenceAxis, number> = { none: 0, move_type: 0, operation: 0, field: 0 };
  let agreed = 0;
  let latSum = 0;
  let latN = 0;
  for (const r of rows) {
    if (r.agree) agreed++;
    if (r.divergenceAxis in byAxis) byAxis[r.divergenceAxis as DivergenceAxis]++;
    if (typeof r.latencyMs === "number") { latSum += r.latencyMs; latN++; }
  }
  const total = rows.length;
  return {
    total,
    agreementRate: total ? agreed / total : 1,
    byAxis,
    avgLatencyMs: latN ? Math.round(latSum / latN) : null,
  };
}

// ── Divergence review feed (the evidence a human reviews before promoting) ───

/** One divergence row - enough to judge without loading the full input blob. */
export interface DivergenceRow {
  id: string;
  createdAt: string;
  conversationId: string;
  turnId: string;
  divergenceAxis: string;
  plannerDecision: unknown;
  reasonerDecision: unknown;
  reasoningTrace: string | null;
  executedOperation: string | null;
  runtimeResult: string | null;
  finalBusinessOutcome: string | null;
  provider: string;
  model: string;
  promptVersion: string;
}

/**
 * Recent DISAGREEMENTS for a tenant, newest first - the review queue. Tenant-
 * scoped by contract (never cross-tenant). `axis` narrows to one bucket.
 */
export async function listRecentDivergences(opts: {
  tenantId: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
  axis?: DivergenceAxis;
  since?: Date;
  limit?: number;
}): Promise<DivergenceRow[]> {
  const where: Record<string, unknown> = { tenantId: opts.tenantId, agree: false };
  if (opts.provider) where.provider = opts.provider;
  if (opts.model) where.model = opts.model;
  if (opts.promptVersion) where.promptVersion = opts.promptVersion;
  if (opts.axis) where.divergenceAxis = opts.axis;
  if (opts.since) where.createdAt = { gte: opts.since };

  const rows: any[] = await (prisma as any).reasonerShadowEval.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
    select: {
      id: true,
      createdAt: true,
      conversationId: true,
      turnId: true,
      divergenceAxis: true,
      plannerDecision: true,
      reasonerDecision: true,
      reasoningTrace: true,
      executedOperation: true,
      runtimeResult: true,
      finalBusinessOutcome: true,
      provider: true,
      model: true,
      promptVersion: true,
    },
  });

  return rows.map((r) => ({
    id: r.id,
    createdAt: (r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt)),
    conversationId: r.conversationId,
    turnId: r.turnId,
    divergenceAxis: r.divergenceAxis,
    plannerDecision: r.plannerDecision,
    reasonerDecision: r.reasonerDecision,
    reasoningTrace: r.reasoningTrace ?? null,
    executedOperation: r.executedOperation ?? null,
    runtimeResult: r.runtimeResult ?? null,
    finalBusinessOutcome: r.finalBusinessOutcome ?? null,
    provider: r.provider,
    model: r.model,
    promptVersion: r.promptVersion,
  }));
}

/**
 * The FULL corpus record incl. the replayable `reasonerInput` - for deep review
 * of one turn and for replaying it against a future model. Tenant-scoped; returns
 * null if not found under this tenant.
 */
export async function getShadowEvalById(tenantId: string, id: string): Promise<any | null> {
  return (prisma as any).reasonerShadowEval.findFirst({ where: { id, tenantId } });
}
