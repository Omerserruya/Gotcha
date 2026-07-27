/**
 * The iCount IPN endpoint.
 *
 * POST /api/billing/providers/icount/ipn
 *
 * An IPN is a HINT THAT SOMETHING MAY HAVE HAPPENED. Nothing else. It is an
 * unauthenticated POST from the public internet, and this route treats it that
 * way: it never reads a payment outcome, a token, an amount or a status off the
 * body and acts on it. What it does is look up whether it knows the session
 * being referred to, and if so, ask iCount directly - server to server, with
 * our own credentials - what actually happened.
 *
 * So a forged IPN can achieve exactly one thing: cause us to ask iCount a
 * question we were going to ask anyway. It cannot mark a payment successful,
 * verify a card, activate a subscription, grant credits or change a tenant's
 * status, because none of those decisions read this payload.
 *
 * WHY THERE IS NO SIGNATURE CHECK HERE
 *
 * The existing webhook route requires an `x-icount-signature` HMAC header. That
 * header is not something iCount sends - it was a contract invented on this
 * side. Requiring it does not make the endpoint secure, it makes it INERT:
 * every genuine notification is rejected with 401 and the integration silently
 * never works. (ICOUNT_WEBHOOK_SECRET is also unset, so that route currently
 * rejects everything unconditionally.)
 *
 * The honest fix is not a secret iCount cannot produce. It is to stop needing
 * one, by making the payload incapable of causing harm. That is the design
 * above: authentication would add nothing here because nothing here is
 * trusted. INTERNAL_BILLING_WEBHOOK_FORWARD_SECRET covers the different
 * question of whether the gateway forwarded this, which is an internal hop and
 * genuinely can be authenticated.
 */
import { Router } from "express";
import { createHash } from "crypto";
import { prisma } from "@chatcenter/shared";
import { redactEventPayload, MAX_EVENT_BODY_BYTES } from "../services/provider-event.service";
import { verifyTokenizationSession } from "../services/tokenization.service";

const router = Router();

/**
 * Every field the payload might carry our reference in.
 *
 * `x_order_id` is the documented correlation field. The others are what this
 * integration actually sends and receives - `custom_client_id` is the reference
 * attached to the client, and `sale_uniqid` is iCount's own id for the session,
 * both confirmed against the live account.
 *
 * All are treated as UNTRUSTED LOOKUP KEYS and nothing more. A value here
 * selects which of our own records to re-verify; it never supplies a fact.
 */
const CORRELATION_FIELDS = ["x_order_id", "custom_client_id", "sale_uniqid", "sale_sid"] as const;

/** A reference we minted, or nothing. Never a value we act on. */
function correlationCandidates(body: any): string[] {
  const out: string[] = [];
  for (const field of CORRELATION_FIELDS) {
    const v = body?.[field];
    if (typeof v === "string" && v.length > 0 && v.length <= 200) out.push(v);
    else if (typeof v === "number") out.push(String(v));
  }
  return out;
}

function deliveryId(body: any, rawBody: string): string {
  const candidate = body?.event_id ?? body?.id ?? body?.sale_uniqid;
  if (candidate) return `ipn:${String(candidate)}`;
  return `ipn:sha:${createHash("sha256").update(rawBody).digest("hex").slice(0, 40)}`;
}

/**
 * Find the session this notification might be about.
 *
 * Matches only against references WE generated. A payload naming something we
 * never issued matches nothing, which is the intended outcome: an attacker
 * cannot point this at a record of their choosing, only at one they already
 * knew the reference for - and knowing it still only triggers a pull.
 */
async function findSession(candidates: string[]) {
  if (candidates.length === 0) return null;
  return prisma.tokenizationSession.findFirst({
    where: { OR: [{ customClientId: { in: candidates } }, { id: { in: candidates } }] },
    select: { id: true, status: true },
  });
}

router.post("/billing/providers/icount/ipn", async (req, res) => {
  const rawBody = (req as any).rawBody
    ? (req as any).rawBody.toString("utf8")
    : JSON.stringify(req.body ?? {});

  // An endpoint the internet can reach must not accept arbitrary volume into
  // the database.
  if (Buffer.byteLength(rawBody, "utf8") > MAX_EVENT_BODY_BYTES) {
    return res.status(413).json({ error: "payload_too_large" });
  }

  const body = req.body ?? {};
  const providerEventId = deliveryId(body, rawBody);

  // Record first, always, whether or not it correlates to anything. An
  // uncorrelated notification is exactly the evidence someone needs when a
  // customer says they paid and we have no record of it.
  let firstDelivery = true;
  try {
    await prisma.billingWebhookEvent.create({
      data: {
        provider: "ICOUNT",
        providerEventId,
        eventType: "ipn",
        payload: redactEventPayload(body) as any,
        // RECEIVED, never PROCESSED. Nothing about this payload is acted on;
        // the verification below reaches its own conclusion from iCount.
        status: "RECEIVED",
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      // A redelivery. Still fall through to verification: the first delivery
      // may have arrived before the card was actually stored, and refusing to
      // re-check would strand a customer who did pay.
      firstDelivery = false;
    } else {
      console.error("[billing/ipn] persist error:", err?.message ?? err);
    }
  }

  const session = await findSession(correlationCandidates(body)).catch(() => null);

  if (session) {
    try {
      // The only thing that establishes what happened: our own server-to-server
      // pull against client/get_cc_tokens, compared to the fingerprints taken
      // before this session started. The IPN's role ends here.
      await verifyTokenizationSession(session.id);
    } catch (err: any) {
      console.error("[billing/ipn] verification error:", err?.message ?? err);
    }
  }

  // Always 200, and never a body that reveals whether the reference matched.
  // A provider retrying forever helps nobody, and an endpoint that answers
  // "yes that is a real session" is an oracle for enumerating references.
  return res.json({ ok: true, deduped: !firstDelivery });
});

export default router;
