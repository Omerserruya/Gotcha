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
  isCustomerScopedAction,
  isOrderScopedAction,
  visibleConversationFrom,
} from "@chatcenter/shared";
import { buildCommerceContextResponse } from "../services/commerce-context.service";
import { principalOf, commercePerms } from "../services/commerce-perms";
import { executeCommerceAction } from "../services/commerce-actions.service";
import { readerLocale } from "../lib/reader-locale";

const router = Router();

/** Which permission a given action needs. One table, so the route gate and the
 *  service gate cannot disagree about what an action costs. */
const PERMISSION_FOR: Record<string, "canCancel" | "canRefund" | "canReturn" | "canTag" | "canNote" | "canNotify"> = {
  cancel: "canCancel",
  refund: "canRefund",
  create_return: "canReturn",
  exchange_item: "canReturn",
  add_tag: "canTag",
  remove_tag: "canTag",
  add_note: "canNote",
};

// The reader's language: explicit, else the user's / workspace's (lib/reader-locale).
const localeOf = (req: Request) => readerLocale(req);

// ── GET commerce context for a conversation ────────────────────────────────
router.get(
  "/:conversationId",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  // After authenticate: this router authenticates per route, so a router.param
  // hook would run before the user exists. 404 for a conversation this viewer
  // may not see.
  visibleConversationFrom("conversationId"),
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
        locale: await localeOf(req),
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

// ── POST a quick action (order-scoped or customer-scoped) ──────────────────
router.post(
  "/:conversationId/actions",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  // After authenticate: this router authenticates per route, so a router.param
  // hook would run before the user exists. 404 for a conversation this viewer
  // may not see.
  visibleConversationFrom("conversationId"),
  // Needs at least one action permission; the specific action is checked below.
  requirePermission(
    "customer:commerce:cancel",
    "customer:commerce:refund",
    "customer:commerce:return",
    "customer:commerce:tag",
    "customer:commerce:note",
    "customer:commerce:notify",
  ),
  async (req: Request & { tenantId?: string }, res: Response) => {
    try {
      const tenantId = req.tenantId!;
      const conversationId = String(req.params.conversationId);
      const body = (req.body ?? {}) as any;
      const action = String(body.action ?? "");
      const orderId = body.orderId;
      const idempotencyKey = body.idempotencyKey;

      const orderScoped = isOrderScopedAction(action);
      const customerScoped = isCustomerScopedAction(action);
      if (!orderScoped && !customerScoped) {
        res.status(400).json({ error: "invalid_action" });
        return;
      }
      // Only order-scoped actions carry an order. Demanding one for a tag would
      // be wrong; accepting one silently would suggest it is being used.
      if (orderScoped && (!orderId || typeof orderId !== "string")) {
        res.status(400).json({ error: "orderId_required" });
        return;
      }
      if (customerScoped && orderId) {
        res.status(400).json({ error: "orderId_not_applicable" });
        return;
      }
      if (!idempotencyKey || typeof idempotencyKey !== "string") {
        res.status(400).json({ error: "idempotencyKey_required" });
        return;
      }

      const p = principalOf(req);
      const perms = await commercePerms(p);
      // Per-action permission (the route only proved the agent has ONE of them).
      const needed = PERMISSION_FOR[action];
      if (!needed || !perms[needed]) {
        res.status(403).json({ error: "permission_denied", permission: `customer:commerce:${action}` });
        return;
      }

      const correlationId = `cmc_${tenantId.slice(-6)}_${conversationId.slice(-6)}_${idempotencyKey.slice(0, 12)}`;
      const result = await executeCommerceAction({
        tenantId,
        conversationId,
        actorUserId: p.userId,
        perms: {
          canCancel: perms.canCancel,
          canRefund: perms.canRefund,
          canReturn: perms.canReturn,
          canTag: perms.canTag,
          canNote: perms.canNote,
          canNotify: perms.canNotify,
        },
        request: {
          ...(orderScoped ? { orderId } : {}),
          action: action as any,
          idempotencyKey,
          params: body.params ?? {},
        },
        locale: await localeOf(req),
        correlationId,
      });

      // Always 200: the discriminated `state` carries the domain outcome
      // (executed / executed_customer / pending_approval / denied / unavailable).
      // Hard auth failures are already handled by requirePermission (403) and
      // validation (400).
      res.json(result);
    } catch (err: any) {
      console.error("[commerce-context] POST action error:", err?.message);
      res.status(500).json({ error: "internal_error" });
    }
  },
);

export default router;
