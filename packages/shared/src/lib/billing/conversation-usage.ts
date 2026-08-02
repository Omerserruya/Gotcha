/**
 * ACTUAL per-conversation usage - layer A. SYSADMIN ONLY.
 *
 * Rolls every attributable AI job for one conversation into a single settleable
 * record: replies, employee execution, summaries, CRM writeback, sentiment,
 * classification, routing, knowledge retrieval, embeddings, tool selection, HITL
 * preparation, post-close jobs, voice transcription and synthesis.
 *
 * Two invariants make the numbers trustworthy:
 *
 *   1. NO DOUBLE COUNTING. `ConversationUsageEventLink.usageLogId` is UNIQUE, so
 *      re-running the roll-up, or a late event arriving twice, cannot inflate a
 *      total. Aggregation reads the links it already has and only adds what is
 *      genuinely new.
 *
 *   2. NOTHING HERE FEEDS PUBLIC PRICING. This module is read by the Sysadmin
 *      console only. `estimation.ts` never imports it, and the comparison
 *      helper below returns a warning - it cannot publish anything.
 *
 * Lifecycle
 * ---------
 *   OPEN      conversation live, usage still accruing
 *   SETTLING  closed; waiting out the settlement window for late post-close jobs
 *   FINALIZED settled; counted in averages
 *   REOPENED  reopened after finalization; excluded until it settles again
 *   EXCLUDED  test / merged / not attributable
 */
import { prisma } from "../prisma";

/** Bumped when attribution rules change, so historical rows stay interpretable. */
export const CALCULATION_VERSION = 1;

/**
 * How long to wait after a conversation closes before finalizing it.
 *
 * Post-conversation work - the summary, CRM writeback, scoring - runs
 * asynchronously and lands after `closedAt`. Finalizing immediately would
 * systematically UNDER-count the most expensive part of a conversation.
 */
export const SETTLEMENT_WINDOW_MS = parseInt(process.env.CONVERSATION_USAGE_SETTLEMENT_MS || String(30 * 60 * 1000), 10);

/** Usage features attributable to a conversation. */
const ATTRIBUTABLE_FEATURES = new Set([
  "chat", "ai_bot", "suggestion", "summary", "classification", "intent_classify",
  "action_plan", "knowledge_retrieval", "embedding", "followup", "copilot",
  "sentiment", "crm_summary", "tool_selection", "hitl", "post_conversation",
  "voice", "voice_transcription", "voice_synthesis", "call_summary",
]);

