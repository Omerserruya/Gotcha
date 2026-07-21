/**
 * Shopify customer-commerce context endpoints (human agent panel).
 *
 *   GET  /api/commerce-context/:conversationId          → CommerceContextResponse
 *   POST /api/commerce-context/:conversationId/actions  → CommerceActionResponse
 *
 * Tenant is ALWAYS the authenticated JWT tenant (resolveTenant) - never a body
 * field. Visibility + actions are gated by fine-grained `customer:commerce:*`
 * permissions on the ACTIVE membership (never Role==ADMIN). The order data is
 * loaded only for a customer the conversation is securely linked to.
 */

import { Router, type Request, type Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requirePermission,
  hasPermission,
  type PermissionPrincipal,
} from "@chatcenter/shared";
import { buildCommerceContextResponse } from "../services/commerce-context.service";
import { executeCommerceAction } from "../services/commerce-actions.service";

const router = Router();

function principalOf(req: Request & { tenantId?: string }): PermissionPrincipal {
  const u = (req as any).user ?? {};
  return {
    userId: u.userId,
    tenantId: req.tenantId || u.tenantId,
    role: u.role,
    departmentRole: u.departmentRole,
  };
}

async function commercePerms(p: PermissionPrincipal) {
  const [canRead, canOpen, canCancel, canRefund] = await Promise.all([
    hasPermission(p, "customer:commerce:read"),
    hasPermission(p, "customer:commerce:open"),
    hasPermission(p, "customer:commerce:cancel"),
    hasPermission(p, "customer:commerce:refund"),
  ]);
  return { canRead, canOpen, canCancel, canRefund };
}

function localeOf(req: Request): string | undefined {
  const q = typeof req.query.locale === "string" ? req.query.locale : undefined;
  const b = typeof (req.body as any)?.locale === "string" ? (req.body as any).locale : undefined;
  return q || b || (req.headers["accept-language"] as string | undefined);
}

// ── GET commerce context for a conversation ────────────────────────────────
router.get(
  "/:conversationId",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  requirePermission("customer:commerce:read"),
  async (req: Request & { tenantId?: string }, res: Response) => {
    try {
      const tenantId = req.tenantId!;
      const conversationId = String(req.params.conversationId);
      const p = principalOf(req);
      const perms = await commercePerms(p);

      const limitRaw = Number(req.query.limit);
      const result = await buildCommerceContextResponse({
        tenantId,
        conversationId,
        locale: localeOf(req),
        perms,
        recentLimit: Number.isFinite(limitRaw) ? limitRaw : undefined,
        forceRefresh: req.query.refresh === "1" || req.query.refresh === "true",
      });
      res.json(result);
    } catch (err: any) {
      console.error("[commerce-context] GET error:", err?.message);
      res.status(500).json({ error: "internal_error" });
    }
  },
);

// ── POST an order quick action (cancel / refund) ───────────────────────────
router.post(
  "/:conversationId/actions",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  // Needs at least one action permission; the specific action is checked below.
  requirePermission("customer:commerce:cancel", "customer:commerce:refund"),
  async (req: Request & { tenantId?: string }, res: Response) => {
    try {
      const tenantId = req.tenantId!;
      const conversationId = String(req.params.conversationId);
      const body = (req.body ?? {}) as any;
      const action = body.action;
      const orderId = body.orderId;
      const idempotencyKey = body.idempotencyKey;

      if (action !== "cancel" && action !== "refund") {
        res.status(400).json({ error: "invalid_action" });
        return;
      }
      if (!orderId || typeof orderId !== "string") {
        res.status(400).json({ error: "orderId_required" });
        return;
      }
      if (!idempotencyKey || typeof idempotencyKey !== "string") {
        res.status(400).json({ error: "idempotencyKey_required" });
        return;
      }

      const p = principalOf(req);
      const perms = await commercePerms(p);
      // Per-action permission (route only proved the agent has ONE of the two).
      if (action === "cancel" && !perms.canCancel) {
        res.status(403).json({ error: "permission_denied", permission: "customer:commerce:cancel" });
        return;
      }
      if (action === "refund" && !perms.canRefund) {
        res.status(403).json({ error: "permission_denied", permission: "customer:commerce:refund" });
        return;
      }

      const correlationId = `cmc_${tenantId.slice(-6)}_${conversationId.slice(-6)}_${idempotencyKey.slice(0, 12)}`;
      const result = await executeCommerceAction({
        tenantId,
        conversationId,
        actorUserId: p.userId,
        perms: { canCancel: perms.canCancel, canRefund: perms.canRefund },
        request: {
          orderId,
          action,
          idempotencyKey,
          params: body.params ?? {},
        },
        locale: localeOf(req),
        correlationId,
      });

      // Always 200: the discriminated `state` carries the domain outcome
      // (executed / pending_approval / denied / unavailable). Hard auth failures
      // are already handled by requirePermission (403) and validation (400).
      res.json(result);
    } catch (err: any) {
      console.error("[commerce-context] POST action error:", err?.message);
      res.status(500).json({ error: "internal_error" });
    }
  },
);

export default router;
