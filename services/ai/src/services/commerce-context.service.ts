/**
 * Shopify customer-commerce context projection (human panel + AI snapshot base).
 *
 * Turns the tenant's Shopify connection + the conversation's VERIFIED linked
 * customer into the canonical `CommerceContext` (docs/product/shopify-commerce-context.md).
 * Every value is grounded in a real Shopify Admin field fetched through the
 * hardened adapter (`executeAdapterTool`, accessScope internal) - nothing is
 * invented, and totals are never summed across currencies.
 *
 * SECURITY: the customer id is resolved ONLY from the trusted linkage
 * (`resolveRequesterIdentity` → Contact.metadata.crmContactId + verified
 * CustomerVerification grants), never from a phone/email/order typed in chat.
 * The caller (route) also enforces the `customer:commerce:read` permission.
 */

import { prisma } from "@chatcenter/shared";
import type {
  CommerceContext,
  CommerceContextResponse,
  CommerceSummary,
  CommerceCapabilities,
  OrderCard,
  StatusChip,
  TimelineMilestone,
  OrderItem,
  Money,
} from "@chatcenter/shared";
import { executeAdapterTool } from "./connectors/integration-framework";
import { loadConnection } from "./connectors/integration-framework";
import { resolveRequesterIdentity } from "./connectors/customer-access-guard";

export const COMMERCE_CACHE_TTL_SECONDS = 60;

// ── Short tenant+conversation-scoped cache (spec §9) ────────────────────────
// Avoids a live Shopify call on every panel re-render / bot turn. Invalidated
// after a successful order action and on Shopify order webhooks. Sensitive
// actions never trust this - they reconcile live first (commerce-actions).
interface CacheEntry { at: number; value: CommerceContextResponse }
const responseCache = new Map<string, CacheEntry>();
const cacheKey = (tenantId: string, conversationId: string, locale: string) =>
  `${tenantId}::${conversationId}::${locale}`;

/** Drop cached commerce context for a tenant (optionally a single conversation). */
export function invalidateCommerceCache(opts: { tenantId: string; conversationId?: string }): number {
  let n = 0;
  for (const k of responseCache.keys()) {
    if (opts.conversationId
      ? k.startsWith(`${opts.tenantId}::${opts.conversationId}::`)
      : k.startsWith(`${opts.tenantId}::`)) {
      responseCache.delete(k);
      n++;
    }
  }
  return n;
}

type Locale = "en" | "he";
const he = (l: Locale) => l === "he";

// ── Localized business-friendly labels (spec §3/§4) ─────────────────────────
// Raw Shopify enums are never surfaced; each maps to a { key, label, tone }.

function financialChip(status: string | null | undefined, locale: Locale): StatusChip {
  const s = String(status || "").toLowerCase();
  const M: Record<string, [string, string, StatusChip["tone"]]> = {
    paid: ["Paid", "שולם", "positive"],
    pending: ["Payment pending", "ממתין לתשלום", "warning"],
    authorized: ["Payment authorized", "תשלום מאושר", "neutral"],
    partially_paid: ["Partially paid", "שולם חלקית", "warning"],
    partially_refunded: ["Partially refunded", "הוחזר חלקית", "warning"],
    refunded: ["Refunded", "הוחזר", "danger"],
    voided: ["Voided", "בוטל תשלום", "danger"],
  };
  const hit = M[s] ?? ["Payment pending", "ממתין לתשלום", "warning"];
  return { key: s || "pending", label: he(locale) ? hit[1] : hit[0], tone: hit[2] };
}

function fulfillmentChip(status: string | null | undefined, locale: Locale): StatusChip {
  const s = String(status || "").toLowerCase();
  const M: Record<string, [string, string, StatusChip["tone"]]> = {
    "": ["Unfulfilled", "טרם נשלח", "neutral"],
    null: ["Unfulfilled", "טרם נשלח", "neutral"],
    unfulfilled: ["Unfulfilled", "טרם נשלח", "neutral"],
    in_progress: ["Processing", "בטיפול", "neutral"],
    partial: ["Partially fulfilled", "נשלח חלקית", "warning"],
    fulfilled: ["Fulfilled", "נשלח", "positive"],
    delivered: ["Delivered", "נמסר", "positive"],
  };
  const key = s || "unfulfilled";
  const hit = M[key] ?? M["unfulfilled"];
  return { key, label: he(locale) ? hit[1] : hit[0], tone: hit[2] };
}

