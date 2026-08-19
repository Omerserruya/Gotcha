/**
 * Sysadmin coupon administration. Platform tier only - never tenant ADMIN.
 *
 * A coupon changes what a customer is charged for as long as its window is
 * open, so every route here sits behind ONE commercial platform permission and
 * every mutation writes an audit row. Reads are separated from writes so an
 * operator can be given visibility without the ability to hand out money.
 */
import { Router } from "express";
import {
  authenticate,
  requirePlatformPermission,
  PLATFORM_PERMISSIONS,
  writeAudit,
  prisma,
} from "@chatcenter/shared";
import type { Request, Response } from "express";
import {
  listCoupons,
  createCoupon,
  setCouponActive,
  assignCoupon,
  revokeAssignment,
  assignmentsForTenant,
} from "../services/coupon.service";

const router = Router();

async function audit(req: Request, action: string, targetId: string, metadata: Record<string, unknown>) {
  await writeAudit({
    tenantId: metadata.tenantId ? String(metadata.tenantId) : "platform",
    actorType: "user",
    actorId: (req as any).user?.userId ?? null,
    action,
    targetType: "coupon",
    targetId,
    metadata: { ...metadata, platformPermission: (req as any).platformPermission },
  }).catch((err: any) => console.error("[admin-coupons] audit failed:", err?.message ?? err));
}

/** Map a service-layer refusal to a status + code the UI can explain. */
function refusal(res: Response, err: any) {
  const code = String(err?.message ?? "error");
  const known = new Set([
    "invalid_code",
    "name_required",
    "percent_out_of_range",
    "amount_required",
    "currency_required_for_fixed",
    "invalid_duration",
    "unknown_coupon",
    "coupon_inactive",
    "coupon_exhausted",
    "unknown_tenant",
    "already_assigned",
  ]);
  if (known.has(code)) return res.status(400).json({ error: code });
  console.error("[admin-coupons]", err);
  return res.status(500).json({ error: "coupon_operation_failed" });
}

router.get(
  "/admin/coupons",
  authenticate,
  requirePlatformPermission(PLATFORM_PERMISSIONS.BILLING_READ),
  async (_req: Request, res: Response) => {
    res.json({ coupons: await listCoupons() });
  },
);

router.post(
  "/admin/coupons",
  authenticate,
  requirePlatformPermission(PLATFORM_PERMISSIONS.COUPONS_MANAGE),
  async (req: Request, res: Response) => {
    try {
      const coupon = await createCoupon({ ...req.body, actor: (req as any).user?.userId });
      await audit(req, "coupon.created", coupon.id, {
        code: coupon.code,
        discountType: coupon.discountType,
        percentOff: coupon.percentOff,
        amountOff: coupon.amountOff ? String(coupon.amountOff) : null,
        currency: coupon.currency,
      });
      res.status(201).json({ coupon });
    } catch (err: any) {
      refusal(res, err);
    }
  },
);

router.post(
  "/admin/coupons/:id/active",
  authenticate,
  requirePlatformPermission(PLATFORM_PERMISSIONS.COUPONS_MANAGE),
  async (req: Request, res: Response) => {
    try {
      const active = req.body?.active !== false;
      const coupon = await setCouponActive(String(req.params.id), active);
      await audit(req, active ? "coupon.enabled" : "coupon.disabled", coupon.id, { code: coupon.code });
      res.json({ coupon });
    } catch (err: any) {
      refusal(res, err);
    }
  },
);

/**
 * Every assignment for one organization, live ones flagged.
 *
 * Namespaced under /admin/coupons rather than /admin/tenants: the gateway
 * proxies admin routes by prefix, so a second prefix would need its own
 * location block - and a route the gateway does not know about is a feature
 * that works in development and 404s in production.
 *
 * Read-level permission: seeing that a customer has 20% off is support
 * information; granting it is not.
 */
router.get(
  "/admin/coupons/tenants/:tenantId",
  authenticate,
  requirePlatformPermission(PLATFORM_PERMISSIONS.BILLING_READ),
  async (req: Request, res: Response) => {
    res.json({ assignments: await assignmentsForTenant(String(req.params.tenantId)) });
  },
);

router.post(
  "/admin/coupons/tenants/:tenantId",
  authenticate,
  requirePlatformPermission(PLATFORM_PERMISSIONS.COUPONS_MANAGE),
  async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.params.tenantId);
      const assignment = await assignCoupon({
        tenantId,
        couponId: req.body?.couponId,
        code: req.body?.code,
        startsAt: req.body?.startsAt ? new Date(req.body.startsAt) : undefined,
        // `null` is meaningful here (no end date), so it is only defaulted when
        // the caller omits the key entirely.
        endsAt: req.body?.endsAt === undefined ? undefined : req.body.endsAt ? new Date(req.body.endsAt) : null,
        durationMonths: req.body?.durationMonths ?? null,
        note: req.body?.note ?? null,
        actor: (req as any).user?.userId,
      });
      await audit(req, "coupon.assigned", assignment.id, {
        tenantId,
        code: assignment.coupon.code,
        startsAt: assignment.startsAt,
        endsAt: assignment.endsAt,
      });
      res.status(201).json({ assignment });
    } catch (err: any) {
      refusal(res, err);
    }
  },
);

router.delete(
  "/admin/coupons/assignments/:assignmentId",
  authenticate,
  requirePlatformPermission(PLATFORM_PERMISSIONS.COUPONS_MANAGE),
  async (req: Request, res: Response) => {
    try {
      const assignment = await revokeAssignment(String(req.params.assignmentId), (req as any).user?.userId);
      await audit(req, "coupon.revoked", assignment.id, { tenantId: assignment.tenantId });
      res.json({ assignment });
    } catch (err: any) {
      refusal(res, err);
    }
  },
);

/**
 * Organizations to assign a coupon to, for the sysadmin picker. Name + id
 * only: this is a chooser, not a tenant directory.
 */
router.get(
  "/admin/coupons/assignable-tenants",
  authenticate,
  requirePlatformPermission(PLATFORM_PERMISSIONS.BILLING_READ),
  async (req: Request, res: Response) => {
    const q = String(req.query.q ?? "").trim();
    const tenants = await prisma.tenant.findMany({
      where: q ? { name: { contains: q, mode: "insensitive" } } : undefined,
      select: { id: true, name: true, slug: true },
      orderBy: { name: "asc" },
      take: 50,
    });
    res.json({ tenants });
  },
);

export default router;
