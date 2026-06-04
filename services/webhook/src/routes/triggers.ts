import crypto from "crypto";
import { Router, Request, Response } from "express";
import {
  prisma,
  incomingMessageQueue,
  crossTenantMiddleware,
} from "@chatcenter/shared";
import type { WebhookTriggerJob } from "@chatcenter/shared";

const router = Router();

// Header carrying the shared secret. Basic auth only at this stage — no HMAC
// signature / IP allowlist yet (see WebhookTrigger model notes).
const SECRET_HEADER = "x-webhook-secret";

// Inbound webhook triggers arrive without a user JWT — the trigger (and its
// tenant) is resolved purely by the unguessable path `token`. That lookup is a
// legitimate cross-tenant query, so enable the Prisma tenant-guard opt-out for
// this router, exactly like the provider webhook router does. Safe because the
// route verifies the shared secret before emitting anything.
router.use(crossTenantMiddleware);

// Constant-time secret comparison — avoids leaking the secret via timing.
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * POST /webhooks/:token
 *
 * Generic inbound webhook entrypoint that fronts the WebhookTrigger model.
 * Authenticates the call and dispatches an event to incoming-worker over the
 * existing BullMQ "incoming-messages" transport. Running the flow / variable
 * injection happens downstream (ticket 3) — this route only authenticates and
 * enqueues, forwarding the raw JSON body intact.
 *
 *  - unknown token            → 404
 *  - missing / bad secret     → 401
 *  - trigger disabled         → 403
 *  - authenticated + enabled  → 200 (event enqueued)
 */
router.post("/:token", async (req: Request, res: Response) => {
  try {
    const token = String(req.params.token);

    const trigger = await prisma.webhookTrigger.findUnique({ where: { token } });
    if (!trigger) {
      return res.status(404).json({ error: "Unknown webhook token" });
    }

    // Verify the shared secret before revealing anything else (incl. the
    // enabled/disabled state) to an unauthenticated caller.
    const provided = req.header(SECRET_HEADER);
    if (!provided || !secretMatches(provided, trigger.secret)) {
      return res.status(401).json({ error: "Invalid or missing secret" });
    }

    if (!trigger.enabled) {
      return res.status(403).json({ error: "Webhook trigger is disabled" });
    }

    const job: WebhookTriggerJob = {
      triggerId: trigger.id,
      workflowId: trigger.workflowId,
      tenantId: trigger.tenantId,
      payload: req.body,
      // Drives whether the worker runs the associated flow or walks the nodes
      // wired to the trigger node on the canvas. Anything other than "connected"
      // falls back to the original flow behavior.
      targetMode: trigger.targetMode === "connected" ? "connected" : "flow",
    };

    await incomingMessageQueue.add("webhook-trigger", job, {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[WEBHOOK] trigger ingest error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
