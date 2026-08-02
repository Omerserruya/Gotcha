/**
 * Backfill: existing tenants' onboarding data → Knowledge Base entries.
 *
 * Tenants who onboarded before the projection existed have a full
 * BusinessDiscovery record and an empty knowledge base. Their AI employee
 * cannot answer a single question about their own business. This route walks
 * those tenants and runs the same projection a fresh scan runs - the identical
 * code path, so a backfilled tenant and a newly scanned one end up with
 * byte-identical documents.
 *
 * Two properties matter more than speed here:
 *
 *   - PREVIEW FIRST. `dryRun` (the default) reports exactly what would happen
 *     per tenant and writes nothing. An irreversible bulk write across every
 *     tenant on the platform should be readable before it is run.
 *   - IDEMPOTENT. Re-running is safe because reconciliation matches on
 *     dedupeKey: the second run reports `unchanged`, not a second copy. This
 *     is the same guarantee that makes a website re-scan safe, reused rather
 *     than reimplemented.
 *
 * The original discovery record is never mutated or deleted - it stays as the
 * raw source for audit, and the generated entries carry `origin: onboarding`
 * so they can always be told apart from knowledge a human wrote.
 */

import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  requireSystemAdmin,
  crossTenantMiddleware,
  writeAudit,
  AuditAction,
  projectDiscoveryTopics,
} from "@chatcenter/shared";
import { applyProjection } from "../services/onboarding-knowledge.service";

const router = Router();

// `requireSystemAdmin()` - CALLED. It is a factory that returns the middleware.
//
// Passed uncalled, Express invokes the factory itself as (req, res, next); it
// ignores those arguments, returns a function, and never calls next(). The
// request then hangs forever: no error, no log, no response, just a socket the
// gateway eventually times out at 504.
//
// Scoped to this router's own path rather than left path-less. Mounted on
// "/api/system" alongside two other routers, a bare `router.use(...)` runs for
// EVERY /api/system/* request - so this single missing pair of parentheses
// froze the whole sysadmin console: tenants, stats and onboarding-console all
// hung, none of which this file has anything to do with. Unauthenticated
// callers still got a fast 401, because `authenticate` rejected before
// reaching the broken middleware, which is why the service looked healthy.
router.use("/knowledge-backfill", authenticate, requireSystemAdmin(), crossTenantMiddleware);

/** Outcome buckets the operator asked for, one per tenant. */
type Bucket =
  | "migrated"        // entries created this run
  | "already_migrated" // everything matched what was already there
  | "empty"           // nothing worth projecting (no usable discovery)
  | "partial"         // some entries landed, some failed
  | "failed"          // nothing landed
  | "manual_review";  // projection ran but a human should look

interface TenantResult {
  tenantId: string;
  tenantName: string;
  bucket: Bucket;
  projected: number;
  added: number;
  updated: number;
  unchanged: number;
  preserved: number;
  failed: number;
  note?: string;
}

function bucketFor(r: Omit<TenantResult, "bucket" | "tenantId" | "tenantName">): Bucket {
  if (r.projected === 0) return "empty";
  if (r.failed > 0 && r.added + r.updated === 0) return "failed";
  if (r.failed > 0) return "partial";
  if (r.added + r.updated === 0) return "already_migrated";
  return "migrated";
}

async function fetchWithTimeout(url: string, init: any, ms = 30000): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/system/knowledge-backfill
 * body: { dryRun?: boolean (default true), tenantIds?: string[], limit?: number }
 */
