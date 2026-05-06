/**
 * Tenant funnel-config loader.
 *
 * The BEL must stay pure — no I/O. This repo is the only place that touches
 * Prisma to fetch a tenant's `FunnelConfig`. Callers (ai-bot.service) load
 * the funnel BEFORE invoking computeBehaviorState() and pass it in.
 *
 * Persistence model: dedicated `TenantFunnel` model (one row per tenant per
 * departmentId). NULL departmentId = tenant default. The model stores
 * stages/transitions/overrides as JSON columns so the schema doesn't grow
 * with every funnel feature. The shape is validated cheaply on read; the BEL
 * falls back to no-funnel if invalid.
 *
 * Resolution order:
 *   1. Department-scoped active funnel (departmentId = given value).
 *   2. Tenant-default active funnel (departmentId IS NULL).
 *   3. null — BEL behaves as if no funnel existed.
 *
 * Failure mode: any error or missing config → returns `null`.
 */

import { prisma } from "@chatcenter/shared";
import type { FunnelConfig } from "./funnel-config.service";

const cache = new Map<string, { value: FunnelConfig | null; expiresAt: number }>();
const TTL_MS = 60_000; // 60s — keep BEL hot path cheap.

export async function loadFunnelForTenant(opts: {
  tenantId: string;
  departmentId?: string | null;
}): Promise<FunnelConfig | null> {
  const deptKey = opts.departmentId ?? "_default";
  const key = `${opts.tenantId}:${deptKey}`;
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  let value: FunnelConfig | null = null;
  try {
    // Two-query fallback: prefer department-scoped, then tenant default.
    // Kept as two queries for clarity; each is O(1) by the unique index.
    let row: any = null;

    if (opts.departmentId) {
      row = await (prisma as any).tenantFunnel?.findFirst?.({
        where: { tenantId: opts.tenantId, departmentId: opts.departmentId, isActive: true },
      });
    }

    // Fall back to tenant default (departmentId IS NULL).
    if (!row) {
      row = await (prisma as any).tenantFunnel?.findFirst?.({
        where: { tenantId: opts.tenantId, departmentId: null, isActive: true },
      });
    }

    if (row) {
      const candidate: FunnelConfig = {
        tenantId: row.tenantId,
        funnelId: row.funnelId,
        departmentId: row.departmentId ?? null,
        stages: row.stages ?? [],
        transitions: row.transitions ?? [],
        strategyOverrides: row.strategyOverrides ?? undefined,
        playbookOverrides: row.playbookOverrides ?? undefined,
      };
      if (validateFunnel(candidate)) value = candidate;
    }
  } catch (err: any) {
    // Pre-migration: prisma.tenantFunnel may not exist yet — degrade silently.
    if (!/Unknown arg|Cannot read|undefined.*findFirst/.test(err?.message || "")) {
      console.warn("[funnel-config.repo] load failed (non-fatal):", err?.message);
    }
    value = null;
  }

  cache.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}

/**
 * Cheap shape check. We do not run a full schema validation on the hot
 * path; just enough to reject obvious garbage.
 */
function validateFunnel(funnel: FunnelConfig): boolean {
  if (!funnel || typeof funnel !== "object") return false;
  if (!Array.isArray(funnel.stages) || funnel.stages.length === 0) return false;
  if (!funnel.stages.every((s) => s && typeof s.id === "string" && typeof s.baseStage === "string")) return false;
  if (!Array.isArray(funnel.transitions)) return false;
  return true;
}

/** Drop the in-process cache. Used by config-update endpoints. */
export function invalidateFunnelCache(tenantId?: string): void {
  if (!tenantId) {
    cache.clear();
    return;
  }
  for (const k of cache.keys()) {
    if (k.startsWith(`${tenantId}:`)) cache.delete(k);
  }
}
