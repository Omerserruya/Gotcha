/**
 * AI Skills catalog endpoint.
 *
 * Returns the system's registered skills (operational / language /
 * execution) so the AI Employee wizard can render real options instead
 * of hardcoded labels. The skills registry self-populates at module load
 * via the side-effect import below — importing this route is what
 * guarantees the registry is live in the running ai service.
 */

import { Router, Request, Response } from "express";
import { authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";

// Side-effect import: every system skill self-registers at module load
// time via defineSkill(). Importing the index here means the registry is
// populated as soon as the ai service mounts this router.
import { listSkillMetadata } from "../worker/skills";

const router = Router();

router.use(authenticate, resolveTenant, requireActiveTenant());

/**
 * GET /api/ai-skills
 *
 * Returns the catalog of system skills available to compose into an AI
 * Employee. Grouped by `kind` (operational / language / execution) for
 * the wizard's checklist UI.
 */
router.get("/", (_req: Request, res: Response) => {
  try {
    const skills = listSkillMetadata();
    const grouped: Record<string, typeof skills> = {
      operational: [],
      language: [],
      execution: [],
    };
    for (const s of skills) {
      const kind = (s as any).kind ?? "operational";
      if (!grouped[kind]) grouped[kind] = [];
      grouped[kind].push(s);
    }
    res.json({
      data: { skills, grouped, count: skills.length },
    });
  } catch (err: any) {
    console.error("[ai-skills] list error:", err?.message);
    res.status(500).json({ error: "failed_to_list_skills" });
  }
});

export default router;
