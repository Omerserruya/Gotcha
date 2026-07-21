# Shopify Customer-Commerce Context (human panel + AI snapshot)

Status: in progress (feat/customer-intelligence-phase1). Gives a human agent immediate,
*verified* commerce context about the conversation's customer, plus the same verified
snapshot to the AI employee when Shopify is the elected Source of Truth. Wired into the
EXISTING integration / authorization / HITL / business-policy / customer-access / audit
architecture — not a standalone visual widget.

## 1. Trust & visibility (spec §1)
The section renders only when ALL hold, each checked server-side:
- Tenant has a Shopify `TenantIntegration`, status connected/usable.
- The conversation's contact is **securely linked** to a Shopify customer for the SAME tenant.
  Source of truth for the link: `resolveRequesterIdentity(tenantId, conversationId).customerIds`
  (`services/ai/src/services/connectors/customer-access-guard.ts`) — derived from
  `Contact.metadata.crmContactId` + unexpired `CustomerVerification` grants. NEVER from a
  phone/email/order number typed in chat, and never from an AI assertion.
- The human agent holds `customer:commerce:read` (active-membership permission, not Role==ADMIN).
If the linkage is unresolved → `customer_not_linked` / `verification_required`; protected Shopify
data is not loaded.

## 2. Backend read endpoint (spec §2-4, §8-10)
`GET /api/conversations/:conversationId/commerce-context`
Middleware: `authenticate → resolveTenant → requireActiveTenant() → requirePermission("customer:commerce:read")`.
Tenant is ALWAYS the JWT tenant (never body). Discriminated response `state`:
`not_connected | connection_unhealthy | customer_not_linked | verification_required |
missing_scopes | no_orders | unavailable | ok`. Shape = `CommerceContext` (see
`commerce-context.types.ts`). Totals are **grouped by currency** — never summed across
currencies (spec §2). Order status → business-friendly localized labels (spec §3), never raw
enums. Timeline is GOTCHA-rendered from verified Shopify fields only (spec §4).

Projection service: `services/ai/src/services/commerce-context.service.ts`
- Resolves the verified customer id(s), fetches customer+orders via the Shopify adapter
  (`executeAdapterTool`, accessScope internal — the endpoint already enforced permission +
  verified linkage), normalizes to `CommerceContext`.
- Capabilities (`canOpen/canCancel/canRefund`) gate on granted Shopify scopes
  (`read_orders`/`write_orders`) + per-order eligibility + the agent's action permissions.
- adminUrl comes from the adapter/tenant `shopDomain` — never model-reconstructed.

## 3. Quick actions (spec §5-6) — reuse the hardened path, no second Shopify path
`POST /api/conversations/:conversationId/commerce-context/actions`
body `{ orderId, action: "cancel"|"refund", params, idempotencyKey }`.
Pipeline (identical to AI/HITL actions):
1. `requirePermission("customer:commerce:cancel" | "customer:commerce:refund")`.
2. Re-resolve tenant/customer/order ownership server-side (order.customer.id ∈ verified linkage).
3. Reconcile the order from Shopify immediately before the sensitive action (spec §9).
4. `actionKindForTool` + `evaluateBusinessPolicy` (`packages/shared/src/lib/business-policy.ts`):
   DENY → 403; HITL → `createApprovalRequest` (idempotent via `computeOperationKey`) →
   `{state:"pending_approval"}`; ALLOW → continue. No tenant policy → `defaultDecisionWithoutPolicy`
   (secure default: no proactive compensation).
5. `revalidateBeforeExecution` → `executeAdapterTool("shopify.cancel_order"|"shopify.process_refund")`
   with the operationKey as idempotency (duplicate clicks can't double-refund/cancel).
6. Provider-result validation (adapter checks `cancel_not_applied`, refundable maximum, userErrors).
7. Post-action re-fetch + verify order state; audit (`auditLog`, tenant/membership/conversation/
   customer/order/action/correlationId/result); return the VERIFIED new order card.
Frontend updates order state ONLY from this verified result — a click never mutates FE state.
Refund can never exceed Shopify's reported refundable maximum.

## 4. AI commerce snapshot (spec §7)
When Shopify is the elected SoT (`getSourceOfTruth(tenantId).vendor === "shopify"`) AND the
conversation's customer is verified-linked, a typed `AICommerceSnapshot` (verified customer +
recentOrders, STRIPPED of adminUrl/refundableMax/internal LTV labels) is injected through the
customer-brief / prompt context layer — not raw Shopify JSON. Behavior effects (returning-customer
greeting, high-value manager review, faster escalation) are governed by structured tenant policy,
not prompt text alone. The AI must never expose internal segmentation/LTV, invent loyalty, or treat
typed identifiers as verified identity.