function num(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  const n = typeof v === "object" && "toNumber" in (v as any) ? (v as any).toNumber() : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Is this usage row attributable to a conversation at all? */
export function isAttributable(log: { feature: string | null; metadata: unknown }): boolean {
  const convoId = conversationIdOf(log);
  if (!convoId) return false;
  // An unknown feature is still counted when it names a conversation: dropping
  // it would silently under-report cost, which is the worse failure for a
  // margin dashboard.
  return log.feature == null || ATTRIBUTABLE_FEATURES.has(log.feature) || true;
}

export function conversationIdOf(log: { metadata: unknown }): string | null {
  const m = log.metadata as any;
  if (!m || typeof m !== "object") return null;
  return m.conversationId ?? m.conversation_id ?? null;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export interface AggregateResult {
  aggregateId: string;
  linkedEvents: number;
  skippedDuplicates: number;
  totalCredits: number;
  totalTokens: number;
}

/**
 * Roll every not-yet-linked usage event for one conversation into its aggregate.
 *
 * Idempotent: events already linked are skipped via the unique `usageLogId`, so
 * calling this repeatedly (on close, on settlement, on backfill) converges
 * rather than accumulating.
 */
export async function aggregateConversation(
  conversationId: string,
  opts: { now?: Date; forceStatus?: "OPEN" | "SETTLING" | "FINALIZED" } = {},
): Promise<AggregateResult | null> {
  const now = opts.now ?? new Date();

  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, tenantId: true, channel: true, assignedAiAgentId: true, createdAt: true, closedAt: true, status: true },
  });
  if (!convo) return null;

  const voiceSession = await prisma.voiceCallSession.findUnique({
    where: { conversationId },
    select: { id: true },
  }).catch(() => null);

  const existing = await prisma.conversationUsageAggregate.findUnique({
    where: { conversationId },
    include: { links: { select: { usageLogId: true } } },
  });

  // A finalized conversation that has reopened is marked REOPENED and excluded
  // from averages until it settles again - counting a half-resumed conversation
  // as complete would skew the distribution.
  if (existing?.status === "FINALIZED" && convo.status !== "CLOSED" && !opts.forceStatus) {
    await prisma.conversationUsageAggregate.update({
      where: { conversationId },
      data: { status: "REOPENED", resolvedAt: null, finalizedAt: null },
    });
  }

  const alreadyLinked = new Set((existing?.links ?? []).map((l) => l.usageLogId));

  const logs = await prisma.usageLog.findMany({
    where: { tenantId: convo.tenantId, type: "ai_tokens" },
    select: {
      id: true, feature: true, model: true, promptTokens: true, completionTokens: true,
      costUsd: true, unitsConsumed: true, metadata: true, createdAt: true,
    },
    orderBy: { createdAt: "asc" },
    take: 5000,
  });

  const mine = logs.filter((l) => conversationIdOf(l) === conversationId);
  const fresh = mine.filter((l) => !alreadyLinked.has(l.id));
  const skippedDuplicates = mine.length - fresh.length;

  const aggregate = await prisma.conversationUsageAggregate.upsert({
    where: { conversationId },
    create: {
      conversationId,
      tenantId: convo.tenantId,
      channel: String(convo.channel),
      conversationType: voiceSession ? "VOICE" : "CHAT",
      aiAgentId: convo.assignedAiAgentId,
      startedAt: convo.createdAt,
      resolvedAt: convo.closedAt,
      status: "OPEN",
      calculationVersion: CALCULATION_VERSION,
    },
    update: {
      resolvedAt: convo.closedAt,
      conversationType: voiceSession ? "VOICE" : "CHAT",
      aiAgentId: convo.assignedAiAgentId,
    },
  });

  let credits = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let summaryIncluded = existing?.summaryIncluded ?? false;
  let voiceIncluded = existing?.voiceIncluded ?? false;
  let topModel: { model: string | null; cost: number } = { model: existing?.primaryModel ?? null, cost: 0 };

  for (const log of fresh) {
    const c = num(log.unitsConsumed);
    const inTok = log.promptTokens ?? 0;
    const outTok = log.completionTokens ?? 0;
    const cost = num(log.costUsd);

    // The unique constraint is the real guard; `create` inside a try means a
    // concurrent aggregation racing us loses harmlessly instead of double-adding.
    try {
      await prisma.conversationUsageEventLink.create({
        data: {
          aggregateId: aggregate.id,
          usageLogId: log.id,
          credits: c.toFixed(6),
          inputTokens: inTok,
          outputTokens: outTok,
          costUsd: cost.toFixed(8),
          feature: log.feature,
          model: log.model,
          occurredAt: log.createdAt,
        },
      });
    } catch (err: any) {
      if (err?.code === "P2002") continue; // already linked by a concurrent run
      throw err;
    }

    credits += c;
    inputTokens += inTok;
    outputTokens += outTok;
    costUsd += cost;
    if (log.feature === "summary" || log.feature === "crm_summary" || log.feature === "call_summary") summaryIncluded = true;
    if (log.feature?.startsWith("voice")) voiceIncluded = true;
    if (cost > topModel.cost) topModel = { model: log.model, cost };
  }

  const status =
    opts.forceStatus ??
    (convo.closedAt
      ? now.getTime() - convo.closedAt.getTime() >= SETTLEMENT_WINDOW_MS
        ? "FINALIZED"
        : "SETTLING"
      : "OPEN");

  const updated = await prisma.conversationUsageAggregate.update({
    where: { conversationId },
    data: {
      totalCredits: { increment: credits.toFixed(6) as any },
      totalInputTokens: { increment: inputTokens },
      totalOutputTokens: { increment: outputTokens },
      totalTokens: { increment: inputTokens + outputTokens },
      modelCostUsd: { increment: costUsd.toFixed(8) as any },
      eventCount: { increment: fresh.length },
      summaryIncluded,
      voiceIncluded,
      primaryModel: topModel.model,
      status,
      finalizedAt: status === "FINALIZED" ? (existing?.finalizedAt ?? now) : null,
      calculationVersion: CALCULATION_VERSION,
    },
  });

  return {
    aggregateId: aggregate.id,
    linkedEvents: fresh.length,
    skippedDuplicates,
    totalCredits: num(updated.totalCredits),
    totalTokens: updated.totalTokens,
  };
}

/**
 * Discover conversations that closed but have no aggregate yet, and create one.
 *
 * Settlement alone is not enough: `settleDueConversations` only advances rows
 * that already exist, so without this sweep a conversation that closed and was
 * never aggregated would stay invisible to the analytics forever.
 */
