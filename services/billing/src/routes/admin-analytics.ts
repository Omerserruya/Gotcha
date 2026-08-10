/**
 * Sysadmin ACTUAL usage analytics + evaluation (POC/Trial) provisioning.
 *
 * Everything on this router is layer A: real credits, real tokens, real model
 * cost. It is platform-tier only and must never be reachable by a tenant user.
 *
 * The comparison endpoint is the one place where actual usage meets the public
 * commercial estimate, and it meets it READ-ONLY: it returns a warning. Nothing
 * here writes a PublicEstimationConfig. Publishing a new ratio is an explicit
 * action on the pricing router.
 *
 * Conversation CONTENT is deliberately absent - this is cost attribution, not a
 * transcript viewer. Reading conversation text needs a separate authorized
 * support or security path.
 */
import { Router } from "express";
import {
  authenticate,
  requirePlatformPermission,
  PLATFORM_PERMISSIONS,
  prisma,
  withCrossTenantAccess,
  writeAudit,
  getUsageStats,
  getStatsByTenant,
  compareEstimateToActual,
  settleDueConversations,
  aggregateConversation,
  getGlobalEstimation,
  type UsageStatsFilter,
} from "@chatcenter/shared";
import { setupEvaluation, listEvaluationTemplates, convertEvaluationToPaid } from "../services/evaluation.service";

const router = Router();
const P = PLATFORM_PERMISSIONS;

function parseFilter(q: any): UsageStatsFilter {
  const tenantIds = q.tenantIds
    ? String(q.tenantIds).split(",").map((s: string) => s.trim()).filter(Boolean)
    : q.tenantId
      ? [String(q.tenantId)]
      : undefined;
  return {
    tenantIds,
    from: q.from ? new Date(String(q.from)) : undefined,
    to: q.to ? new Date(String(q.to)) : undefined,
    conversationType: q.type === "VOICE" || q.type === "CHAT" ? q.type : undefined,
    channel: q.channel ? String(q.channel) : undefined,
    aiAgentId: q.aiAgentId ? String(q.aiAgentId) : undefined,
    model: q.model ? String(q.model) : undefined,
    planKey: q.planKey ? String(q.planKey) : undefined,
  };
}

/**
 * Global or filtered actual conversation cost.
 *
 * The averages are WEIGHTED (total usage / total completed conversations).
 * Averaging per-organization averages would let a five-conversation pilot count
 * as much as a 50,000-conversation account.
 */
router.get("/admin/analytics/conversation-costs", authenticate, requirePlatformPermission(P.USAGE_ANALYTICS_READ), async (req, res) => {
  const filter = parseFilter(req.query);
  const stats = await getUsageStats(filter);
  res.json({
    filter: {
      tenantIds: filter.tenantIds ?? null,
      from: filter.from ?? null,
      to: filter.to ?? null,
      conversationType: filter.conversationType ?? null,
      channel: filter.channel ?? null,
      planKey: filter.planKey ?? null,
    },
    stats,
    // Stated on the payload so a dashboard cannot quietly present a
    // mean-of-means as the platform average.
    averageMethod: "weighted: total usage / total completed conversations",
    scope: "FINALIZED conversations only",
  });
});

/** Per-organization breakdown. Each row is that organization's own weighted average. */
router.get("/admin/analytics/conversation-costs/by-tenant", authenticate, requirePlatformPermission(P.USAGE_ANALYTICS_READ), async (req, res) => {
  const filter = parseFilter(req.query);
  const rows = await getStatsByTenant(filter);
  const tenantIds = rows.map((r) => r.tenantId);
  const tenants = await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } });
  const nameOf = new Map(tenants.map((t) => [t.id, t.name]));

  const global = await getUsageStats(filter);
  res.json({
    tenants: rows.map((r) => ({ tenantId: r.tenantId, name: nameOf.get(r.tenantId) ?? r.tenantId, stats: r.stats })),
    global,
    // The two are not the same number, and the difference is the point.
    note: "`global` is the weighted platform average, not the mean of the per-organization averages below it.",
  });
});

/**
 * Configured public estimate vs actual internal average.
 *
 * Returns a warning and nothing else. `autoApplied` is always false, and no
 * write happens on this path - only an explicit publish on the pricing router
 * changes what customers see.
 */
router.get("/admin/analytics/estimate-vs-actual", authenticate, requirePlatformPermission(P.USAGE_ANALYTICS_READ), async (req, res) => {
  const filter = parseFilter(req.query);
  const ratios = await getGlobalEstimation();

  const [chatStats, voiceStats] = await Promise.all([
    getUsageStats({ ...filter, conversationType: "CHAT" }),
    getUsageStats({ ...filter, conversationType: "VOICE" }),
  ]);

  const warnThresholdPct = req.query.warnThresholdPct ? Number(req.query.warnThresholdPct) : 20;

  res.json({
    chat: compareEstimateToActual({
      configuredPublicEstimate: ratios.chatCreditsPerEstimatedConversation,
      stats: chatStats,
      channel: "chat",
      warnThresholdPct,
    }),
    voice: compareEstimateToActual({
      configuredPublicEstimate: ratios.voiceCreditsPerEstimatedCall,
      stats: voiceStats,
      channel: "voice",
      warnThresholdPct,
    }),
    estimationVersion: ratios.version,
    guarantee:
      "This comparison is advisory. Actual usage never updates the public estimate; only an explicit publish on /admin/pricing/estimation does.",
  });
});

