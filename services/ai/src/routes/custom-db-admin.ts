/**
 * Custom DB query tool admin - CRUD + test.
 *
 *   GET    /custom-db-tools
 *   POST   /custom-db-tools
 *   PATCH  /custom-db-tools/:id
 *   DELETE /custom-db-tools/:id
 *   POST   /custom-db-tools/:id/test
 *
 * ADMIN role required.
 */

import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";
import { executeCustomDbQueryTool } from "../services/connectors/custom-db.service";

const router = Router();
router.use("/custom-db-tools", authenticate, resolveTenant, requireActiveTenant());

const VALID_PROVIDERS = new Set(["postgresql", "mongodb", "aws_rds"]);
const VALID_CATEGORIES = new Set(["READ", "WRITE", "DELETE", "ACTION"]);
const VALID_RISKS = new Set(["LOW", "MEDIUM", "HIGH"]);

router.get("/custom-db-tools", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const where: any = { tenantId: req.tenantId };
  if (req.query.provider) where.providerSlug = String(req.query.provider);
  const rows = await (prisma as any).customDbQueryTool.findMany({
    where,
    orderBy: [{ isActive: "desc" }, { providerSlug: "asc" }, { slug: "asc" }],
  });
  res.json({ data: rows });
});

router.post("/custom-db-tools", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const b = req.body || {};
  for (const k of ["slug", "name", "description", "whenToUse", "providerSlug", "queryTemplate"]) {
    if (!b[k] || String(b[k]).trim() === "") {
      res.status(400).json({ error: `${k} is required` });
      return;
    }
  }
  if (!VALID_PROVIDERS.has(b.providerSlug)) {
    res.status(400).json({ error: "providerSlug must be postgresql|mongodb|aws_rds" });
    return;
  }
  if (b.category && !VALID_CATEGORIES.has(b.category)) {
    res.status(400).json({ error: "category must be READ|WRITE|DELETE|ACTION" });
    return;
  }
  if (b.riskLevel && !VALID_RISKS.has(b.riskLevel)) {
    res.status(400).json({ error: "riskLevel must be LOW|MEDIUM|HIGH" });
    return;
  }
  try {
    const row = await (prisma as any).customDbQueryTool.create({
      data: {
        tenantId: req.tenantId,
        providerSlug: String(b.providerSlug),
        slug: String(b.slug),
        name: String(b.name),
        description: String(b.description),
        whenToUse: String(b.whenToUse),
        whenNotToUse: b.whenNotToUse || null,
        queryTemplate: String(b.queryTemplate),
        parameterSchema: b.parameterSchema ?? { type: "object", properties: {}, required: [] },
        parameterOrder: Array.isArray(b.parameterOrder) ? b.parameterOrder : [],
        category: b.category || "READ",
        riskLevel: b.riskLevel || "LOW",
        isActive: b.isActive !== false,
        maxRows: Number(b.maxRows ?? 100),
        timeoutMs: Number(b.timeoutMs ?? 5000),
      },
    });
    res.status(201).json({ data: row });
  } catch (err: any) {
    if (/Unique/i.test(err?.message || "")) {
      res.status(409).json({ error: "slug already exists for this tenant" });
      return;
    }
    res.status(500).json({ error: err?.message || "create failed" });
  }
});

router.patch("/custom-db-tools/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const b = req.body || {};
  const data: any = {};
  for (const k of [
    "name", "description", "whenToUse", "whenNotToUse",
    "queryTemplate", "parameterSchema", "parameterOrder",
    "category", "riskLevel", "isActive", "maxRows", "timeoutMs",
  ]) {
    if (b[k] !== undefined) data[k] = b[k];
  }
  try {
    const row = await (prisma as any).customDbQueryTool.update({
      where: { id: req.params.id, tenantId: req.tenantId } as any,
      data,
    });
    res.json({ data: row });
  } catch (err: any) {
    res.status(404).json({ error: err?.message || "not found" });
  }
});

router.delete("/custom-db-tools/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  await (prisma as any).customDbQueryTool.deleteMany({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  res.json({ ok: true });
});

router.post("/custom-db-tools/:id/test", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const tool = await (prisma as any).customDbQueryTool.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!tool) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const args = (req.body && req.body.args) || {};
  const result = await executeCustomDbQueryTool({
    tenantId: req.tenantId!,
    slug: tool.slug,
    args,
  });
  res.json(result);
});

export default router;
