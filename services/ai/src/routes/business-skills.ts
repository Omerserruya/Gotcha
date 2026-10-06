/**
 * /api/business-skills - the tenant's skill library (AI Studio 09 / 09b / 21).
 * Contract: docs/product/ai-studio-skills-automations.md and the message to
 * Frontend. Static paths (/stats, /tools) are registered BEFORE /:id so they
 * cannot be shadowed by it.
 */
import { Router, type Request, type Response } from "express";
import { authenticate, resolveTenant, requireActiveTenant, requirePermissionOrRole, viewerOf } from "@chatcenter/shared";
import { withToolDetails, localeOf } from "../services/tool-labels.service";
import {
  SkillValidationError,
  listSkills,
  skillStats,
  getSkill,
  createSkill,
  updateSkill,
  archiveSkill,
  listRuns,
  listToolChoices,
} from "../services/business-skills.service";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

const CAN_READ = requirePermissionOrRole("ai:employees:read", "ADMIN");
const CAN_WRITE = requirePermissionOrRole("ai:employees:update", "ADMIN");
const WEEK_MS = 7 * 86_400_000;

function fromOf(req: Request): Date {
  const raw = typeof req.query.from === "string" ? Date.parse(req.query.from) : NaN;
  return Number.isFinite(raw) ? new Date(raw) : new Date(Date.now() - WEEK_MS);
}

function fail(res: Response, err: any, what: string) {
  if (err instanceof SkillValidationError) {
    res.status(422).json({ error: err.message, field: err.field, code: "INVALID_SKILL" });
    return;
  }
  console.error(`[business-skills] ${what} failed:`, err?.message ?? err);
  res.status(500).json({ error: `Failed to ${what}` });
}

router.get("/", CAN_READ, async (req: Request, res: Response) => {
  try {
    res.json({ data: await withToolDetails(await listSkills(req.tenantId!, { includeArchived: req.query.includeArchived === "true", from: fromOf(req) }), localeOf(req)) });
  } catch (err) { fail(res, err, "list skills"); }
});

router.get("/stats", CAN_READ, async (req: Request, res: Response) => {
  try {
    res.json({ data: await skillStats(req.tenantId!, fromOf(req)), from: fromOf(req).toISOString() });
  } catch (err) { fail(res, err, "read skill stats"); }
});

router.get("/tools", CAN_READ, async (req: Request, res: Response) => {
  try {
    const agentId = typeof req.query.agentId === "string" && req.query.agentId ? req.query.agentId : null;
    res.json({ data: await listToolChoices(req.tenantId!, agentId, localeOf(req)) });
  } catch (err) { fail(res, err, "list tools"); }
});

router.get("/:id", CAN_READ, async (req: Request, res: Response) => {
  try {
    const skill = await getSkill(req.tenantId!, String(req.params.id));
    if (!skill) { res.status(404).json({ error: "Skill not found" }); return; }
    const [stats] = await skillStats(req.tenantId!, fromOf(req), [skill.id]);
    const [shown] = await withToolDetails([skill], localeOf(req));
    res.json({ data: { ...shown, stats: stats ?? null } });
  } catch (err) { fail(res, err, "read the skill"); }
});

router.post("/", CAN_WRITE, async (req: Request, res: Response) => {
  try {
    const [shown] = await withToolDetails([await createSkill(req.tenantId!, (req as any).user?.userId, req.body)], localeOf(req));
    res.status(201).json({ data: shown });
  } catch (err) { fail(res, err, "create the skill"); }
});

router.put("/:id", CAN_WRITE, async (req: Request, res: Response) => {
  try {
    const skill = await updateSkill(req.tenantId!, String(req.params.id), (req as any).user?.userId, req.body);
    if (!skill) { res.status(404).json({ error: "Skill not found" }); return; }
    const [shown] = await withToolDetails([skill], localeOf(req));
    res.json({ data: shown });
  } catch (err) { fail(res, err, "update the skill"); }
});

// Archive, not delete: runs keep their history.
router.delete("/:id", CAN_WRITE, async (req: Request, res: Response) => {
  try {
    const skill = await archiveSkill(req.tenantId!, String(req.params.id), (req as any).user?.userId);
    if (!skill) { res.status(404).json({ error: "Skill not found" }); return; }
    res.json({ data: skill });
  } catch (err) { fail(res, err, "archive the skill"); }
});

router.get("/:id/runs", CAN_READ, async (req: Request, res: Response) => {
  try {
    const skill = await getSkill(req.tenantId!, String(req.params.id));
    if (!skill) { res.status(404).json({ error: "Skill not found" }); return; }
    res.json(await listRuns(req.tenantId!, skill.id, viewerOf(req), {
      limit: Number(req.query.limit) || 20,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : null,
    }));
  } catch (err) { fail(res, err, "list skill runs"); }
});

export default router;
