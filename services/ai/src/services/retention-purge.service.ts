/**
 * Data-retention purge.
 *
 * For every enabled `DataRetentionPolicy` row, hard-deletes rows in the
 * matching table older than (now - retentionDays). Never throws out of the
 * loop - one bad/unknown policy is logged and skipped so the rest still run.
 * Each processed policy gets its `lastPurgeAt` bumped and a system audit
 * event recorded (GDPR Art. 5(1)(e) storage-limitation accountability).
 */

import { prisma, auditSystem, AuditAction } from "@chatcenter/shared";

export async function runRetentionPurge(): Promise<{ purged: Record<string, number> }> {
  const purged: Record<string, number> = {};

  const policies = await prisma.dataRetentionPolicy.findMany({
    where: { enabled: true },
  });

  for (const policy of policies) {
    try {
      const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);
      let deleted = 0;

      switch (policy.category) {
        case "messages": {
          const result = await prisma.message.deleteMany({
            where: { tenantId: policy.tenantId, createdAt: { lt: cutoff } },
          });
          deleted = result.count;
          break;
        }
        case "usage_logs": {
          const result = await prisma.usageLog.deleteMany({
            where: { tenantId: policy.tenantId, createdAt: { lt: cutoff } },
          });
          deleted = result.count;
          break;
        }
        case "audit_logs": {
          const result = await prisma.auditLog.deleteMany({
            where: { tenantId: policy.tenantId, createdAt: { lt: cutoff } },
          });
          deleted = result.count;
          break;
        }
        default: {
          console.warn(`[retention-purge] unknown category "${policy.category}" on policy ${policy.id} - skipping`);
          continue;
        }
      }

      purged[policy.category] = (purged[policy.category] ?? 0) + deleted;

      await prisma.dataRetentionPolicy.update({
        where: { id: policy.id },
        data: { lastPurgeAt: new Date() },
      });

      await auditSystem(policy.tenantId, AuditAction.RETENTION_PURGE_RAN, undefined, {
        category: policy.category,
        deleted,
        cutoff: cutoff.toISOString(),
      });
    } catch (err: any) {
      // Never let one bad policy stop the rest of the run.
      console.error(`[retention-purge] failed for policy ${policy.id} (tenant ${policy.tenantId}):`, err?.message ?? err);
    }
  }

  return { purged };
}