/** Refund chip derived from refunded vs total - never from a raw enum. */
function refundChip(refunded: number, total: number, locale: Locale): StatusChip | null {
  if (!(refunded > 0)) return null;
  if (refunded >= total) {
    return { key: "refunded", label: he(locale) ? "הוחזר" : "Refunded", tone: "danger" };
  }
  return { key: "partially_refunded", label: he(locale) ? "הוחזר חלקית" : "Partially refunded", tone: "warning" };
}

function cancelledChip(locale: Locale): StatusChip {
  return { key: "cancelled", label: he(locale) ? "בוטל" : "Cancelled", tone: "danger" };
}

/** Shipping/tracking chip from fulfillments (best-effort; only when present). */
function shippingChip(order: any, locale: Locale): StatusChip | null {
  const f = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  if (!f.length) return null;
  const anyTracking = f.some((x: any) => x?.tracking_number || (x?.tracking_numbers || []).length);
  const shipmentStatus = f.map((x: any) => x?.shipment_status).find(Boolean);
  if (shipmentStatus === "delivered") {
    return { key: "delivered", label: he(locale) ? "נמסר" : "Delivered", tone: "positive" };
  }
  if (anyTracking) {
    return { key: "shipped", label: he(locale) ? "נשלח למשלוח" : "Shipped", tone: "neutral" };
  }
  return null;
}

// ── Money helpers (never cross-currency) ────────────────────────────────────

function money(amount: unknown, currency: unknown): Money {
  const n = Number(amount);
  return { amount: Number.isFinite(n) ? n.toFixed(2) : "0.00", currency: String(currency || "USD") };
}

/** Sum the refunded amount from a Shopify order's refunds[].transactions[]. */
function refundedAmount(order: any): number {
  let sum = 0;
  for (const rf of order?.refunds || []) {
    for (const tx of rf?.transactions || []) {
      if (tx?.kind === "refund" && (tx?.status === "success" || tx?.status == null)) {
        sum += Number(tx.amount) || 0;
      }
    }
    // Some refunds carry only refund_line_items subtotals with no transaction.
    if (!(rf?.transactions || []).length) {
      for (const li of rf?.refund_line_items || []) sum += Number(li?.subtotal) || 0;
    }
  }
  return sum;
}

// ── Order lifecycle timeline (spec §4) - verified milestones only ───────────

function buildTimeline(order: any, refunded: number, total: number, locale: Locale): TimelineMilestone[] {
  const L = (en: string, hebrew: string) => (he(locale) ? hebrew : en);
  const out: TimelineMilestone[] = [];
  const push = (key: string, en: string, hebrew: string, at: string | null, reached: boolean) =>
    out.push({ key, label: L(en, hebrew), at, reached });

  push("placed", "Order placed", "הזמנה נוצרה", order?.created_at ?? null, true);

  const fin = String(order?.financial_status || "").toLowerCase();
  const paid = ["paid", "partially_refunded", "refunded", "partially_paid"].includes(fin);
  push("payment", "Payment confirmed", "תשלום אושר", order?.processed_at ?? null, paid);

  const ful = String(order?.fulfillment_status || "").toLowerCase();
  const fulfilledAt = (order?.fulfillments || []).map((f: any) => f?.created_at).find(Boolean) ?? null;
  push("fulfilled", "Fulfilled", "נשלח", fulfilledAt, ful === "fulfilled" || ful === "partial");

  const ship = shippingChip(order, locale);
  push("shipped", "Shipped", "נשלח למשלוח", null, !!ship);
  push("delivered", "Delivered", "נמסר", null, ship?.key === "delivered");

  // Terminal branches replace later positive milestones.
  if (order?.cancelled_at) push("cancelled", "Cancelled", "בוטל", order.cancelled_at, true);
  if (refunded > 0 && refunded >= total) push("refunded", "Refunded", "הוחזר", null, true);
  else if (refunded > 0) push("partial_refund", "Partially refunded", "הוחזר חלקית", null, true);

  return out;
}

// ── Order card mapping ──────────────────────────────────────────────────────

const MAX_ITEMS_SHOWN = 1;

