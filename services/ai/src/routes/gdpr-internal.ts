/**
 * GDPR internal routes - in-mesh only, no end-user auth.
 *
 * Internal-only: protected by the same `X-Internal-Key` shared secret as
 * ai-bot.ts. Called by other services (e.g. auth's tenant-deletion flow)
 * to fan out GDPR-relevant cleanup that only this service can perform
 * (Qdrant vectors) or to trigger the retention purge on a schedule.
 */

import { Router, Request, Response } from "express";
import { requireInternalKey, writeAudit, AuditAction } from "@chatcenter/shared";
import { deleteByTenantId } from "../services/qdrant.service";
import { runRetentionPurge } from "../services/retention-purge.service";

const router = Router();

// Hardened internal gate: constant-time, fail-closed, no committed default.
router.use(requireInternalKey);

// POST /api/gdpr-internal/purge-tenant-vectors
//   body: { tenantId }
//   Called by the auth service during tenant deletion to clean up this
//   tenant's Qdrant vectors (KB embeddings are the only per-tenant data
//   this service stores outside Postgres).
router.post("/purge-tenant-vectors", async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.body || {};
    if (!tenantId) {
      res.status(400).json({ error: "tenantId is required" });
      return;
    }

    await deleteByTenantId(tenantId);

    await writeAudit({
      tenantId,
      actorType: "system",
      action: AuditAction.TENANT_DELETED,
      metadata: { store: "qdrant" },
    });

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[gdpr-internal/purge-tenant-vectors] failed:", err?.message ?? err);
    res.status(500).json({ error: "Failed to purge tenant vectors" });
  }
});

// POST /api/gdpr-internal/run-retention-purge
//   Triggers a full data-retention purge run across all enabled
//   DataRetentionPolicy rows. Invoked by cron or manually.
router.post("/run-retention-purge", async (_req: Request, res: Response) => {
  try {
    const result = await runRetentionPurge();
    res.json(result);
  } catch (err: any) {
    console.error("[gdpr-internal/run-retention-purge] failed:", err?.message ?? err);
    res.status(500).json({ error: "Failed to run retention purge" });
  }
});

export default router;
