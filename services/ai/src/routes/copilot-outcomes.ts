/**
 * POST /api/copilot/cue-outcome - rep feedback on a live copilot cue.
 *
 * This is the write side of the trust loop:
 *   1. Persist the outcome (CopilotCueOutcome row).
 *   2. Release the cue from the live projector dedup map - accepted /
 *      rejected suppress for the rest of the call, ignored allows it to
 *      resurface once weight clears the threshold again.
 *   3. Trigger a fire-and-forget trust-weights refresh so the next surfaced
 *      cue picks up the new weight quickly (otherwise stale up to 5 min).
 *
 * Conversation ownership is enforced before any write - same pattern as
 * voice-assist.service (don't leak existence across tenants).
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  authenticate,
  resolveTenant,
  requireActiveTenant,
  prisma,
} from "@chatcenter/shared";
import { recordOutcome } from "../services/intelligence/trust/cue-outcomes.repo";
import { trustWeights } from "../services/intelligence/trust/trust-weights.service";
import { cueProjector } from "../services/intelligence/cue-projector";

const body = z.object({
  cueId: z.string().min(1).max(256),
  conversationId: z.string().min(1).max(64),
  cueKind: z.enum(["missing_field", "suggested_action", "risk"]),
  cueText: z.string().min(1).max(512),
  dedupKey: z.string().min(1).max(256),
  outcome: z.enum(["accepted", "rejected", "ignored"]),
});

const router = Router();

router.post(
  "/cue-outcome",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  async (req: Request & { tenantId?: string }, res: Response) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "malformed", details: parsed.error.issues });
      return;
    }
    const tenantId = req.tenantId ?? "";
    if (!tenantId) {
      res.status(401).json({ error: "no_tenant" });
      return;
    }
    const { conversationId, dedupKey, outcome } = parsed.data;

    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { id: true },
    });
    if (!conv) {
      res.status(403).json({ error: "cross_tenant_denied" });
      return;
    }

    await recordOutcome({ tenantId, ...parsed.data });
    cueProjector.release(conversationId, dedupKey, outcome);
    // Don't block on weight refresh - the projector reads the cache on the
    // next turn, which is debounced 1500ms by LiveCadence anyway.
    void trustWeights.refresh();

    res.status(200).json({ ok: true });
  },
);

export default router;
