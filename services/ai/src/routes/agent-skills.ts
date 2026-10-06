/**
 * /api/ai-agents/:id/skills - which business skills an employee uses (07g).
 * Mounted beside routes/ai-agents.ts under the same prefix; these paths have
 * more segments than its `/:id`, so neither shadows the other.
 */
import { Router, type Request, type Response } from "express";
import { authenticate, resolveTenant, requireActiveTenant, requirePermissionOrRole } from "@chatcenter/shared";
import { SkillValidationError, getAgentSkills, setAgentSkills, fitCheck } from "../services/business-skills.service";

const router = Router();
// Per-route, NOT router.use: this router shares the /api/ai-agents prefix and
// sits ahead of ai-agents.ts, so a router.use here would run on every
// /api/ai-agents/* request - including routes there that authenticate
// differently.
const AUTH = [authenticate, resolveTenant, requireActiveTenant()];

const CAN_READ = requirePermissionOrRole("ai:employees:read", "ADMIN");
const CAN_WRITE = requirePermissionOrRole("ai:employees:update", "ADMIN");
const WEEK_MS = 7 * 86_400_000;

router.get("/:id/skills", ...AUTH, CAN_READ, async (req: Request, res: Response) => {
  try {
    const out = await getAgentSkills(req.tenantId!, String(req.params.id), new Date(Date.now() - WEEK_MS));
    if (!out) { res.status(404).json({ error: "AI employee not found" }); return; }
    res.json({ data: out });
  } catch (err: any) {
    console.error("[agent-skills] read failed:", err?.message);
    res.status(500).json({ error: "Failed to read the employee's skills" });
  }
});

// The FULL list: [{ skillId, mode: on|watch|off, order }]. Absent = removed.
router.put("/:id/skills", ...AUTH, CAN_WRITE, async (req: Request, res: Response) => {
  try {
    const items = Array.isArray(req.body) ? req.body : req.body?.skills;
    const out = await setAgentSkills(req.tenantId!, String(req.params.id), items);
    if (!out) { res.status(404).json({ error: "AI employee not found" }); return; }
    res.json({ data: out });
  } catch (err: any) {
    if (err instanceof SkillValidationError) { res.status(422).json({ error: err.message, field: err.field, code: "INVALID_SKILLS" }); return; }
    console.error("[agent-skills] write failed:", err?.message);
    res.status(500).json({ error: "Failed to save the employee's skills" });
  }
});

router.post("/:id/skills/fit", ...AUTH, CAN_READ, async (req: Request, res: Response) => {
  try {
    const skillId = typeof req.body?.skillId === "string" ? req.body.skillId : "";
    if (!skillId) { res.status(422).json({ error: "skillId is required" }); return; }
    const out = await fitCheck(req.tenantId!, String(req.params.id), skillId);
    if (!out) { res.status(404).json({ error: "AI employee or skill not found" }); return; }
    res.json({ data: out });
  } catch (err: any) {
    console.error("[agent-skills] fit check failed:", err?.message);
    res.status(500).json({ error: "Failed to check the skill against the employee" });
  }
});

export default router;
