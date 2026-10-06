/**
 * Customers list - commerce data in bulk (see customer-commerce.service).
 *
 *   GET /api/commerce-context/customers/commerce-summary?contactIds=a,b,c
 *   GET /api/commerce-context/customers/segments
 *   GET /api/commerce-context/customers/by-order?number=1842
 *
 * Mounted BEFORE the commerce-context router so its "/:conversationId" route
 * can never shadow these paths.
 */
import { Router, type Request, type Response } from "express";
import { authenticate, resolveTenant, requireActiveTenant, requirePermission } from "@chatcenter/shared";
import { commerceSummaries, segmentCounts, contactByOrderNumber } from "../services/customer-commerce.service";
import { getCustomerOrders } from "../services/customer-orders.service";
import { principalOf, commercePerms } from "../services/commerce-perms";

const router = Router();
const MAX_IDS = 100;

router.use(authenticate, resolveTenant, requireActiveTenant(), requirePermission("customer:commerce:read"));

router.get("/commerce-summary", async (req: Request, res: Response) => {
  const ids = String(req.query.contactIds ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) { res.status(400).json({ error: "contactIds_required" }); return; }
  if (ids.length > MAX_IDS) { res.status(400).json({ error: "too_many_ids", max: MAX_IDS }); return; }
  try {
    res.json(await commerceSummaries(req.tenantId!, [...new Set(ids)]));
  } catch (err: any) {
    console.error("[customer-commerce] summary failed:", err?.message);
    res.status(500).json({ error: "commerce_summary_failed" });
  }
});

/**
 * GET /:contactId/orders?limit=10&locale=he - the customer's orders with
 * details, one OrderCard shape for WooCommerce and Shopify, each card marked
 * with how the customer was matched (verified / email / phone).
 */
router.get("/:contactId/orders", async (req: Request, res: Response) => {
  try {
    const perms = await commercePerms(principalOf(req as any));
    const out = await getCustomerOrders({
      tenantId: req.tenantId!,
      contactId: String(req.params.contactId),
      locale: (req.query.locale as string) || (req.headers["accept-language"] as string | undefined),
      limit: Number(req.query.limit) || undefined,
      perms,
    });
    if (out.source === null && out.reason === "contact_not_found") { res.status(404).json({ error: "contact_not_found" }); return; }
    res.json(out);
  } catch (err: any) {
    console.error("[customer-commerce] orders failed:", err?.message);
    res.status(500).json({ error: "customer_orders_failed" });
  }
});

router.get("/segments", async (req: Request, res: Response) => {
  try {
    res.json(await segmentCounts(req.tenantId!));
  } catch (err: any) {
    console.error("[customer-commerce] segments failed:", err?.message);
    res.status(500).json({ error: "segments_failed" });
  }
});

router.get("/by-order", async (req: Request, res: Response) => {
  const n = String(req.query.number ?? "");
  if (!/^#?\d{1,12}$/.test(n.trim())) { res.status(400).json({ error: "invalid_order_number" }); return; }
  try {
    res.json(await contactByOrderNumber(req.tenantId!, n));
  } catch (err: any) {
    console.error("[customer-commerce] by-order failed:", err?.message);
    res.status(500).json({ error: "by_order_failed" });
  }
});

export default router;
