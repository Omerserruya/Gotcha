/**
 * Provider webhooks (iCount). Signature-verified; persisted; idempotent.
 *
 * EVERY received webhook is written to BillingWebhookEvent (raw payload + status)
 * BEFORE processing, keyed by a unique providerEventId so a redelivery is a
 * no-op. This is the audit spine: any money event can be reconstructed months
 * later from this log + the Charge/Invoice/ledger rows it touched.
 *
 * Uses the raw body for HMAC verification (captured by service-app's rawBody).
 */
import { Router } from "express";
import { prisma } from "@chatcenter/shared";
import { getProvider } from "../providers";
import { applyChargeback, applyRefundConfirmation } from "../services/refund.service";

const router = Router();

/** Stable id for dedup: prefer the provider's event id, else derive one. */
function eventId(event: any): string {
  return String(
    event.event_id || event.id ||
    `${event.type ?? "unknown"}:${event.confirmation_code || event.deal_id || event.txn_id || "na"}`,
  );
}

router.post("/billing/webhooks/icount", async (req, res) => {
  const provider = getProvider("ICOUNT");
  const rawBody = (req as any).rawBody ? (req as any).rawBody.toString("utf8") : JSON.stringify(req.body ?? {});
  if (!provider.verifyWebhook({ headers: req.headers as any, rawBody })) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  const event = req.body ?? {};
  const providerEventId = eventId(event);
  const eventType = String(event.type ?? "unknown");
  const chargeRef = event.confirmation_code || event.deal_id || event.txn_id;

  // Resolve the tenant (best-effort) for the audit row.
  let tenantId: string | undefined;
  if (chargeRef) {
    const charge = await prisma.charge.findFirst({ where: { providerChargeRef: String(chargeRef) }, include: { invoice: true } });
    if (charge) {
      const link = await prisma.billableEntityTenant.findFirst({ where: { billableEntityId: charge.invoice.billableEntityId } });
      tenantId = link?.tenantId;
    }
  }

  // Persist FIRST (dedup on providerEventId). A redelivery short-circuits.
  try {
    await prisma.billingWebhookEvent.create({
      data: { provider: "ICOUNT", providerEventId, eventType, tenantId, payload: event, status: "RECEIVED" },
    });
  } catch (err: any) {
    if (err?.code === "P2002") return res.json({ ok: true, deduped: true });
    console.error("[billing/webhook] persist error:", err?.message ?? err);
    return res.json({ ok: true }); // ack; reconciliation job is the backstop
  }

  let status = "IGNORED";
  let error: string | undefined;
  try {
    if (chargeRef && eventType === "payment.refunded") {
      const r = await applyRefundConfirmation({ providerChargeRef: String(chargeRef), reason: event.reason });
      status = r.ok ? "PROCESSED" : "IGNORED";
    } else if (chargeRef && (eventType === "payment.chargeback" || eventType === "payment.disputed")) {
      const r = await applyChargeback({ providerChargeRef: String(chargeRef), reason: event.reason });
      status = r.ok ? "PROCESSED" : "IGNORED";
    }
  } catch (err: any) {
    status = "FAILED";
    error = err?.message ?? String(err);
    console.error("[billing/webhook] handler error:", error);
  }

  await prisma.billingWebhookEvent.update({
    where: { providerEventId },
    data: { status, error, processedAt: new Date() },
  }).catch(() => {});

  // Always ack so the provider stops retrying; FAILED rows are the backstop.
  return res.json({ ok: true });
});

export default router;