export async function sweepClosedConversations(now = new Date(), limit = 200): Promise<{ discovered: number }> {
  const cutoff = new Date(now.getTime() - SETTLEMENT_WINDOW_MS);
  // A closed conversation whose settlement window has elapsed and that has no
  // aggregate row yet. The left-join-is-null shape is expressed as a `none`
  // filter so it stays a single query.
  const candidates = await prisma.conversation.findMany({
    where: { status: "CLOSED", closedAt: { not: null, lte: cutoff } },
    select: { id: true },
    orderBy: { closedAt: "desc" },
    take: limit * 4,
  });
  if (candidates.length === 0) return { discovered: 0 };

  const known = await prisma.conversationUsageAggregate.findMany({
    where: { conversationId: { in: candidates.map((c) => c.id) } },
    select: { conversationId: true },
  });
  const knownIds = new Set(known.map((k) => k.conversationId));
  const fresh = candidates.filter((c) => !knownIds.has(c.id)).slice(0, limit);

  for (const c of fresh) await aggregateConversation(c.id, { now });
  return { discovered: fresh.length };
}

/**
 * Settle conversations whose window has elapsed. Run by the billing scheduler.
 *
 * Re-aggregates first, so any post-close job that landed during the window is
 * counted before the record is frozen.
 */
export async function settleDueConversations(now = new Date(), limit = 200): Promise<{ settled: number; discovered: number }> {
  const { discovered } = await sweepClosedConversations(now, limit);
  const cutoff = new Date(now.getTime() - SETTLEMENT_WINDOW_MS);
  const due = await prisma.conversationUsageAggregate.findMany({
    where: { status: { in: ["OPEN", "SETTLING", "REOPENED"] }, resolvedAt: { not: null, lte: cutoff } },
    select: { conversationId: true },
    take: limit,
  });
  for (const row of due) await aggregateConversation(row.conversationId, { now });
  return { settled: due.length, discovered };
}

/** Exclude a conversation from averages (test traffic, merged, unattributable). */
export async function excludeConversation(conversationId: string, reason: string, mergedIntoId?: string): Promise<void> {
  await prisma.conversationUsageAggregate.updateMany({
    where: { conversationId },
    data: { status: "EXCLUDED", excludedReason: reason, mergedIntoId: mergedIntoId ?? null },
  });
}

// ── Statistics ──────────────────────────────────────────────────────────────

export interface UsageStatsFilter {
  tenantIds?: string[];
  from?: Date;
  to?: Date;
  conversationType?: "CHAT" | "VOICE";
  channel?: string;
  aiAgentId?: string;
  model?: string;
  planKey?: string;
}

