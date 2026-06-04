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
 * A WebhookTrigger is bound to a ChatbotFlow (`workflowId`) — the anchor that
 * provisions the URL and identifies the trigger node on the canvas. Its
 * `targetMode` decides what an authenticated inbound POST runs: "flow" runs that
 * associated ChatbotFlow; "connected" walks the nodes wired to the webhook
 * trigger node on the Main Playbook canvas (see executeWebhookFlow). There is at
 * most ONE trigger per (tenant, workflow); create is idempotent and returns the
 * existing record (reconciling its mode if the caller passes a different one).
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

// Declared body-field types the UI offers. Anything else is normalized to
// "string". Keep in sync with the frontend WebhookFieldType union.
type WebhookFieldType = "string" | "number" | "boolean";
const FIELD_TYPES: readonly WebhookFieldType[] = ["string", "number", "boolean"];
const MAX_BODY_FIELDS = 50;

// Coerce a stored / submitted body schema (Prisma Json column, or request body)
// into a clean [{ key, type }] array: drops blank keys, de-dupes by key, clamps
// unknown types to "string" and caps the count. Declaration only — this never
// rejects, it just sanitizes what the mapper will read.
function normalizeBodySchema(raw: unknown): { key: string; type: WebhookFieldType }[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: { key: string; type: WebhookFieldType }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const key = String((item as { key?: unknown }).key ?? "").trim();
    if (!key || seen.has(key)) continue;
    const t = (item as { type?: unknown }).type;
    const type: WebhookFieldType = FIELD_TYPES.includes(t as WebhookFieldType)
      ? (t as WebhookFieldType)
      : "string";
    seen.add(key);
    out.push({ key, type });
    if (out.length >= MAX_BODY_FIELDS) break;
  }
  return out;
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
  targetMode: string;
  bodySchema?: unknown;
}) {
  return {
    id: t.id,
    workflowId: t.workflowId,
    token: t.token,
    secret: t.secret,
    enabled: t.enabled,
    // "flow" | "connected" — what the inbound POST runs. See WebhookTrigger model.
    targetMode: t.targetMode === "connected" ? "connected" : "flow",
    // User-declared body fields the mapper binds from. Declaration only.
    bodySchema: normalizeBodySchema(t.bodySchema),
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
    // Optional at create — defaults to the original flow behavior. Anything
    // other than "connected" is normalized to "flow". `hasMode` distinguishes
    // "caller omitted it" (don't reconcile an existing record) from "caller
    // explicitly chose flow".
    const hasMode = req.body?.targetMode !== undefined;
    const targetMode = req.body?.targetMode === "connected" ? "connected" : "flow";

    // Optional declared body schema. Must be an array if present (declaration
    // only — sanitized, never used to reject inbound payloads).
    const hasSchema = req.body?.bodySchema !== undefined;
    if (hasSchema && !Array.isArray(req.body.bodySchema)) {
      return res.status(400).json({ error: "bodySchema must be an array" });
    }
    const bodySchema = normalizeBodySchema(req.body?.bodySchema);

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
      // Idempotent create still reconciles fields the caller explicitly passed
      // (keeps the node config and the trigger record in sync). When nothing was
      // sent, return the existing record untouched.
      const patch: { targetMode?: string; bodySchema?: typeof bodySchema } = {};
      if (hasMode && existing.targetMode !== targetMode) patch.targetMode = targetMode;
      if (hasSchema) patch.bodySchema = bodySchema;
      if (Object.keys(patch).length > 0) {
        const synced = await prisma.webhookTrigger.update({
          where: { id: existing.id },
          data: patch,
        });
        return res.json({ data: serialize(synced) });
      }
      return res.json({ data: serialize(existing) });
    }

    const created = await prisma.webhookTrigger.create({
      data: {
        tenantId: req.tenantId!,
        workflowId,
        token: generateToken(),
        secret: generateSecret(),
        enabled: true,
        targetMode,
        bodySchema,
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
 * PATCH /api/webhook-triggers/:id  { enabled?, targetMode?, bodySchema? }
 * Update the trigger's enabled flag, its target mode ("flow" | "connected"),
 * and/or its declared body schema ([{ key, type }]). At least one field is
 * required. A disabled trigger answers inbound POSTs with 403 (see
 * routes/triggers.ts). bodySchema is declaration only — it is not enforced
 * against inbound payloads.
 */
router.patch("/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const hasEnabled = typeof req.body?.enabled === "boolean";
    const hasMode = req.body?.targetMode !== undefined;
    const hasSchema = req.body?.bodySchema !== undefined;
    if (!hasEnabled && !hasMode && !hasSchema) {
      return res.status(400).json({ error: "enabled (boolean), targetMode, or bodySchema is required" });
    }
    if (hasMode && req.body.targetMode !== "flow" && req.body.targetMode !== "connected") {
      return res.status(400).json({ error: 'targetMode must be "flow" or "connected"' });
    }
    if (hasSchema && !Array.isArray(req.body.bodySchema)) {
      return res.status(400).json({ error: "bodySchema must be an array" });
    }
    const trigger = await prisma.webhookTrigger.findFirst({
      where: { id, tenantId: req.tenantId! },
    });
    if (!trigger) {
      return res.status(404).json({ error: "Trigger not found" });
    }
    const data: {
      enabled?: boolean;
      targetMode?: string;
      bodySchema?: { key: string; type: WebhookFieldType }[];
    } = {};
    if (hasEnabled) data.enabled = req.body.enabled;
    if (hasMode) data.targetMode = req.body.targetMode;
    if (hasSchema) data.bodySchema = normalizeBodySchema(req.body.bodySchema);
    const updated = await prisma.webhookTrigger.update({
      where: { id: trigger.id },
      data,
    });
    return res.json({ data: serialize(updated) });
  } catch (err) {
    console.error("[WEBHOOK] toggle trigger error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
