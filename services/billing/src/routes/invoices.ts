/**
 * Invoice + payment history (read-only). Each Invoice mirrors an iCount-issued
 * legal document (providerInvoiceRef / providerPdfUrl is the authoritative copy).
 */
import { Router } from "express";
import { authenticate, resolveTenant, requirePermission, prisma } from "@chatcenter/shared";
import { getEntityIdForTenant } from "../services/billable-entity.service";

const router = Router();

router.get("/billing/invoices", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  const entityId = await getEntityIdForTenant(req.tenantId!);
  if (!entityId) return res.json({ invoices: [] });
  const invoices = await prisma.invoice.findMany({ where: { billableEntityId: entityId }, orderBy: { createdAt: "desc" }, take: 100, include: { charges: true } });
  res.json({ invoices });
});

export default router;
