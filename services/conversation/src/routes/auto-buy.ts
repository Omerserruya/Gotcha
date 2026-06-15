import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  authenticate,
  resolveTenant,
  requireFeature,
  validate,
  assertTenantId,
  FEATURES,
  isFeatureEnabledForTenant,
} from "@chatcenter/shared";

/**
 * Auto-Buy - stub endpoint demonstrating the two-layer permission gate.
 *
 * The route is open to any authenticated user IF:
 *   1. The tenant has FEATURES.AUTO_BUY enabled (SYSTEM_ADMIN toggle), AND
 *   2. The user has feature access through ADMIN role, a TenantRole grant,
 *      or a UserFeatureGrant override (tenant-admin managed).
 *
 * Real auto-buy business logic is out of scope here - this proves the gate
 * works end-to-end and documents the mounting pattern for new features.
 */

const router = Router();

const placeOrderSchema = z.object({
  productSku: z.string().min(1).max(200),
  quantity: z.number().int().positive().max(1000),
  maxPriceCents: z.number().int().positive().optional(),
});

router.post(
  "/orders",
  authenticate,
  resolveTenant,
  requireFeature(FEATURES.AUTO_BUY),
  validate(placeOrderSchema),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = assertTenantId(req);
    const { productSku, quantity, maxPriceCents } = req.body as z.infer<typeof placeOrderSchema>;

    res.status(202).json({
      data: {
        accepted: true,
        tenantId,
        userId: req.user!.userId,
        productSku,
        quantity,
        maxPriceCents: maxPriceCents ?? null,
        message: "Auto-buy queued (stub implementation).",
      },
    });
  },
);

// Tenant-level status check (no user-level gate - any authenticated user
// can see whether the feature is available to the org, even if they can't
// personally place orders). Useful for the frontend to hide/show UI.
router.get(
  "/status",
  authenticate,
  resolveTenant,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = assertTenantId(req);
    const enabled = await isFeatureEnabledForTenant(tenantId, FEATURES.AUTO_BUY);
    res.json({ data: { tenantEnabled: enabled } });
  },
);

export default router;
