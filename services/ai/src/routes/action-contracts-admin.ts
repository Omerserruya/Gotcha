/**
 * Action Contract admin routes - CRUD over `ActionContract`.
 *
 *   GET    /action-contracts
 *   GET    /action-contracts/:id
 *   POST   /action-contracts
 *   PATCH  /action-contracts/:id
 *   DELETE /action-contracts/:id
 *
 * Cache invalidation runs on every write so the BEL picks up changes on
 * the next conversation turn (within the 60s repo cache or instantly on
 * `ai` restart). ADMIN role required.
 */

import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";
import { invalidateActionContractsCache } from "../services/action-contracts.repo";

const router = Router();
// Path-scoped - see funnel-admin.ts for the rationale (router-level use()
// without a path filter runs for every request hitting siblings under /api).
router.use("/action-contracts", authenticate, resolveTenant, requireActiveTenant());

const VALID_MODES = new Set(["ALL_REQUIRED", "SEQUENCE", "AT_LEAST_ONE"]);

router.get("/action-contracts", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const rows = await (prisma as any).actionContract.findMany({
    where: { tenantId: req.tenantId },
    orderBy: [{ isActive: "desc" }, { trigger: "asc" }],
  });
  res.json({ data: rows });
});

router.get("/action-contracts/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const row = await (prisma as any).actionContract.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ data: row });
});

router.post("/action-contracts", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const b = req.body || {};
  for (const k of ["trigger", "requiredTools", "executionMode"]) {
    if (b[k] === undefined || b[k] === null || b[k] === "") {
      res.status(400).json({ error: `${k} is required` });
      return;
    }
  }
  if (!VALID_MODES.has(String(b.executionMode))) {
    res.status(400).json({ error: `executionMode must be one of ${[...VALID_MODES].join(", ")}` });
    return;
  }
  if (!Array.isArray(b.requiredTools) || b.requiredTools.length === 0) {
    res.status(400).json({ error: "requiredTools must be a non-empty array" });
    return;
  }
  // Normalize requiredTools to [{ name }] shape regardless of input.
  const requiredTools = b.requiredTools
    .map((t: any) => (typeof t === "string" ? { name: t } : { name: String(t?.name || "") }))
    .filter((t: any) => t.name);
  if (requiredTools.length === 0) {
    res.status(400).json({ error: "requiredTools entries need a name" });
    return;
  }
  if (b.executionMode === "SEQUENCE") {
    // If `order` not provided, fall back to requiredTools order. Validate any
    // order field references existing requiredTools names.
    if (b.order && Array.isArray(b.order)) {
      const names = new Set(requiredTools.map((t: any) => t.name));
      for (const o of b.order) {
        if (!names.has(String(o))) {
          res.status(400).json({ error: `order references unknown tool "${o}"` });
          return;
        }
      }
    }
  }
  try {
    const row = await (prisma as any).actionContract.create({
      data: {
        tenantId: req.tenantId,
        trigger: String(b.trigger),
        requiredTools,
        executionMode: String(b.executionMode),
        order: b.order ?? null,
        blocking: b.blocking !== false,
        isActive: b.isActive !== false,
      },
    });
    invalidateActionContractsCache(req.tenantId);
    res.status(201).json({ data: row });
  } catch (err: any) {
    if (/Unique/i.test(err?.message || "")) {
      res.status(409).json({ error: "trigger already has a contract for this tenant" });
      return;
    }
    res.status(500).json({ error: err?.message || "create failed" });
  }
});

router.patch("/action-contracts/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const b = req.body || {};
  const data: any = {};
  if (b.requiredTools !== undefined) {
    if (!Array.isArray(b.requiredTools)) {
      res.status(400).json({ error: "requiredTools must be an array" });
      return;
    }
    data.requiredTools = b.requiredTools
      .map((t: any) => (typeof t === "string" ? { name: t } : { name: String(t?.name || "") }))
      .filter((t: any) => t.name);
  }
  if (b.executionMode !== undefined) {
    if (!VALID_MODES.has(String(b.executionMode))) {
      res.status(400).json({ error: "executionMode invalid" });
      return;
    }
    data.executionMode = b.executionMode;
  }
  if (b.order !== undefined) data.order = b.order;
  if (b.blocking !== undefined) data.blocking = !!b.blocking;
  if (b.isActive !== undefined) data.isActive = !!b.isActive;
  try {
    const row = await (prisma as any).actionContract.update({
      where: { id: req.params.id, tenantId: req.tenantId } as any,
      data,
    });
    invalidateActionContractsCache(req.tenantId);
    res.json({ data: row });
  } catch (err: any) {
    res.status(404).json({ error: err?.message || "not found" });
  }
});

router.delete("/action-contracts/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  await (prisma as any).actionContract.deleteMany({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  invalidateActionContractsCache(req.tenantId);
  res.json({ ok: true });
});

export default router;