/** Force settlement of due conversations (ops). Idempotent. */
router.post("/admin/analytics/settle", authenticate, requirePlatformPermission(P.USAGE_ANALYTICS_READ), async (req, res) => {
  const result = await settleDueConversations(new Date(), Number(req.body?.limit ?? 200));
  res.json({ ok: true, ...result });
});

/**
 * Backfill aggregates for conversations that closed before aggregation existed.
 *
 * Idempotent through the unique usageLogId link, so a partial run can simply be
 * re-run rather than needing a reset.
 */
router.post("/admin/analytics/backfill", authenticate, requirePlatformPermission(P.USAGE_ANALYTICS_READ), async (req, res) => {
  const limit = Math.min(1000, Number(req.body?.limit ?? 200));
  const tenantId = req.body?.tenantId ? String(req.body.tenantId) : undefined;

  const existing = await prisma.conversationUsageAggregate.findMany({ select: { conversationId: true }, take: 100_000 });
  const known = new Set(existing.map((e) => e.conversationId));

  // `tenantId` is OPTIONAL on this route - omitting it means "backfill the whole
  // platform", and that shape has no tenantId for the TenantGuard to find. The
  // route is already behind authenticate + USAGE_ANALYTICS_READ, which is the
  // authorization the guard is a backstop for.
  const conversations = await withCrossTenantAccess(() =>
    prisma.conversation.findMany({
      where: { ...(tenantId ? { tenantId } : {}), id: { notIn: [...known].slice(0, 30_000) } },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  );

  let processed = 0;
  let linked = 0;
  for (const c of conversations) {
    const r = await aggregateConversation(c.id);
    if (r) {
      processed++;
      linked += r.linkedEvents;
    }
  }
  await writeAudit({
    tenantId: "platform", actorType: "user", actorId: req.user?.userId ?? null,
    action: "analytics.backfill", targetType: "conversation_usage", targetId: null,
    metadata: { processed, linked, platformPermission: req.platformPermission },
  }).catch(() => {});
  res.json({ ok: true, processed, linkedEvents: linked, remaining: Math.max(0, conversations.length - processed) });
});

// ── POC / Trial provisioning ────────────────────────────────────────────────

router.get("/admin/evaluation/templates", authenticate, requirePlatformPermission(P.POC_CREATE), async (_req, res) => {
  res.json({ templates: await listEvaluationTemplates() });
});

/**
 * Provision evaluation access. Sysadmin only - there is no customer
 * self-activation path anywhere in the system.
 */
router.post("/admin/evaluation", authenticate, requirePlatformPermission(P.POC_CREATE), async (req, res) => {
  const { tenantId, templateKey, credits, durationDays, note } = req.body ?? {};
  if (!tenantId || !templateKey) return res.status(400).json({ error: "tenantId and templateKey required" });
  try {
    const result = await setupEvaluation({
      tenantId: String(tenantId),
      templateKey: String(templateKey),
      creditsOverride: credits != null ? Number(credits) : undefined,
      durationDaysOverride: durationDays != null ? Number(durationDays) : undefined,
      actor: req.user?.userId,
      note,
    });
    await writeAudit({
      tenantId: String(tenantId), actorType: "user", actorId: req.user?.userId ?? null,
      action: "billing.evaluation_created", targetType: "subscription", targetId: result.subscriptionId,
      metadata: { templateKey, credits: result.credits, expiresAt: result.expiresAt, platformPermission: req.platformPermission },
    }).catch(() => {});
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "evaluation_failed" });
  }
});

/** Convert an evaluation into a paid plan. Manual, never automatic. */
router.post("/admin/evaluation/convert", authenticate, requirePlatformPermission(P.POC_CREATE), async (req, res) => {
  const { tenantId, planKey } = req.body ?? {};
  if (!tenantId || !planKey) return res.status(400).json({ error: "tenantId and planKey required" });
  try {
    const result = await convertEvaluationToPaid({
      tenantId: String(tenantId),
      planKey: String(planKey),
      actor: req.user?.userId,
    });
    await writeAudit({
      tenantId: String(tenantId), actorType: "user", actorId: req.user?.userId ?? null,
      action: "billing.evaluation_converted", targetType: "subscription", targetId: null,
      metadata: { ...result, platformPermission: req.platformPermission },
    }).catch(() => {});
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "convert_failed" });
  }
});

export default router;