function adminUrl(shopDomain: string, orderId: string | number): string {
  const host = String(shopDomain).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}/admin/orders/${orderId}`;
}

function mapOrderCard(order: any, shopDomain: string, canWrite: boolean, locale: Locale): OrderCard {
  const currency = order?.currency ?? order?.presentment_currency ?? "USD";
  const total = Number(order?.total_price) || 0;
  const refunded = refundedAmount(order);
  const cancelled = !!order?.cancelled_at;

  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];
  const items: OrderItem[] = lineItems.slice(0, MAX_ITEMS_SHOWN).map((li: any) => ({
    title: String(li?.title ?? li?.name ?? "Item"),
    quantity: Number(li?.quantity) || 1,
    // Shopify order line items don't carry a product image URL (known limitation).
    imageUrl: null,
  }));
  const extraItemCount = Math.max(0, lineItems.reduce((n: number, li: any) => n + (Number(li?.quantity) || 1), 0) - (items[0]?.quantity ?? 0));

  const refundable = Math.max(0, total - refunded);
  const isFullyRefunded = refunded >= total && total > 0;

  return {
    orderId: String(order?.id),
    orderNumber: String(order?.name ?? `#${order?.order_number ?? order?.id}`),
    adminUrl: adminUrl(shopDomain, order?.id),
    createdAt: order?.created_at ?? new Date(0).toISOString(),
    total: money(total, currency),
    financial: financialChip(order?.financial_status, locale),
    fulfillment: fulfillmentChip(order?.fulfillment_status, locale),
    cancelled,
    refund: refundChip(refunded, total, locale),
    shipping: shippingChip(order, locale),
    items,
    extraItemCount,
    refundedAmount: money(refunded, currency),
    refundableMaximum: money(refundable, currency),
    timeline: buildTimeline(order, refunded, total, locale),
    eligibility: {
      cancellable: canWrite && !cancelled,
      refundable: canWrite && !isFullyRefunded && refundable > 0,
      reasonIfNot: cancelled
        ? "already_cancelled"
        : isFullyRefunded
        ? "already_refunded"
        : !canWrite
        ? "missing_write_scope"
        : undefined,
    },
  };
}

// ── Capabilities from granted scopes + agent permission ─────────────────────

function buildCapabilities(
  config: Record<string, any>,
  agent: { canOpen: boolean; canCancel: boolean; canRefund: boolean },
): CommerceCapabilities {
  const granted: string[] = Array.isArray(config?.grantedScopes) ? config.grantedScopes : [];
  const hasRead = granted.length === 0 || granted.includes("read_orders");
  const hasWrite = granted.length === 0 || granted.includes("write_orders");
  const missing: string[] = [];
  if (!hasWrite && (agent.canCancel || agent.canRefund)) missing.push("write_orders");
  return {
    canOpen: agent.canOpen,
    canCancel: agent.canCancel && hasWrite,
    canRefund: agent.canRefund && hasWrite,
    grantedScopes: granted,
    lastCheckedAt: config?.scopesCheckedAt ?? null,
    missingScopes: missing,
  };
}

// ── Public: build the response for the human panel ──────────────────────────

export interface CommerceAgentPermissions {
  canRead: boolean;
  canOpen: boolean;
  canCancel: boolean;
  canRefund: boolean;
}

/**
 * Resolve the conversation's verified Shopify customer id from the trusted
 * linkage. Returns null when the contact is not securely linked - the caller
 * then renders `customer_not_linked` and loads NO protected data.
 */
export async function resolveVerifiedShopifyCustomerId(
  tenantId: string,
  conversationId: string,
): Promise<string | null> {
  const identity = await resolveRequesterIdentity(tenantId, conversationId);
  if (!identity || identity.customerIds.size === 0) return null;
  // Deterministic pick: the lexicographically-first granted id (stable across calls).
  return [...identity.customerIds].sort()[0];
}

export async function buildCommerceContextResponse(opts: {
  tenantId: string;
  conversationId: string;
  locale?: string;
  perms: CommerceAgentPermissions;
  recentLimit?: number;
  /** Skip the short cache (used before sensitive actions + explicit refresh). */
  forceRefresh?: boolean;
}): Promise<CommerceContextResponse> {
  const localeKey: Locale = String(opts.locale || "en").toLowerCase().startsWith("he") ? "he" : "en";
  const key = cacheKey(opts.tenantId, opts.conversationId, `${localeKey}:${opts.recentLimit ?? 5}`);
  if (!opts.forceRefresh) {
    const hit = responseCache.get(key);
    if (hit && Date.now() - hit.at < COMMERCE_CACHE_TTL_SECONDS * 1000) return hit.value;
  }
  const value = await buildCommerceContextFresh(opts);
  // Cache ONLY the expensive data states. Cheap gate states (not_connected,
  // connection_unhealthy, customer_not_linked, missing_scopes, unavailable) are
  // recomputed each call so a reconnect / re-link / recovery reflects at once.
  if (value.state === "ok" || value.state === "no_orders") {
    responseCache.set(key, { at: Date.now(), value });
  }
  return value;
}

