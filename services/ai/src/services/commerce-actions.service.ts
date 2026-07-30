/**
 * Human-agent commerce quick actions (cancel / refund) - spec §5-6.
 *
 * A quick-action button reuses the SAME hardened path AI/HITL actions use:
 *   permission (route) → tenant/customer/order ownership re-validation →
 *   business-policy evaluation → optional HITL → adapter execution (idempotent)
 *   → provider-result validation → post-action verify → audit → verified card.
 *
 * There is NO second frontend-to-Shopify execution path. A button click never
 * mutates order state in the UI; the caller updates only from the verified
 * result returned here. Refunds can never exceed Shopify's refundable maximum
 * (the adapter enforces this; we also gate on it before calling).
 */

import {
  prisma,
  writeAudit,
  actionKindForTool,
  evaluateBusinessPolicy,
  revalidateBeforeExecution,
  createApprovalRequest,
  computeOperationKey,
  isCustomerScopedAction,
  type CommerceActionRequest,
  type CommerceActionResponse,
  type CommerceCustomerActionKind,
  type BusinessActionKind,
} from "@chatcenter/shared";
import { executeAdapterTool } from "./connectors/integration-framework";
import { resolveVerifiedShopifyCustomerId, orderToCard, invalidateCommerceCache } from "./commerce-context.service";

const TOOL_FOR: Record<"cancel" | "refund", string> = {
  cancel: "shopify.cancel_order",
  refund: "shopify.process_refund",
};

/** Build the adapter args from the typed request (server-controlled - the
 * order id is re-validated against the verified customer, never trusted raw). */
function adapterArgs(req: CommerceActionRequest & { orderId: string }): Record<string, unknown> {
  const p = req.params ?? {};
  if (req.action === "cancel") {
    return {
      order_id: req.orderId,
      reason: p.reason ?? "other",
      refund: false, // a cancel here never silently refunds; refund is its own action
      restock: p.restock ?? false,
    };
  }
  // refund
  const args: Record<string, unknown> = { order_id: req.orderId };
  if (typeof p.amount === "number") args.amount = p.amount;
  if (Array.isArray(p.lineItems) && p.lineItems.length) {
    args.line_items = p.lineItems.map((li) => ({ line_item_id: li.lineItemId, quantity: li.quantity }));
  }
  if (typeof p.restock === "boolean") args.restock = p.restock;
  if (typeof p.refundShipping === "boolean") args.refund_shipping = p.refundShipping;
  if (typeof p.notify === "boolean") args.notify = p.notify;
  if (p.reason) (args as any).reason = p.reason;
  return args;
}

async function fetchOrder(tenantId: string, conversationId: string, orderId: string): Promise<any | null> {
  const r = await executeAdapterTool({
    tenantId,
    conversationId,
    toolFunctionName: "shopify.get_order",
    args: { order_id: orderId },
    accessScope: "internal",
  });
  return r.ok ? (r.result as any) : null;
}

export interface CommerceActionPerms {
  canCancel: boolean;
  canRefund: boolean;
  canTag: boolean;
  canNote: boolean;
  canNotify: boolean;
}

const CUSTOMER_TOOL_FOR: Record<CommerceCustomerActionKind, string> = {
  add_tag: "shopify.add_tag",
  remove_tag: "shopify.remove_tag",
  add_note: "shopify.create_note",
};

/**
 * Tag / untag / note the VERIFIED customer.
 *
 * Structurally safer than the order path: the customer id comes from the
 * conversation's verified link, never from the request, so there is no id to
 * forge and no ownership check to get wrong. Everything else is the same
 * chain - permission, policy, optional HITL, adapter, audit.
 */
