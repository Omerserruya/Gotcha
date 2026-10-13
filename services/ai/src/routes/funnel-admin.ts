/**
 * Funnel admin routes - CRUD over `TenantFunnel`.
 *
 *   GET    /funnels?departmentId=...
 *   GET    /funnels/:id
 *   POST   /funnels
 *   PATCH  /funnels/:id
 *   DELETE /funnels/:id
 *   POST   /funnels/:id/activate    - sets isActive=true and deactivates siblings in same departmentId
 *   GET    /funnels/templates       - ready-made funnels, in the reader's language
 *   POST   /funnels {template}      - create one from a template (stages server-side)
 *
 * The cache in funnel-config.repo.ts is invalidated on writes so BEL picks
 * up changes within one request. ADMIN role required.
 */

import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";
import { invalidateFunnelCache } from "../services/funnel-config.repo";
import { readerLocale } from "../lib/reader-locale";
import { FUNNEL_TEMPLATES, funnelFromTemplate, listFunnelTemplates, templateLanguage } from "../lib/funnel-templates";

const router = Router();

// Scope the auth chain to /funnels/* only - without the path filter, this
// router-level middleware fires for ANY request that hits the parent /api
// mount (including unrelated /api/connectors/* etc.) and 401-blocks them
// before their own router can handle the route.
router.use("/funnels", authenticate, resolveTenant, requireActiveTenant());

// ─── List + Read ─────────────────────────────────────────

router.get("/funnels", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const where: any = { tenantId: req.tenantId };
  if (req.query.departmentId !== undefined) {
    // Allow explicit "null" string to filter tenant-default rows.
    where.departmentId = req.query.departmentId === "null" ? null : String(req.query.departmentId);
  }
  const rows = await (prisma as any).tenantFunnel.findMany({
    where,
    orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
  });
  res.json({ data: rows });
});

// Declared before /funnels/:id, which would otherwise read "templates" as an id.
router.get("/funnels/templates", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const lang = templateLanguage(await readerLocale(req));
  res.json({ data: listFunnelTemplates(lang) });
});

router.get("/funnels/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const row = await (prisma as any).tenantFunnel.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ data: row });
});

// ─── Create ──────────────────────────────────────────────

router.post("/funnels", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const b = req.body || {};
  if (b.template !== undefined) {
    await createFromTemplate(req, res, b);
    return;
  }
  for (const k of ["funnelId", "stages"]) {
    if (b[k] === undefined || b[k] === null || b[k] === "") {
      res.status(400).json({ error: `${k} is required` });
      return;
    }
  }
  if (!Array.isArray(b.stages) || b.stages.length === 0) {
    res.status(400).json({ error: "stages must be a non-empty array" });
    return;
  }
  // departmentId is optional - null means tenant default.
  const departmentId = b.departmentId != null ? String(b.departmentId) : null;
  try {
    const row = await (prisma as any).tenantFunnel.create({
      data: {
        tenantId: req.tenantId,
        funnelId: String(b.funnelId),
        departmentId,
        isActive: b.isActive !== false,
        stages: b.stages,
        transitions: b.transitions ?? [],
        strategyOverrides: b.strategyOverrides ?? null,
        playbookOverrides: b.playbookOverrides ?? null,
      },
    });
    invalidateFunnelCache(req.tenantId);
    res.status(201).json({ data: row });
  } catch (err: any) {
    if (/Unique/i.test(err?.message || "")) {
      res.status(409).json({ error: "funnelId already exists for this tenant+department" });
      return;
    }
    res.status(500).json({ error: err?.message || "create failed" });
  }
});

/**
 * A funnel from a template (a hire's "Sales" path): the stages come from the
 * server, labelled in the WORKSPACE's language (what its team and AI read),
 * not the requester's.
 *
 * Created INACTIVE unless isActive:true is sent: the workspace's active default
 * funnel steers every conversation, while a funnel bound to one employee
 * (AIAgent.funnelId) is read by id and needs no activation. The same template
 * twice returns the funnel already made (200, created:false), so a second
 * Sales hire shares it.
 */
async function createFromTemplate(req: Request, res: Response, b: any) {
  const id = String(b.template);
  if (!FUNNEL_TEMPLATES[id]) {
    res.status(400).json({ error: `unknown template "${id}"`, code: "UNKNOWN_TEMPLATE", templates: Object.keys(FUNNEL_TEMPLATES) });
    return;
  }
  const departmentId = b.departmentId != null ? String(b.departmentId) : null;
  const tenant = await prisma.tenant.findUnique({ where: { id: req.tenantId! }, select: { defaultLocale: true } }).catch(() => null);
  const f = funnelFromTemplate(id, templateLanguage(tenant?.defaultLocale))!;
  const existing = await (prisma as any).tenantFunnel.findFirst({ where: { tenantId: req.tenantId, funnelId: f.funnelId, departmentId } });
  if (existing) {
    res.json({ data: existing, created: false });
    return;
  }
  try {
    const row = await (prisma as any).tenantFunnel.create({
      data: { tenantId: req.tenantId, departmentId, isActive: b.isActive === true, ...f },
    });
    invalidateFunnelCache(req.tenantId!);
    res.status(201).json({ data: row, created: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "create failed" });
  }
}

// ─── Update ──────────────────────────────────────────────

router.patch("/funnels/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const b = req.body || {};
  const data: any = {};
  for (const k of ["isActive", "stages", "transitions", "strategyOverrides", "playbookOverrides"]) {
    if (b[k] !== undefined) data[k] = b[k];
  }
  // Allow moving a funnel to a different department scope.
  if (b.departmentId !== undefined) {
    data.departmentId = b.departmentId != null ? String(b.departmentId) : null;
  }
  try {
    const row = await (prisma as any).tenantFunnel.update({
      where: { id: req.params.id, tenantId: req.tenantId } as any,
      data,
    });
    invalidateFunnelCache(req.tenantId);
    res.json({ data: row });
  } catch (err: any) {
    res.status(404).json({ error: err?.message || "not found" });
  }
});

// ─── Activate (idempotent - drops sibling actives in same departmentId) ──

router.post("/funnels/:id/activate", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const target = await (prisma as any).tenantFunnel.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!target) {
    res.status(404).json({ error: "not found" });
    return;
  }
  await prisma.$transaction([
    (prisma as any).tenantFunnel.updateMany({
      where: { tenantId: req.tenantId, departmentId: target.departmentId, NOT: { id: target.id } },
      data: { isActive: false },
    }),
    (prisma as any).tenantFunnel.update({
      where: { id: target.id },
      data: { isActive: true },
    }),
  ]);
  invalidateFunnelCache(req.tenantId);
  res.json({ ok: true });
});

// ─── Delete ──────────────────────────────────────────────

router.delete("/funnels/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  await (prisma as any).tenantFunnel.deleteMany({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  invalidateFunnelCache(req.tenantId);
  res.json({ ok: true });
});

export default router;
