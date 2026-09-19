/**
 * GET /api/customer-card/:approvalId - who the person behind an approval is.
 *
 * Screen 03's detail pane: tenure, orders, lifetime value, prior refunds, mood.
 *
 * DETAIL PANE ONLY. NOT FOR THE LIST.
 * Commerce facts are two LIVE calls to the merchant's store per customer with
 * no cache anywhere. A queue of twenty approvals would be forty vendor round
 * trips. This is keyed on one approval on purpose.
 *
 * EVERY FIELD IS INDEPENDENTLY NULLABLE AND CARRIES ITS OWN REASON.
 * Not decoration. On an approval that is itself a refund decision, "this
 * customer has never been refunded" is the fact most likely to swing the
 * outcome - and "we asked and found none", "we could not ask" and "we did not
 * ask" would otherwise all render as the word None. A null here always says
 * which of those it is.
 *
 * THREE FIELDS THAT LOOK RIGHT AND ARE NOT, deliberately unused:
 *
 *   Contact.createdAt            when WE first made the row, not when they
 *                                became a customer
 *   CustomerProfile.firstSeenAt  `new Date()` at the moment the ingestion
 *                                pipeline first processed them. A customer of
 *                                three years ingested today reads as new.
 *   CustomerProfile.lastSeenAt   written with the same `now` on every update,
 *                                so it is pipeline activity wearing a
 *                                customer-activity name.
 *
 * All three are wrong in the same direction - they undersell a long
 * relationship - and all three are convincing enough to reach for. Tenure is
 * the store's own first-order date or it is null with a reason. There is no
 * third option.
 */
import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";
import { loadCustomerContext } from "../services/memory/customer-context.service";
import { loadCustomerCommerceFacts } from "../services/customer-commerce-facts.service";

const router = Router();

router.use("/customer-card", authenticate, resolveTenant, requireActiveTenant());

/** A value that may be absent, and always says why when it is. */
type Field<T> = { value: T | null; reason: string | null };
const known = <T,>(value: T): Field<T> => ({ value, reason: null });
const absent = <T,>(reason: string): Field<T> => ({ value: null, reason });

router.get("/customer-card/:approvalId", async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const approvalId = String(req.params.approvalId);

  try {
    const approval = await (prisma as any).approvalRequest.findFirst({
      where: { id: approvalId, tenantId },
      select: { id: true, conversationId: true },
    });
    if (!approval) {
      res.status(404).json({ error: "approval not found" });
      return;
    }

    // An approval raised by the System Copilot has no conversation by design,
    // so there is no customer to describe. That is a fact about the approval,
    // not a failure, and it is the reason every commerce field carries.
    const conversationId: string | null = approval.conversationId ?? null;
    if (!conversationId) {
      res.json({
        data: {
          approvalId,
          tenure: absent<string>("approval_has_no_conversation"),
          orders: absent<number>("approval_has_no_conversation"),
          lifetimeValue: { amount: null, currency: null, reason: "approval_has_no_conversation" },
          priorRefunds: absent<number>("approval_has_no_conversation"),
          sentiment: { value: null, score: null, analyzedAt: null, reason: "approval_has_no_conversation" },
        },
      });
      return;
    }

    // Sentiment is our own table and cheap - one indexed read, no vendor call.
    // `analyzedAt` ALWAYS ships with it. A mood with no date is a claim about a
    // person that the reader cannot age: on this tenant the newest analysis is
    // seven weeks old, and "Frustrated" without "as of 2 August" would be a
    // stale label presented as current.
    const intel = await (prisma as any).conversationIntelligence
      .findFirst({
        where: { conversationId, tenantId },
        select: { sentiment: true, sentimentScore: true, analyzedAt: true },
      })
      .catch(() => null);

    // Commerce needs the store's own identity for this person. Resolution can
    // fail for a reason that is not an error - a customer who has only ever
    // messaged and never bought is simply not in the store.
    const bundle = await loadCustomerContext({ tenantId, conversationId, summaryLimit: 1, crmNoteLimit: 1 }).catch(
      () => null,
    );

    let facts: Awaited<ReturnType<typeof loadCustomerCommerceFacts>> = null;
    let commerceReason: string | null = null;
    if (!bundle) {
      commerceReason = "customer_identity_unresolved";
    } else if (!bundle.crmContactId || !bundle.crmObjectKind) {
      commerceReason = "customer_not_linked_to_store";
    } else {
      facts = await loadCustomerCommerceFacts({
        tenantId,
        crmContactId: bundle.crmContactId,
        crmObjectKind: bundle.crmObjectKind,
      }).catch(() => null);
      // A store that is disconnected, rate-limited or in ERROR lands here. The
      // caller MUST be able to tell this from a customer with no orders, which
      // is why it is a reason rather than a zero.
      if (!facts) commerceReason = "store_unavailable";
    }

    res.json({
      data: {
        approvalId,
        // The store's first-order date. See the header for the three fields
        // that look like this one and mean something else.
        tenure: facts
          ? facts.firstSeenOrderAt
            ? known(facts.firstSeenOrderAt)
            : absent<string>("store_has_no_first_order_date")
          : absent<string>(commerceReason ?? "store_unavailable"),
        orders: facts
          ? facts.ordersCount != null
            ? known(facts.ordersCount)
            : absent<number>("store_did_not_report_order_count")
          : absent<number>(commerceReason ?? "store_unavailable"),
        lifetimeValue: facts
          ? facts.totalSpent != null
            ? { amount: facts.totalSpent, currency: facts.currency ?? null, reason: null }
            : { amount: null, currency: null, reason: "store_did_not_report_total_spent" }
          : { amount: null, currency: null, reason: commerceReason ?? "store_unavailable" },
        // ALWAYS null today, and honestly so. Refunds exist per ORDER, not per
        // customer: answering this means iterating the customer's orders and
        // asking each, on top of the two calls already made. An honest "we did
        // not look" beats a wrong "None" on an approval about a refund.
        priorRefunds: absent<number>("requires_per_order_lookup"),
        sentiment: intel?.sentiment
          ? {
              value: intel.sentiment,
              score: intel.sentimentScore ?? null,
              analyzedAt: intel.analyzedAt ? new Date(intel.analyzedAt).toISOString() : null,
              reason: null,
            }
          : { value: null, score: null, analyzedAt: null, reason: "conversation_not_analysed" },
      },
    });
  } catch (err) {
    console.error("customer-card error:", err);
    res.status(500).json({ error: "Failed to build the customer card" });
  }
});

export default router;
