import { Router, Request, Response } from "express";
import { requireInternalKey } from "@chatcenter/shared";
import * as conversationService from "../services/conversation.service";

/**
 * The relevance classifier's write (2026-11-17, docs/architecture/conversation-relevance.md): the ai
 * service labels a conversation and writes the label here, through this service, not to the table.
 *
 * Internal key only, and outside /api so the gateway never routes to it. The tenant comes from the
 * x-tenant-id header and scopes the write. A person's override is never replaced.
 */
export function internalRelevanceRouter(): Router {
  const router = Router();
  router.put("/internal/conversations/:id/relevance", requireInternalKey, async (req: Request, res: Response) => {
    const tenantId = String(req.header("x-tenant-id") ?? "").trim();
    if (!tenantId) { res.status(400).json({ error: "x-tenant-id is required" }); return; }
    try {
      const out = await conversationService.setClassifiedRelevance(tenantId, String(req.params.id), req.body ?? {});
      if (out === null) { res.status(404).json({ error: "Conversation not found" }); return; }
      res.json({ data: out.relevance, written: out.written });
    } catch (err: any) {
      if (err?.status === 400) { res.status(400).json({ error: err.message }); return; }
      console.error("Internal relevance write error:", err);
      res.status(500).json({ error: "Failed to write relevance" });
    }
  });
  return router;
}