async function buildCommerceContextFresh(opts: {
  tenantId: string;
  conversationId: string;
  locale?: string;
  perms: CommerceAgentPermissions;
  recentLimit?: number;
}): Promise<CommerceContextResponse> {
  const locale: Locale = String(opts.locale || "en").toLowerCase().startsWith("he") ? "he" : "en";
  const recentLimit = Math.min(Math.max(opts.recentLimit ?? 5, 1), 10);

  // 1. Connection state.
  const conn = await loadConnection({ tenantId: opts.tenantId, slug: "shopify" });
  if (!conn) return { state: "not_connected" };
  if (conn.status === "ERROR") return { state: "connection_unhealthy" };

  const shopDomain = String(conn.config?.shopDomain || "").trim();
  if (!shopDomain) return { state: "connection_unhealthy" };

  // 2. Verified linkage (NEVER typed input).
  const customerId = await resolveVerifiedShopifyCustomerId(opts.tenantId, opts.conversationId);
  if (!customerId) return { state: "customer_not_linked" };

  // 3. Capabilities from granted scopes + this agent's permissions.
  const capabilities = buildCapabilities(conn.config || {}, opts.perms);
  const canWrite = capabilities.canCancel || capabilities.canRefund;

  // 4. Customer aggregate (orders_count / total_spent / currency).
  const summ = await executeAdapterTool({
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    toolFunctionName: "shopify.summarize_customer",
    args: { customer_id: customerId },
    accessScope: "internal",
  });
  if (!summ.ok) {
    if (/scope|access_denied/i.test(summ.reason)) return { state: "missing_scopes", missing: ["read_orders"] };
    return { state: "unavailable", retryable: true };
  }
  const customer = (summ.result as any)?.customer ?? {};

  // 5. Full recent orders for the cards.
  const ordersRes = await executeAdapterTool({
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    toolFunctionName: "shopify.get_customer_orders",
    args: { customer_id: customerId, limit: recentLimit },
    accessScope: "internal",
  });
  const rawOrders: any[] = ordersRes.ok && Array.isArray(ordersRes.result) ? (ordersRes.result as any[]) : [];
  // Most-recent first (defensive - do not rely on provider ordering).
  rawOrders.sort((a, b) => new Date(b?.created_at ?? 0).getTime() - new Date(a?.created_at ?? 0).getTime());

  const recentOrders = rawOrders.map((o) => mapOrderCard(o, shopDomain, canWrite, locale));

  // 6. Summary (shop-currency provider aggregate; never cross-currency summed).
  const orderCount = Number(customer?.orders_count ?? rawOrders.length) || 0;
  const shopCurrency = String(customer?.currency || rawOrders[0]?.currency || "USD");
  const totalSpentRaw = customer?.total_spent;
  const shopCurrencyTotal: Money | null =
    totalSpentRaw != null ? money(totalSpentRaw, shopCurrency) : null;
  const openOrderCount = recentOrders.filter(
    (o) => !o.cancelled && o.fulfillment.key !== "fulfilled" && o.financial.key !== "refunded",
  ).length;
  const refundedOrCancelledCount = recentOrders.filter((o) => o.cancelled || o.refund).length;
  const lastOrderAt = rawOrders[0]?.created_at ?? null;

  const summary: CommerceSummary = {
    orderCount,
    totalSpentByCurrency: shopCurrencyTotal ? [shopCurrencyTotal] : [],
    shopCurrencyTotal,
    lastOrderAt,
    repeatCustomer: orderCount >= 2,
    openOrderCount,
    refundedOrCancelledCount,
  };

  if (orderCount === 0 && recentOrders.length === 0) {
    return { state: "no_orders", summary };
  }

  const data: CommerceContext = {
    provider: "shopify",
    customer: { verified: true, customerId },
    summary,
    capabilities,
    recentOrders,
    fetchedAt: new Date().toISOString(),
    cacheTtlSeconds: COMMERCE_CACHE_TTL_SECONDS,
  };
  return { state: "ok", data };
}

/**
 * Map a single verified Shopify order to an OrderCard, loading the tenant's
 * shopDomain for the admin URL. Used by the quick-action response so the UI
 * updates from the SAME canonical projection after an execution.
 */
export async function orderToCard(
  tenantId: string,
  order: any,
  canWrite: boolean,
  locale?: string,
): Promise<OrderCard> {
  const l: Locale = String(locale || "en").toLowerCase().startsWith("he") ? "he" : "en";
  const conn = await loadConnection({ tenantId, slug: "shopify" });
  const shopDomain = String(conn?.config?.shopDomain || "").trim() || "unknown.myshopify.com";
  return mapOrderCard(order, shopDomain, canWrite, l);
}

// Exposed for unit tests (pure mappers).
export const __testables = {
  financialChip,
  fulfillmentChip,
  refundChip,
  cancelledChip,
  shippingChip,
  refundedAmount,
  buildTimeline,
  mapOrderCard,
  buildCapabilities,
  money,
};