## 5. Permissions (spec §5)
New catalog keys (`packages/shared/src/lib/permission-catalog.ts`, `customer` domain, runtime, scoped):
`customer:commerce:read`, `customer:commerce:open`, `customer:commerce:cancel`,
`customer:commerce:refund`. Granted: read/open → agent+; cancel/refund → department_manager + admin/owner
(and always still routed through business policy + HITL). owner=`*`, admin=all-minus-owner-only inherit.

## 6. Freshness & cache (spec §9)
Short tenant+customer-scoped cache with a last-updated indicator + refresh button; auto-refresh after
a successful order action; invalidate on Shopify order webhooks. Sensitive actions always reconcile
live first — stale state is never trusted before cancel/refund.

## 7. Files
- `packages/shared/src/lib/commerce-context.types.ts` — shared typed contract.
- `packages/shared/src/lib/permission-catalog.ts` — new permission keys.
- `services/ai/src/services/commerce-context.service.ts` — projection + normalization + status maps.
- `services/ai/src/services/commerce-actions.service.ts` — quick-action execution pipeline.
- `services/ai/src/routes/commerce-context.ts` — GET + POST endpoints.
- `services/ai/src/services/commerce-ai-snapshot.service.ts` — typed AI snapshot builder.
- `frontend/src/components/conversations/CommerceContextPanel.tsx` — the panel section + order cards + actions.
- `frontend/src/lib/api-commerce.ts` — typed client.
- i18n keys in `frontend/src/i18n/{en,he}.json`.

## 8. Remaining Shopify API limitations (deliverable #11)
- **Product image on order cards**: Shopify REST order line items do NOT carry a
  product image URL. The card shows the product title + a placeholder; a true
  thumbnail would need an extra product/variant image fetch per line item
  (N+1) - deliberately deferred. `OrderItem.imageUrl` is therefore `null` today.
- **Multi-currency total**: the summary uses Shopify's `customer.total_spent`
  shop-currency aggregate (a single provider-supported figure). Per-order cards
  render each order in its own currency. No cross-currency conversion is ever
  performed; a per-presentment-currency breakdown across ALL orders is not shown
  (only the fetched recent orders reveal their own currencies).
- **Scope gating**: `canCancel/canRefund` gate on `config.grantedScopes` when the
  connection persists them. When `grantedScopes` is empty (older connections),
  the capability defaults to permissive and real enforcement falls back to the
  adapter's own scope error, which surfaces as `missing_scopes` at fetch/execute
  time (fails closed on a genuine missing scope).
- **Protected Customer Data (PCD)**: reading a customer's orders requires the
  store's Shopify app to have PCD approval + `read_customers`/`read_orders`. A
  store lacking these returns an adapter error → the panel shows `missing_scopes`
  / `unavailable`, never fabricated data.
- **Webhook invalidation**: the cache-invalidation subscriber is wired to
  `shopify.order.*` events; ingesting those Shopify order webhooks in
  `services/webhook` is a separate task. Until then, invalidation is driven by
  the post-action path + the 60s TTL + the manual refresh button.
- **Order-webhook → conversation mapping**: a `shopify.order.changed` event
  invalidates the whole tenant's cached context (60s TTL, small map) rather than
  a single conversation, since mapping a Shopify order back to a GOTCHA
  conversation isn't 1:1.
- **Idempotency**: duplicate cancel/refund is prevented by (a) the frontend
  disabling the button during a request, (b) a stable `computeOperationKey`
  (canonical order+amount projection) checked against a prior-success audit
  row, and (c) the adapter's own `already_cancelled`/`already_refunded`
  reconcile + refundable-max recompute. The prior-success audit check is not
  atomic, so a sub-second cross-client race on a PARTIAL refund is the one
  residual window; the HITL path (`createApprovalRequest`) dedups atomically by
  operationKey. A dedicated atomic idempotency claim would close the direct-
  execute partial-refund race fully - deferred as low-risk given the mitigations.

## Security review (self-review, 2026-07-21)
Two real defects were found and fixed before sign-off:
1. **Ownership failed open** (`commerce-actions.service.ts`): the client-supplied
   `orderId`'s owner check skipped the deny when an order had no resolvable
   customer id (guest checkout), allowing an agent to act on an arbitrary order.
   Now requires a POSITIVE match to the conversation's verified customer.
2. **Cache not keyed by viewer** (`commerce-context.service.ts`): cached
   capabilities/eligibility (derived from the viewer's permissions) could be
   served to a different-permission viewer. Cache key now includes a permission
   signature. (Actions always re-check server-side, so this was a wrong-UI bug,
   not a privilege escalation.)
