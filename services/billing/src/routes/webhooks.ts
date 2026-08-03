/**
 * Provider webhooks (iCount).
 *
 * This endpoint RECORDS. It does not act.
 *
 * That is a deliberate retreat from what it used to do. It previously read an
 * event `type` off the payload and, on `payment.chargeback`, suspended the
 * tenant and clawed back their credits. Two things were wrong with that, and
 * they compounded:
 *
 *   The event names were invented. iCount's callback contract has never been
 *   verified - it is the one gap the whole provider-event boundary exists to
 *   respect - so those strings matched nothing real, and the handler they
 *   guarded had never fired against a genuine iCount webhook.
 *
 *   The route is publicly reachable and, until now, accepted unsigned payloads
 *   outside live mode. Anyone able to reach it could suspend an organization
 *   and take away credits they had paid for, by posting a guessed event name.
 *
 * So: verify the signature, persist the payload, and stop. A human decides what
 * a chargeback means until the contract is confirmed. Losing a few hours before
 * reacting to a real dispute is recoverable; suspending a paying customer
 * because someone posted JSON is not.
 *
 * The persist-first spine is unchanged and remains the point: every received
 * event is written before anything looks at it, keyed by a unique event id so a
 * redelivery is a no-op, and any money event can be reconstructed from this log
 * plus the rows it touched.
 */
import { reportOperationalFailure, recordExpectedOutcome, ERROR_CODES } from "@chatcenter/shared";
import { Router } from "express";
import { createHash } from "crypto";
import { prisma } from "@chatcenter/shared";
import { getProvider } from "../providers";
import { redactEventPayload, MAX_EVENT_BODY_BYTES } from "../services/provider-event.service";

const router = Router();

/**
 * A stable id for deduplication.
 *
 * Derived from whatever the payload carries. This is NOT a claim about iCount's
 * field names - it is a best-effort key for "have I seen this exact delivery
 * before", and it falls back to a hash of the body so an unrecognised shape is
 * still deduplicated rather than stored repeatedly.
 */
function eventId(event: any, rawBody: string): string {
  const candidate = event?.event_id ?? event?.id;
  if (candidate) return String(candidate);
  // Not a semantic id, just a fingerprint of the delivery.
  return `sha:${createHash("sha256").update(rawBody).digest("hex").slice(0, 40)}`;
}

router.post("/billing/webhooks/icount", async (req, res) => {
  const provider = getProvider("ICOUNT");
  const rawBody = (req as any).rawBody ? (req as any).rawBody.toString("utf8") : JSON.stringify(req.body ?? {});

  // No valid signature, no record. An unsigned payload is a stranger's JSON.
  if (!provider.verifyWebhook({ headers: req.headers as any, rawBody })) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  // Bounded: an endpoint the internet can reach must not accept arbitrary
  // volume into the database.
  if (Buffer.byteLength(rawBody, "utf8") > MAX_EVENT_BODY_BYTES) {
    return res.status(413).json({ error: "payload_too_large" });
  }

  const event = req.body ?? {};
  const providerEventId = eventId(event, rawBody);

  // The type is recorded verbatim for whoever reviews it, and is NOT used to
  // choose a code path. That distinction is the whole fix.
  const eventType = String(event?.type ?? "unknown");

  try {
    await prisma.billingWebhookEvent.create({
      data: {
        provider: "ICOUNT",
        providerEventId,
        eventType,
        // No tenant is resolved from the payload. Looking a charge up by a
        // reference a stranger supplied is how a targeted payload finds a
        // victim; a reviewer can make that link deliberately.
        payload: redactEventPayload(event) as any,
        // Never PROCESSED. Nothing here processes anything.
        status: "RECEIVED",
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      // The provider replayed a delivery and the unique constraint caught it.
      // Working as designed, so a breadcrumb rather than an issue.
      recordExpectedOutcome("billing_webhook_deduped", { provider: "icount", eventType });
      return res.json({ ok: true, deduped: true });
    }
    console.error("[billing/webhook] persist error:", err?.message ?? err);
    // The signature verified, so this is a REAL provider event about real
    // money, and we just failed to record it. We still ack (a provider
    // retrying forever helps nobody), which means without this report the
    // event is simply gone.
    reportOperationalFailure({
      errorCode: ERROR_CODES.payment_callback_failed,
      domain: "billing", service: "billing", provider: "icount",
      cause: err,
      context: { stage: "persist_event", eventType },
    });
    // Still ack: a provider retrying forever helps nobody, and reconciliation
    // against cc/transactions is the real backstop for anything missed.
    return res.json({ ok: true });
  }

  return res.json({ ok: true });
});

export default router;
