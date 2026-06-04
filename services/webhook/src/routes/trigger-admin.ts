import crypto from "crypto";
import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireRole,
} from "@chatcenter/shared";

/**
 * Authenticated management API for WebhookTrigger records.
 *
 * Separate from the public ingest route (routes/triggers.ts): that one is
 * unauthenticated and resolves the tenant from the unguessable path `token`.
 * This router is the opposite — it is JWT-authenticated and tenant-scoped, and
 * is what the Main Playbook's Webhook trigger node talks to from the browser to
 * provision / inspect / rotate / toggle a trigger for a given workflow.
 *
 * A WebhookTrigger is bound to a ChatbotFlow (`workflowId`) — that is the flow
 * ticket 3's executeWebhookFlow runs when an authenticated inbound POST hits
 * the ingest route. There is at most ONE trigger per (tenant, workflow); create
 * is idempotent and returns the existing record.
 *
 * Mounted at /api/webhook-triggers (the gateway's /api/webhook prefix already
 * proxies this path to the webhook service — no nginx change needed).
 */
const router = Router();

// Same middleware stack every other authenticated CRUD router uses. Writes are
// ADMIN-only, mirroring chatbot-flow mutations (services/chatbot chatbot.ts).
router.use(authenticate, resolveTenant, requireActiveTenant());

// Unguessable path segment that identifies the trigger in the public ingest
// URL. 24 random bytes → 48 hex chars.
function generateToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

// Shared secret the caller must send in the x-webhook-secret header. base64url
// keeps it header-safe and copy-pasteable.
function generateSecret(): string {
  return crypto.randomBytes(24).toString("base64url");
}

// Shape returned to the UI. `path` is the ingest path; the browser prefixes its
// own origin to build the full URL (the gateway routes /webhooks to this
// service on the same host).
function serialize(t: {
  id: string;
  workflowId: string;
  token: string;
  secret: string;
  enabled: boolean;
}) {
  return {
    id: t.id,
    workflowId: t.workflowId,
    token: t.token,
    secret: t.secret,
    enabled: t.enabled,
    path: `/webhooks/${t.token}`,
  };
}

/**
 * GET /api/webhook-triggers?workflowId=...
 * Returns the trigger for a workflow (tenant-scoped), or { data: null } if the
 * workflow has no trigger yet.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const workflowId = String(req.query.workflowId || "").trim();
    if (!workflowId) {
      return res.status(400).json({ error: "workflowId query param is required" });
    }
    const trigger = await prisma.webhookTrigger.findFirst({
      where: { tenantId: req.tenantId!, workflowId },
    });
    return res.json({ data: trigger ? serialize(trigger) : null });
  } catch (err) {
    console.error("[WEBHOOK] get trigger error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/webhook-triggers  { workflowId }
 * Idempotently provisions a trigger (token + secret) for a workflow the tenant
 * owns. Returns the existing trigger if one already exists.
 */
router.post("/", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const workflowId = String(req.body?.workflowId || "").trim();
    if (!workflowId) {
      return res.status(400).json({ error: "workflowId is required" });
    }

    // The trigger FK-binds to a ChatbotFlow; make sure it exists and belongs to
    // this tenant before minting credentials for it.
    const flow = await prisma.chatbotFlow.findFirst({
      where: { id: workflowId, tenantId: req.tenantId! },
    });
    if (!flow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    const existing = await prisma.webhookTrigger.findFirst({
      where: { tenantId: req.tenantId!, workflowId },
    });
    if (existing) {
      return res.json({ data: serialize(existing) });
    }

    const created = await prisma.webhookTrigger.create({
      data: {
        tenantId: req.tenantId!,
        workflowId,
        token: generateToken(),
        secret: generateSecret(),
        enabled: true,
      },
    });
    return res.status(201).json({ data: serialize(created) });
  } catch (err) {
    console.error("[WEBHOOK] create trigger error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/webhook-triggers/:id/regenerate-secret
 * Rotates the shared secret. The token (and therefore the URL) is unchanged.
 */
router.post(
  "/:id/regenerate-secret",
  requireRole("ADMIN"),
  async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const trigger = await prisma.webhookTrigger.findFirst({
        where: { id, tenantId: req.tenantId! },
      });
      if (!trigger) {
        return res.status(404).json({ error: "Trigger not found" });
      }
      const updated = await prisma.webhookTrigger.update({
        where: { id: trigger.id },
        data: { secret: generateSecret() },
      });
      return res.json({ data: serialize(updated) });
    } catch (err) {
      console.error("[WEBHOOK] regenerate secret error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * PATCH /api/webhook-triggers/:id  { enabled }
 * Enable / disable the trigger. A disabled trigger answers inbound POSTs with
 * 403 (see routes/triggers.ts).
 */
router.patch("/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled (boolean) is required" });
    }
    const trigger = await prisma.webhookTrigger.findFirst({
      where: { id, tenantId: req.tenantId! },
    });
    if (!trigger) {
      return res.status(404).json({ error: "Trigger not found" });
    }
    const updated = await prisma.webhookTrigger.update({
      where: { id: trigger.id },
      data: { enabled: req.body.enabled },
    });
    return res.json({ data: serialize(updated) });
  } catch (err) {
    console.error("[WEBHOOK] toggle trigger error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
