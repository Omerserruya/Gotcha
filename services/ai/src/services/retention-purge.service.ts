/**
 * Data-retention purge (GDPR Art. 5(1)(e) storage limitation).
 *
 * Two layers of policy, one purge engine:
 *   1. Per-tenant `DataRetentionPolicy` rows (admin-configured) - authoritative
 *      when present.
 *   2. Platform DEFAULTS from environment variables - applied to every tenant
 *      that has NO enabled policy row for that category, so retention actually
 *      has teeth without requiring every tenant to configure it:
 *        RETENTION_DEFAULT_MESSAGES_DAYS
 *        RETENTION_DEFAULT_USAGE_LOGS_DAYS
 *        RETENTION_DEFAULT_AUDIT_LOGS_DAYS
 *        RETENTION_DEFAULT_BILLING_WEBHOOK_EVENTS_DAYS
 *        RETENTION_DEFAULT_REASONER_SHADOW_EVALS_DAYS
 *      Unset/empty = no default limit for that category (pre-GDPR behavior).
 *
 * Never throws out of the loop - one bad/unknown policy is logged and skipped
 * so the rest still run. Each processed policy gets its `lastPurgeAt` bumped
 * and a system audit event recorded.
 *
 * SCHEDULING: `startRetentionScheduler()` (called from index.ts) registers a
 * repeatable BullMQ job - cron from RETENTION_PURGE_CRON (default daily at
 * 03:30), kill-switch RETENTION_PURGE_ENABLED=false. The internal
 * /api/gdpr-internal/run-retention-purge endpoint remains for manual runs.
 */

import { Queue } from "bullmq";
import { prisma, createWorker, auditSystem, AuditAction } from "@chatcenter/shared";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const QUEUE_NAME = "retention-purge";
const PURGE_CRON = process.env.RETENTION_PURGE_CRON || "30 3 * * *";

/** Delete rows of `category` older than `cutoff` for one tenant. Returns count. */
async function purgeCategory(tenantId: string, category: string, cutoff: Date): Promise<number> {
  switch (category) {
    case "messages":
      return (await prisma.message.deleteMany({
        where: { tenantId, createdAt: { lt: cutoff } },
      })).count;
    case "usage_logs":
      return (await prisma.usageLog.deleteMany({
        where: { tenantId, createdAt: { lt: cutoff } },
      })).count;
    case "audit_logs":
      return (await prisma.auditLog.deleteMany({
        where: { tenantId, createdAt: { lt: cutoff } },
      })).count;
    case "billing_webhook_events":
      return (await prisma.billingWebhookEvent.deleteMany({
        where: { tenantId, receivedAt: { lt: cutoff } },
      })).count;
    case "reasoner_shadow_evals":
      return (await prisma.reasonerShadowEval.deleteMany({
        where: { tenantId, createdAt: { lt: cutoff } },
      })).count;
    default:
      throw new Error(`unknown category "${category}"`);
  }
}

const DEFAULTABLE_CATEGORIES = [
  "messages",
  "usage_logs",
  "audit_logs",
  "billing_webhook_events",
  "reasoner_shadow_evals",
] as const;

function envDefaultDays(category: string): number | null {
  const key = `RETENTION_DEFAULT_${category.toUpperCase()}_DAYS`;
  const raw = process.env[key];
  if (!raw) return null;
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : null;
}

export async function runRetentionPurge(): Promise<{ purged: Record<string, number> }> {
  const purged: Record<string, number> = {};

  // 1. Tenant-configured policies (authoritative).
  const policies = await prisma.dataRetentionPolicy.findMany({
    where: { enabled: true },
  });

  for (const policy of policies) {
    try {
      const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);
      const deleted = await purgeCategory(policy.tenantId, policy.category, cutoff);

      purged[policy.category] = (purged[policy.category] ?? 0) + deleted;

      await prisma.dataRetentionPolicy.update({
        where: { id: policy.id },
        data: { lastPurgeAt: new Date() },
      });

      await auditSystem(policy.tenantId, AuditAction.RETENTION_PURGE_RAN, undefined, {
        category: policy.category,
        deleted,
        cutoff: cutoff.toISOString(),
        source: "tenant_policy",
      });
    } catch (err: any) {
      // Never let one bad policy stop the rest of the run.
      console.error(`[retention-purge] failed for policy ${policy.id} (tenant ${policy.tenantId}):`, err?.message ?? err);
    }
  }

  // 2. Platform defaults for tenants WITHOUT an enabled policy on a category.
  const activeDefaults = DEFAULTABLE_CATEGORIES
    .map((c) => ({ category: c as string, days: envDefaultDays(c) }))
    .filter((d): d is { category: string; days: number } => d.days != null);

  if (activeDefaults.length > 0) {
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    const covered = new Set(policies.map((p) => `${p.tenantId}:${p.category}`));

    for (const def of activeDefaults) {
      const cutoff = new Date(Date.now() - def.days * 24 * 60 * 60 * 1000);
      for (const t of tenants) {
        if (covered.has(`${t.id}:${def.category}`)) continue;
        try {
          const deleted = await purgeCategory(t.id, def.category, cutoff);
          if (deleted > 0) {
            purged[def.category] = (purged[def.category] ?? 0) + deleted;
            await auditSystem(t.id, AuditAction.RETENTION_PURGE_RAN, undefined, {
              category: def.category,
              deleted,
              cutoff: cutoff.toISOString(),
              source: "platform_default",
              defaultDays: def.days,
            });
          }
        } catch (err: any) {
          console.error(`[retention-purge] default purge failed (tenant ${t.id}, ${def.category}):`, err?.message ?? err);
        }
      }
    }
  }

  return { purged };
}

let _started = false;

/** Register the repeatable purge job. Idempotent; BullMQ dedupes the repeat key. */
export async function startRetentionScheduler(): Promise<void> {
  if (_started) return;
  _started = true;

  if (process.env.RETENTION_PURGE_ENABLED === "false") {
    console.log("[retention-purge] scheduler disabled via RETENTION_PURGE_ENABLED=false");
    return;
  }

  const queue = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });
  await queue
    .add(
      "purge-tick",
      { type: "retention_purge" },
      { repeat: { pattern: PURGE_CRON }, removeOnComplete: { count: 10 }, removeOnFail: { count: 20 } },
    )
    .catch((err) => console.error("[retention-purge] failed to schedule:", err?.message));

  // Cross-tenant by design (createWorker wraps in withCrossTenantAccess): the
  // purge legitimately iterates every tenant's policies. Concurrency 1.
  createWorker(QUEUE_NAME, async () => {
    const { purged } = await runRetentionPurge();
    const total = Object.values(purged).reduce((a, b) => a + b, 0);
    if (total > 0) console.log(`[retention-purge] purged:`, purged);
  }, 1);

  console.log(`[retention-purge] scheduler started (cron="${PURGE_CRON}")`);
}