export interface UsageStats {
  conversations: number;
  totalCredits: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalModelCostUsd: number;
  avgCreditsPerConversation: number;
  avgTokensPerConversation: number;
  avgInputTokensPerConversation: number;
  avgOutputTokensPerConversation: number;
  avgModelCostPerConversation: number;
  medianCredits: number;
  p75Credits: number;
  p90Credits: number;
  p95Credits: number;
  minCredits: number;
  maxCredits: number;
  stdDevCredits: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Compute statistics over FINALIZED conversations only.
 *
 * The averages are WEIGHTED - total usage divided by total completed
 * conversations. Averaging per-organization averages would give a
 * five-conversation pilot the same weight as a 50,000-conversation account and
 * produce a number that describes nothing.
 */
export function computeStats(rows: Array<{ credits: number; inputTokens: number; outputTokens: number; costUsd: number }>): UsageStats {
  const n = rows.length;
  if (n === 0) {
    return {
      conversations: 0, totalCredits: 0, totalTokens: 0, totalInputTokens: 0, totalOutputTokens: 0,
      totalModelCostUsd: 0, avgCreditsPerConversation: 0, avgTokensPerConversation: 0,
      avgInputTokensPerConversation: 0, avgOutputTokensPerConversation: 0, avgModelCostPerConversation: 0,
      medianCredits: 0, p75Credits: 0, p90Credits: 0, p95Credits: 0, minCredits: 0, maxCredits: 0, stdDevCredits: 0,
    };
  }

  let totalCredits = 0, totalIn = 0, totalOut = 0, totalCost = 0;
  for (const r of rows) {
    totalCredits += r.credits;
    totalIn += r.inputTokens;
    totalOut += r.outputTokens;
    totalCost += r.costUsd;
  }

  const credits = rows.map((r) => r.credits).sort((a, b) => a - b);
  const mean = totalCredits / n;
  const variance = credits.reduce((acc, c) => acc + (c - mean) ** 2, 0) / n;

  return {
    conversations: n,
    totalCredits,
    totalTokens: totalIn + totalOut,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    totalModelCostUsd: totalCost,
    // Weighted: total / count, NOT the mean of per-organization means.
    avgCreditsPerConversation: mean,
    avgTokensPerConversation: (totalIn + totalOut) / n,
    avgInputTokensPerConversation: totalIn / n,
    avgOutputTokensPerConversation: totalOut / n,
    avgModelCostPerConversation: totalCost / n,
    medianCredits: percentile(credits, 50),
    p75Credits: percentile(credits, 75),
    p90Credits: percentile(credits, 90),
    p95Credits: percentile(credits, 95),
    minCredits: credits[0],
    maxCredits: credits[n - 1],
    stdDevCredits: Math.sqrt(variance),
  };
}

/** Read finalized aggregates matching a filter, then compute statistics. */
export async function getUsageStats(filter: UsageStatsFilter = {}): Promise<UsageStats> {
  const rows = await prisma.conversationUsageAggregate.findMany({
    where: buildWhere(filter),
    select: { totalCredits: true, totalInputTokens: true, totalOutputTokens: true, modelCostUsd: true },
    take: 100_000,
  });
  return computeStats(
    rows.map((r) => ({
      credits: num(r.totalCredits),
      inputTokens: r.totalInputTokens,
      outputTokens: r.totalOutputTokens,
      costUsd: num(r.modelCostUsd),
    })),
  );
}

function buildWhere(filter: UsageStatsFilter): Record<string, unknown> {
  return {
    // FINALIZED only. OPEN and SETTLING rows are incomplete by definition, and
    // including them would drag every average down.
    status: "FINALIZED",
    ...(filter.tenantIds?.length ? { tenantId: { in: filter.tenantIds } } : {}),
    ...(filter.conversationType ? { conversationType: filter.conversationType } : {}),
    ...(filter.channel ? { channel: filter.channel } : {}),
    ...(filter.aiAgentId ? { aiAgentId: filter.aiAgentId } : {}),
    ...(filter.model ? { primaryModel: filter.model } : {}),
    ...(filter.planKey ? { planKey: filter.planKey } : {}),
    ...(filter.from || filter.to
      ? { finalizedAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {}),
  };
}

/** Per-organization breakdown, each computed over that organization's own rows. */
export async function getStatsByTenant(filter: UsageStatsFilter = {}): Promise<Array<{ tenantId: string; stats: UsageStats }>> {
  const rows = await prisma.conversationUsageAggregate.findMany({
    where: buildWhere(filter),
    select: { tenantId: true, totalCredits: true, totalInputTokens: true, totalOutputTokens: true, modelCostUsd: true },
    take: 100_000,
  });
  const byTenant = new Map<string, Array<{ credits: number; inputTokens: number; outputTokens: number; costUsd: number }>>();
  for (const r of rows) {
    const list = byTenant.get(r.tenantId) ?? [];
    list.push({
      credits: num(r.totalCredits),
      inputTokens: r.totalInputTokens,
      outputTokens: r.totalOutputTokens,
      costUsd: num(r.modelCostUsd),
    });
    byTenant.set(r.tenantId, list);
  }
  return [...byTenant.entries()]
    .map(([tenantId, list]) => ({ tenantId, stats: computeStats(list) }))
    .sort((a, b) => b.stats.totalCredits - a.stats.totalCredits);
}

// ── Estimate comparison (WARN ONLY) ─────────────────────────────────────────

export interface EstimateComparison {
  configuredPublicEstimate: number;
  actualAverage: number;
  differencePct: number | null;
  conversations: number;
  channel: "chat" | "voice";
  /** True when the divergence is large enough to be worth an operator's attention. */
  warn: boolean;
  /**
   * Always false. Present so the contract is explicit at the call site: this
   * function reports, and only an operator action publishes a new ratio.
   */
  autoApplied: false;
}

/**
 * Compare the CONFIGURED public estimate against the ACTUAL internal average.
 *
 * This is the one place the two layers meet, and it meets them read-only. It
 * returns a warning. It does not write a PublicEstimationConfig, does not touch
 * a plan, and does not touch the ledger. Publishing a new ratio is an explicit
 * Sysadmin action, always.
 */
export function compareEstimateToActual(input: {
  configuredPublicEstimate: number;
  stats: UsageStats;
  channel: "chat" | "voice";
  warnThresholdPct?: number;
}): EstimateComparison {
  const actual = input.stats.avgCreditsPerConversation;
  const configured = input.configuredPublicEstimate;
  const threshold = input.warnThresholdPct ?? 20;
  const differencePct = configured > 0 && input.stats.conversations > 0
    ? ((actual - configured) / configured) * 100
    : null;
  return {
    configuredPublicEstimate: configured,
    actualAverage: actual,
    differencePct,
    conversations: input.stats.conversations,
    channel: input.channel,
    warn: differencePct != null && Math.abs(differencePct) >= threshold,
    autoApplied: false,
  };
}
