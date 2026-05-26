/**
 * Post-Conversation Config — admin API for the per-tenant schema that
 * drives the end-of-call / end-of-chat summarizer + rule engine.
 *
 * Routes (mounted at /api/post-conversation-config):
 *   GET  /            — fetch the tenant's config (returns defaults if empty)
 *   PUT  /            — replace the tenant's config (partial patch allowed)
 *
 * Auth: tenant ADMIN only.
 */

import { Router, type Request, type Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireRole,
} from "@chatcenter/shared";
import {
  getPostConversationConfig,
  setPostConversationConfig,
  type PostConversationConfig,
} from "../services/post-conversation-config.service";

const router = Router();

router.get(
  "/",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  requireRole("ADMIN"),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "tenant required" });
      return;
    }
    const cfg = await getPostConversationConfig(tenantId);
    res.json({ ok: true, config: cfg });
  },
);

router.put(
  "/",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  requireRole("ADMIN"),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "tenant required" });
      return;
    }
    const body = (req.body ?? {}) as Partial<PostConversationConfig>;
    if (typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "body must be an object" });
      return;
    }
    const next = await setPostConversationConfig(tenantId, body);
    res.json({ ok: true, config: next });
  },
);

export default router;
