/**
 * Invoice and payment history (read-only).
 *
 * Each Invoice mirrors an iCount-issued legal document; providerInvoiceRef and
 * providerPdfUrl point at the authoritative copy.
 *
 * Every row carries BOTH figures - the agreed price and the shekels actually
 * taken. A customer looking at their bank statement sees the second one, so
 * showing only the first turns "why was I charged 1,821?" into a support
 * conversation, and sometimes into a chargeback.
 */
import { Router } from "express";
import { authenticate, resolveTenant, requirePermission, prisma } from "@chatcenter/shared";
import { getEntityIdForTenant } from "../services/billable-entity.service";

const router = Router();

router.get(
  "/billing/invoices",
  authenticate,
  resolveTenant,
  requirePermission("settings:billing:manage"),
  async (req, res) => {
    const entityId = await getEntityIdForTenant(req.tenantId!);
    if (!entityId) return res.json({ invoices: [] });

    const invoices = await prisma.invoice.findMany({
      where: { billableEntityId: entityId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { charges: { orderBy: { createdAt: "desc" } } },
    });

    // Shaped rather than returned whole: the raw rows carry idempotency keys and
    // provider transaction references, which are internal plumbing and give a
    // customer nothing they can act on.
    res.json({
      invoices: invoices.map((inv) => ({
        id: inv.id,
        type: inv.type,
        status: inv.status,
        amount: String(inv.amount),
        currency: inv.currency,
        issuedAt: inv.issuedAt,
        paidAt: inv.paidAt,
        providerInvoiceRef: inv.providerInvoiceRef,
        providerPdfUrl: inv.providerPdfUrl,
        lineItems: inv.lineItems,
        createdAt: inv.createdAt,
        charges: inv.charges.map((c) => ({
          id: c.id,
          status: c.status,
          amount: String(c.amount),
          currency: c.currency,
          // What the card was actually debited, and the rate behind it.
          chargeAmount: c.chargeAmount == null ? null : String(c.chargeAmount),
          chargeCurrency: c.chargeCurrency,
          exchangeRate: c.fxRate == null ? null : Number(c.fxRate).toFixed(4),
          attemptNumber: c.attemptNumber,
          createdAt: c.createdAt,
        })),
      })),
    });
  },
);

export default router;