async function executeCustomerAction(opts: {
  tenantId: string;
  conversationId: string;
  actorUserId: string;
  perms: CommerceActionPerms;
  request: CommerceActionRequest;
  correlationId: string;
}): Promise<CommerceActionResponse> {
  const { tenantId, conversationId, request } = opts;
  const action = request.action as CommerceCustomerActionKind;
  const tool = CUSTOMER_TOOL_FOR[action];

  const isTag = action === "add_tag" || action === "remove_tag";
  if (isTag && !opts.perms.canTag) return { state: "denied", reason: "permission_denied" };
  if (action === "add_note" && !opts.perms.canNote) return { state: "denied", reason: "permission_denied" };

  const tag = typeof request.params?.tag === "string" ? request.params.tag.trim() : "";
  const note = typeof request.params?.note === "string" ? request.params.note.trim() : "";
  if (isTag && !tag) return { state: "denied", reason: "tag_required" };
  if (action === "add_note" && !note) return { state: "denied", reason: "note_required" };

  const customerId = await resolveVerifiedShopifyCustomerId(tenantId, conversationId);
  if (!customerId) return { state: "denied", reason: "customer_not_linked" };

  const args: Record<string, unknown> = { customer_id: customerId };
  if (isTag) args.tag = tag;
  if (action === "add_note") args.note = note;

  // Same replay rule as orders: a prior success for this exact operation is a
  // replay, not a second write.
  const operationKey = computeOperationKey(tool, { ...args, _idem: request.idempotencyKey });
  const priorSuccess = await (prisma as any).auditLog.findFirst({
    where: {
      tenantId,
      action: "commerce.customer_action_executed",
      metadata: { path: ["operationKey"], equals: operationKey },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  }).catch(() => null);
  if (priorSuccess) {
    return { state: "executed_customer", tags: await readCustomerTags(tenantId, conversationId, customerId), noteAdded: action === "add_note" };
  }

  const actionKind = actionKindForTool(tool) as BusinessActionKind;
  const decision = await evaluateBusinessPolicy({
    tenantId,
    actionKind,
    evaluationPoint: "HITL_CREATE",
    correlationId: opts.correlationId,
    facts: { tool, conversationId, tag: tag || undefined } as any,
  });

  if (decision.decision === "DENIED" || decision.decision === "FAIL_CLOSED") {
    await writeAudit({
      tenantId, actorType: "user", actorId: opts.actorUserId, action: "commerce.customer_action_denied",
      targetType: "customer", targetId: customerId,
      metadata: { conversationId, correlationId: opts.correlationId, action, decision: decision.decision, reasonCodes: decision.reasonCodes },
    });
    return { state: "denied", reason: decision.reasonCodes[0] ?? "policy_denied" };
  }

  if (decision.decision === "REQUIRES_HUMAN_APPROVAL") {
    const created = await createApprovalRequest({
      tenantId,
      conversationId,
      tool,
      params: args,
      summary: isTag ? `${action === "add_tag" ? "Add" : "Remove"} tag "${tag}"` : "Add a note to the customer",
      reason: "Human agent requested a customer-record change (policy requires approval)",
      riskLevel: "low",
      riskTags: ["commerce", action, "human_initiated"],
      requestedBy: `agent:${opts.actorUserId}`,
    });
    return { state: "pending_approval", approvalRequestId: created.id };
  }

  const exec = await executeAdapterTool({
    tenantId, conversationId, toolFunctionName: tool, args, accessScope: "internal",
  });
  if (!exec.ok) {
    await writeAudit({
      tenantId, actorType: "user", actorId: opts.actorUserId, action: "commerce.customer_action_failed",
      targetType: "customer", targetId: customerId,
      metadata: { conversationId, correlationId: opts.correlationId, action, reason: exec.reason },
    });
    return { state: "unavailable", reason: exec.reason };
  }

  // Verify from the provider rather than trusting the write, exactly as the
  // order path does. A tag that did not land must not be reported as landed.
  const tags = await readCustomerTags(tenantId, conversationId, customerId);
  if (isTag && tags) {
    const present = tags.some((x) => x.toLowerCase() === tag.toLowerCase());
    const wanted = action === "add_tag";
    if (present !== wanted) {
      await writeAudit({
        tenantId, actorType: "user", actorId: opts.actorUserId, action: "commerce.customer_action_unverified",
        targetType: "customer", targetId: customerId,
        metadata: { conversationId, correlationId: opts.correlationId, action, tag },
      });
      return { state: "unavailable", reason: "action_not_verified" };
    }
  }

  await writeAudit({
    tenantId, actorType: "user", actorId: opts.actorUserId, action: "commerce.customer_action_executed",
    targetType: "customer", targetId: customerId,
    metadata: { conversationId, correlationId: opts.correlationId, action, operationKey, tag: tag || undefined },
  });

  // The customer record changed, so the cached context is stale.
  invalidateCommerceCache({ tenantId, conversationId });
  return { state: "executed_customer", tags, noteAdded: action === "add_note" };
}

/** Current tags straight from the provider. null when they cannot be read. */
async function readCustomerTags(
  tenantId: string,
  conversationId: string,
  customerId: string,
): Promise<string[] | undefined> {
  const r = await executeAdapterTool({
    tenantId,
    conversationId,
    toolFunctionName: "shopify.get_customer_tags",
    args: { customer_id: customerId },
    accessScope: "internal",
  });
  if (!r.ok) return undefined;
  const raw = (r.result as any)?.tags ?? r.result;
  if (Array.isArray(raw)) return raw.map((x: unknown) => String(x).trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map((x) => x.trim()).filter(Boolean);
  return undefined;
}

export async function executeCommerceAction(opts: {
  tenantId: string;
  conversationId: string;
  actorUserId: string;
  perms: CommerceActionPerms;
  request: CommerceActionRequest;
  locale?: string;
  correlationId: string;
}): Promise<CommerceActionResponse> {
  const { tenantId, conversationId, request } = opts;

  // Customer-scoped actions take a different, simpler path: no order, no
  // ownership question, no eligibility. Routing them through the order path
  // would demand an orderId they legitimately do not have.
  if (isCustomerScopedAction(request.action)) {
    return executeCustomerAction({
      tenantId,
      conversationId,
      actorUserId: opts.actorUserId,
      perms: opts.perms,
      request,
      correlationId: opts.correlationId,
    });
  }

  if (!request.orderId) return { state: "denied", reason: "orderId_required" };
  const orderRequest = request as CommerceActionRequest & { orderId: string };
  const tool = TOOL_FOR[request.action as "cancel" | "refund"];
  // The route validates the action, but this is the money path - an action we
  // do not recognise must stop here rather than reach the adapter with an
  // undefined tool name.
  if (!tool) return { state: "denied", reason: "invalid_action" };
  const actionKind = actionKindForTool(tool) as BusinessActionKind;

  // 0. Permission (defence-in-depth; the route already gated).
  if (request.action === "cancel" && !opts.perms.canCancel) return { state: "denied", reason: "permission_denied" };
  if (request.action === "refund" && !opts.perms.canRefund) return { state: "denied", reason: "permission_denied" };

  // 1. Ownership: the order must belong to THIS conversation's verified customer.
  const verifiedCustomerId = await resolveVerifiedShopifyCustomerId(tenantId, conversationId);
  if (!verifiedCustomerId) return { state: "denied", reason: "customer_not_linked" };

  // 2. Reconcile the order live immediately before the sensitive action (spec §9).
  const order = await fetchOrder(tenantId, conversationId, orderRequest.orderId);
  if (!order) return { state: "unavailable", reason: "order_not_found" };
  // Ownership FAILS CLOSED: the orderId is client-supplied, so the order must
  // POSITIVELY match the conversation's verified customer. An order whose owner
  // we cannot confirm (missing customer id, e.g. a guest checkout) is never
  // actionable from this conversation - otherwise an agent could cancel/refund
  // an arbitrary order by id.
  const orderCustomerId = String(order?.customer?.id ?? order?.customer_id ?? "");
  if (!orderCustomerId || orderCustomerId !== verifiedCustomerId) {
    // The order is not (provably) this customer's - never act, never leak.
    await writeAudit({
      tenantId, actorType: "user", actorId: opts.actorUserId,
      action: "security.commerce_action_cross_customer_denied",
      targetType: "order", targetId: orderRequest.orderId,
      metadata: { conversationId, correlationId: opts.correlationId, action: request.action, orderCustomerResolved: !!orderCustomerId },
    });
    return { state: "denied", reason: "order_not_owned" };
  }

  // 3. Eligibility from verified live state.
  const total = Number(order?.total_price) || 0;
  const currency = String(order?.currency || "USD");
  const fulfilled =
    ["fulfilled", "partial"].includes(String(order?.fulfillment_status || "").toLowerCase()) ||
    (Array.isArray(order?.fulfillments) && order.fulfillments.length > 0);
  if (request.action === "cancel" && fulfilled) {
    // Shopify 422s on this with the entire order echoed back, which is not a
    // message anyone can act on. Refuse it here with a reason instead.
    return { state: "unavailable", reason: "already_fulfilled" };
  }
  if (request.action === "cancel" && order?.cancelled_at) {
    return { state: "unavailable", reason: "already_cancelled" };
  }
  if (request.action === "refund") {
    const alreadyRefunded = String(order?.financial_status) === "refunded";
    if (alreadyRefunded) return { state: "unavailable", reason: "already_refunded" };
    // The adapter caps at the true refundable maximum; guard here too so an
    // over-max request is rejected before any money movement.
    if (typeof request.params?.amount === "number" && request.params.amount > total + 0.005) {
      return { state: "denied", reason: "amount_exceeds_refundable_maximum" };
    }
  }

  // 4. Idempotency: a prior SUCCEEDED execution with the same operation is a
  //    replay - return the current verified card, never act twice.
  const args = adapterArgs(orderRequest);
  const operationKey = computeOperationKey(tool, { ...args, _idem: request.idempotencyKey });
  const priorSuccess = await (prisma as any).auditLog.findFirst({
    where: {
      tenantId,
      action: "commerce.order_action_executed",
      metadata: { path: ["operationKey"], equals: operationKey },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  }).catch(() => null);
  if (priorSuccess) {
    const fresh = await fetchOrder(tenantId, conversationId, orderRequest.orderId);
    return { state: "executed", order: await orderToCard(tenantId, fresh ?? order, opts.perms.canCancel || opts.perms.canRefund, opts.locale) };
  }

  // 5. Business policy (HITL_CREATE): DENY → denied; approval required → HITL.
  const facts = {
    tool,
    orderAmount: total,
    currency,
    orderName: String(order?.name ?? ""),
    requestedAmount: typeof request.params?.amount === "number" ? request.params.amount : undefined,
    conversationId,
    reasonCode: request.params?.reason,
  };
  const decision = await evaluateBusinessPolicy({
    tenantId, actionKind, evaluationPoint: "HITL_CREATE", correlationId: opts.correlationId, facts: facts as any,
  });

  if (decision.decision === "DENIED" || decision.decision === "FAIL_CLOSED") {
    await writeAudit({
      tenantId, actorType: "user", actorId: opts.actorUserId, action: "commerce.order_action_denied",
      targetType: "order", targetId: orderRequest.orderId,
      metadata: { conversationId, correlationId: opts.correlationId, action: request.action, decision: decision.decision, reasonCodes: decision.reasonCodes },
    });
    return { state: "denied", reason: decision.reasonCodes[0] ?? "policy_denied" };
  }

  const needsApproval =
    decision.decision === "REQUIRES_HUMAN_APPROVAL" ||
    (decision.decision === "ALLOWED_WITH_LIMIT" &&
      typeof facts.requestedAmount === "number" &&
      decision.maxAmount != null &&
      facts.requestedAmount > decision.maxAmount + 0.005);

  if (needsApproval) {
    const created = await createApprovalRequest({
      tenantId,
      conversationId,
      tool,
      params: args,
      summary: `${request.action === "refund" ? "Refund" : "Cancel"} order ${order?.name ?? orderRequest.orderId}`,
      reason: `Human agent requested ${request.action} (policy requires approval)`,
      riskLevel: "high",
      riskTags: ["commerce", request.action, "human_initiated"],
      requestedBy: `agent:${opts.actorUserId}`,
    });
    await writeAudit({
      tenantId, actorType: "user", actorId: opts.actorUserId, action: "commerce.order_action_hitl_created",
      targetType: "order", targetId: orderRequest.orderId,
      metadata: { conversationId, correlationId: opts.correlationId, action: request.action, approvalRequestId: created.id, deduped: created.deduped ?? false },
    });
    return { state: "pending_approval", approvalRequestId: created.id };
  }

  // 6. PRE_EXECUTION money-safety re-validation, then execute via the adapter.
  const preflight = await revalidateBeforeExecution({
    tenantId, tool, params: args, conversationId, correlationId: opts.correlationId,
  });
  if (!preflight.ok) {
    return { state: "denied", reason: preflight.reason ?? "policy_denied" };
  }

  const exec = await executeAdapterTool({
    tenantId, conversationId, toolFunctionName: tool, args, accessScope: "internal",
  });
  if (!exec.ok) {
    await writeAudit({
      tenantId, actorType: "user", actorId: opts.actorUserId, action: "commerce.order_action_failed",
      targetType: "order", targetId: orderRequest.orderId,
      metadata: { conversationId, correlationId: opts.correlationId, action: request.action, reason: exec.reason },
    });
    return { state: "unavailable", reason: exec.reason };
  }

  // 7. Post-action verify: re-fetch and confirm the intended state actually
  //    landed.
  const verified = await fetchOrder(tenantId, conversationId, orderRequest.orderId);
  const landed =
    request.action === "cancel"
      ? !!verified?.cancelled_at
      : String(verified?.financial_status || "").includes("refunded");
  await writeAudit({
    tenantId, actorType: "user", actorId: opts.actorUserId,
    action: landed ? "commerce.order_action_executed" : "commerce.order_action_unverified",
    targetType: "order", targetId: orderRequest.orderId,
    metadata: {
      conversationId, correlationId: opts.correlationId, action: request.action,
      operationKey, verified: landed, financialStatus: verified?.financial_status ?? null,
      cancelledAt: verified?.cancelled_at ?? null,
    },
  });

  // UI success ONLY after Shopify confirms AND we verify the resulting state
  // (spec §6/§18/§20). If the change didn't land, never report success - the
  // caller shows the real (unchanged) state and the operation can be retried.
  if (!landed) {
    return { state: "unavailable", reason: "action_not_verified" };
  }

  // The order state changed - drop the cached context so the next panel open
  // (and the AI snapshot) reflects the verified new state (spec §9).
  invalidateCommerceCache({ tenantId, conversationId });
  return { state: "executed", order: await orderToCard(tenantId, verified ?? order, opts.perms.canCancel || opts.perms.canRefund, opts.locale) };
}
