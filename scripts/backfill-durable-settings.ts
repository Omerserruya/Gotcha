/**
 * Copy admin-configured settings out of Redis into Postgres.
 *
 * Business hours, the auto-greeting template and SLA targets lived only in
 * Redis, which has no volume mounted in this stack - a restart erased them.
 * `TenantSetting` is now the source of truth and Redis is the cache in front of
 * it, but the values that are already out there only exist in the cache. This
 * moves them before the next restart takes them.
 *
 *   npx tsx scripts/backfill-durable-settings.ts            # report only
 *   npx tsx scripts/backfill-durable-settings.ts --apply    # write
 *
 * Idempotent and non-destructive: it never deletes a Redis key, and it skips
 * any setting already present in Postgres rather than overwriting it - if the
 * two disagree, the durable value is the one someone saved most recently
 * through the new path and must win.
 *
 * Run it BEFORE the next restart of the redis container. After a restart there
 * is nothing left to copy, and the loss is silent: business hours read as
 * "open" when missing.
 */

import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
const APPLY = process.argv.includes("--apply");

/** Tenant-scoped keys, stored under `tenant:{id}:{key}`. */
const TENANT_KEYS = ["businessHours", "autoGreeting", "sla"] as const;

async function main(): Promise<void> {
  const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true } });
  const departments = await prisma.department.findMany({ select: { id: true, tenantId: true } });

  let found = 0;
  let written = 0;
  let skipped = 0;

  const record = async (tenantId: string, key: string, cacheKey: string, label: string) => {
    const raw = await redis.get(cacheKey);
    if (raw === null || raw === undefined || raw === "") return;
    found++;

    const existing = await (prisma as any).tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key } },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      console.log(`  skip   ${label}  (already durable)`);
      return;
    }

    console.log(`  ${APPLY ? "write " : "would "} ${label}  (${raw.length} bytes)`);
    if (!APPLY) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw; // autoGreeting is a bare string, not JSON
    }
    await (prisma as any).tenantSetting.create({
      data: { tenantId, key, value: parsed as any, updatedBy: "backfill" },
    });
    written++;
  };

  for (const t of tenants) {
    for (const key of TENANT_KEYS) {
      await record(t.id, key, `tenant:${t.id}:${key}`, `${t.slug}/${key}`);
    }
  }

  // Department SLAs were stored under a GLOBAL `department:{id}:sla` key with
  // no tenant in it. That is why this reads the legacy key and writes the value
  // under the tenant-scoped one: an unscoped cache key is readable by any
  // tenant that knows the department id, and a cache read happens before the
  // row that records ownership is ever consulted.
  for (const d of departments) {
    const key = `department:${d.id}:sla`;
    await record(d.tenantId, key, /* legacy global cache key */ key, key);
  }

  console.log(
    `\n${found} setting(s) in Redis, ${skipped} already durable, ` +
      `${APPLY ? `${written} written` : `${found - skipped} would be written`}.`,
  );
  if (!APPLY && found > skipped) console.log("Re-run with --apply to persist them.");
}

main()
  .catch((err) => {
    console.error("failed:", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    redis.disconnect();
  });