router.post("/knowledge-backfill", async (req: Request, res: Response): Promise<void> => {
  const dryRun = req.body?.dryRun !== false; // opt IN to writing
  const only: string[] | undefined = Array.isArray(req.body?.tenantIds) ? req.body.tenantIds : undefined;
  const limit = Math.min(Number(req.body?.limit) || 500, 2000);

  try {
    const discoveries = await prisma.businessDiscovery.findMany({
      where: {
        status: "COMPLETE",
        ...(only ? { tenantId: { in: only } } : {}),
      },
      select: {
        tenantId: true, websiteDomain: true, scannedAt: true,
        brand: true, business: true, knowledge: true, communication: true, technology: true,
      },
      take: limit,
    });

    const results: TenantResult[] = [];

    for (const disc of discoveries) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: disc.tenantId },
        select: { id: true, name: true, status: true, defaultLocale: true },
      }).catch(() => null);

      // A deleted or missing tenant must never have data written back for it.
      if (!tenant) {
        results.push({
          tenantId: disc.tenantId, tenantName: "(missing)", bucket: "manual_review",
          projected: 0, added: 0, updated: 0, unchanged: 0, preserved: 0, failed: 0,
          note: "tenant_not_found",
        });
        continue;
      }

      const profile = await prisma.businessProfile.findUnique({
        where: { tenantId: tenant.id },
        select: {
          organizationName: true, industry: true, businessDescription: true,
          country: true, primaryLanguage: true,
        },
      }).catch(() => null);

      const ctx = {
        language: profile?.primaryLanguage || tenant.defaultLocale || "en",
        // The ORIGINAL scan time, not "now". This value becomes the entry's
        // lastRefreshedAt, and it should say when the knowledge was actually
        // learned - not when an operator happened to run a migration. Stamping
        // migration time would make every backfilled tenant look freshly
        // scanned. Falls back to now only when the scan time was never
        // recorded.
        now: (disc.scannedAt ?? new Date()).toISOString(),
      };

      // Topic summaries only. Individual page documents are NOT backfilled:
      // their text was never persisted (only the discovery synthesis was), and
      // re-crawling every tenant's whole site from a migration endpoint would
      // fire a large volume of outbound traffic at customer sites without any
      // action on their part. A re-scan from the UI picks the pages up.
      const projected = projectDiscoveryTopics(disc as any, profile ?? {}, ctx);

      if (projected.length === 0) {
        results.push({
          tenantId: tenant.id, tenantName: tenant.name, bucket: "empty",
          projected: 0, added: 0, updated: 0, unchanged: 0, preserved: 0, failed: 0,
          note: "discovery_has_no_usable_content",
        });
        continue;
      }

      if (dryRun) {
        // Reconcile against reality WITHOUT writing, so the preview reports the
        // real add/update/unchanged split rather than "everything is new".
        const existing = await prisma.knowledgeDocument.findMany({
          where: { tenantId: tenant.id },
          select: { id: true, title: true, metadata: true },
        }).catch(() => []);
        const { reconcile } = await import("@chatcenter/shared");
        const plan = reconcile(projected, existing as any);
        const row = {
          projected: projected.length,
          added: plan.summary.added,
          updated: plan.summary.updated,
          unchanged: plan.summary.unchanged,
          preserved: plan.summary.preserved,
          failed: 0,
        };
        results.push({ tenantId: tenant.id, tenantName: tenant.name, bucket: bucketFor(row), ...row });
        continue;
      }

      const report = await applyProjection(
        { prisma, fetchFn: fetchWithTimeout as any, authHeader: req.headers.authorization! },
        tenant.id,
        projected,
        // Never retire anything during a backfill - it only fills gaps.
        { removeMissing: false },
      );
      const row = {
        projected: projected.length,
        added: report.added,
        updated: report.updated,
        unchanged: report.unchanged,
        preserved: report.preserved,
        failed: report.failed,
      };
      results.push({ tenantId: tenant.id, tenantName: tenant.name, bucket: bucketFor(row), ...row });
    }

    const grouped: Record<Bucket, TenantResult[]> = {
      migrated: [], already_migrated: [], empty: [], partial: [], failed: [], manual_review: [],
    };
    for (const r of results) grouped[r.bucket].push(r);

    if (!dryRun) {
      void writeAudit({
        tenantId: "platform",
        actorType: "user",
        actorId: (req as any).user?.userId,
        action: AuditAction.KNOWLEDGE_BACKFILL_RUN,
        targetType: "platform",
        targetId: "knowledge_backfill",
        metadata: {
          tenants: results.length,
          migrated: grouped.migrated.length,
          alreadyMigrated: grouped.already_migrated.length,
          empty: grouped.empty.length,
          partial: grouped.partial.length,
          failed: grouped.failed.length,
          manualReview: grouped.manual_review.length,
        },
      });
    }

    res.json({
      data: {
        dryRun,
        scanned: results.length,
        summary: {
          migrated: grouped.migrated.length,
          alreadyMigrated: grouped.already_migrated.length,
          empty: grouped.empty.length,
          partial: grouped.partial.length,
          failed: grouped.failed.length,
          manualReview: grouped.manual_review.length,
        },
        grouped,
      },
    });
  } catch (err) {
    console.error("Knowledge backfill error:", err);
    res.status(500).json({ error: "Backfill failed" });
  }
});

export default router;
