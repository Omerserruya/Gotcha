/**
 * POST /api/internal/relevance/classify - the label for one conversation, NOW (2026-11-22).
 *
 * INTERNAL ONLY. The incoming-worker calls it on a conversation's first inbound (and on an unlabelled old
 * one's next inbound) BEFORE any automation or the AI acts, so a hidden label stops them from the first
 * message (packages/shared relevance-hidden.ts). The model call lives here because new model calls belong
 * only in this service.
 *
 * The same path as the 2-minute job (processRelevanceJob): a person's override first and untouched, the
 * account filter, the sender rule, the fast rules, then one model call, and the write through the
 * conversation service. Its own short timeout: the worker waits for it.
 *
 * Always 200 with { category, confidence, source }. source "error" (timeout included) means no label:
 * the worker goes on as before and the 2-minute job labels it.
 */
import { Router, type Request, type Response } from "express";
import { requireInternalKey } from "@chatcenter/shared";
import { processRelevanceJob } from "../workers/relevance/worker";

/** Below the worker's own 3 s cap, so the answer arrives before the worker gives up on the call. */
export const INLINE_CLASSIFY_TIMEOUT_MS = 2700;

const router = Router();

router.post("/internal/relevance/classify", requireInternalKey, async (req: Request, res: Response) => {
  const { tenantId, conversationId } = (req.body ?? {}) as { tenantId?: string; conversationId?: string };
  if (!tenantId || !conversationId) {
    res.status(400).json({ error: "tenantId and conversationId are required" });
    return;
  }
  const started = Date.now();
  try {
    const r = await processRelevanceJob({ tenantId, conversationId }, { timeoutMs: INLINE_CLASSIFY_TIMEOUT_MS });
    const ms = Date.now() - started;
    console.log(`[relevance] inline conv=${conversationId} source=${r?.source ?? "none"} category=${r?.category ?? "-"} ms=${ms}`);
    res.json({ data: { category: r?.category ?? null, confidence: r?.confidence ?? null, source: r?.source ?? null, ms } });
  } catch (err) {
    console.warn(`[relevance] inline conv=${conversationId} failed ms=${Date.now() - started}:`, (err as Error)?.message);
    res.json({ data: { category: null, confidence: null, source: "error", ms: Date.now() - started } });
  }
});

export default router;
