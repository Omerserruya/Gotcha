/**
 * Reasoner shadow - agreement dashboard over the PERMANENT evaluation corpus
 * (`reasoner_shadow_evals`). Read-only: it never triggers reasoning, only queries
 * rows the dark shadow runner already persisted. Provider-neutral throughout.
 *
 * This is the evidence surface the user reviews BEFORE the Reasoner is allowed to
 * own any business decision:
 *   GET /summary       - agreement rate + divergence-axis breakdown + avg latency
 *   GET /divergences   - the review queue (recent disagreements, newest first)
 *   GET /:id           - one full record incl. the replayable reasonerInput
 *
 * Tenant-scoped (never cross-tenant) + ADMIN-only, matching sibling admin routes.
 */

import { Router, Request, Response } from "express";
import { authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";
import {
  getAgreementSummary,
  listRecentDivergences,
  getShadowEvalById,
} from "../services/reasoner/shadow-runner";
import type { DivergenceAxis } from "@chatcenter/shared";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

const AXES: DivergenceAxis[] = ["none", "move_type", "operation", "field"];
function parseAxis(v: unknown): DivergenceAxis | undefined {
  return typeof v === "string" && (AXES as string[]).includes(v) ? (v as DivergenceAxis) : undefined;
}
function parseSince(v: unknown): Date | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

// GET /summary - parity headline, sliceable by provider/model/promptVersion/since.
router.get("/summary", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { provider, model, promptVersion, since } = req.query;
    const summary = await getAgreementSummary({
      tenantId: req.tenantId!,
      provider: provider as string | undefined,
      model: model as string | undefined,
      promptVersion: promptVersion as string | undefined,
      since: parseSince(since),
    });
    res.json({ data: summary });
  } catch (err) {
    console.error("Reasoner shadow summary error:", err);
    res.status(500).json({ error: "Failed to compute agreement summary" });
  }
});

// GET /divergences - the review queue: recent disagreements, newest first.
router.get("/divergences", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { provider, model, promptVersion, axis, since, limit } = req.query;
    const rows = await listRecentDivergences({
      tenantId: req.tenantId!,
      provider: provider as string | undefined,
      model: model as string | undefined,
      promptVersion: promptVersion as string | undefined,
      axis: parseAxis(axis),
      since: parseSince(since),
      limit: limit ? Number(limit) : undefined,
    });
    res.json({ data: rows });
  } catch (err) {
    console.error("Reasoner shadow divergences error:", err);
    res.status(500).json({ error: "Failed to list divergences" });
  }
});

// GET /:id - one full record (incl. replayable reasonerInput) for deep review.
router.get("/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const record = await getShadowEvalById(req.tenantId!, req.params.id as string);
    if (!record) {
      res.status(404).json({ error: "Shadow eval not found" });
      return;
    }
    res.json({ data: record });
  } catch (err) {
    console.error("Reasoner shadow record error:", err);
    res.status(500).json({ error: "Failed to get shadow eval record" });
  }
});

export default router;
