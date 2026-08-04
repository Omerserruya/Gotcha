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
  OrderDetail,
  OrderLineDetail,
  OrderTracking,
  OrderRefundEvent,
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


/**
 * GOTCHA's own action history for one order (spec §24).
 *
 * Read straight from the audit log, which is the record of what this product
 * actually did - so nothing here is fabricated, and an action that was only
 * REQUESTED never appears as one that happened. Marked source "gotcha" so the
 * panel can keep it visually apart from Shopify's own events.
 */
export async function gotchaOrderEvents(
  tenantId: string,
  orderId: string,
  locale: Locale,
): Promise<TimelineMilestone[]> {
  const L = (en: string, hebrew: string) => (he(locale) ? hebrew : en);
  const rows = await (prisma as any).auditLog
    .findMany({
      where: {
        tenantId,
        targetType: "order",
        targetId: String(orderId),
        action: { startsWith: "commerce.order_action_" },
      },
      orderBy: { createdAt: "asc" },
      select: { action: true, createdAt: true, actorType: true, metadata: true },
      take: 50,
    })
    .catch(() => [] as any[]);

  const LABELS: Record<string, { en: string; he: string; failed?: boolean }> = {
    "commerce.order_action_hitl_created": { en: "Approval requested", he: "נשלח לאישור" },
    "commerce.order_action_executed": { en: "Action executed", he: "הפעולה בוצעה" },
    "commerce.order_action_denied": { en: "Action denied by policy", he: "הפעולה נדחתה על ידי המדיניות", failed: true },
    "commerce.order_action_failed": { en: "Action failed", he: "הפעולה נכשלה", failed: true },
    "commerce.order_action_unverified": { en: "Action could not be verified", he: "לא ניתן לאמת את הפעולה", failed: true },
  };

  return (rows as any[])
    .map((r, i) => {
      const spec = LABELS[r.action];
      if (!spec) return null;
      const what = String(r.metadata?.action ?? "");
      const suffix = what ? ` (${what})` : "";
      return {
        key: `gotcha_${i}_${r.action}`,
        label: `${L(spec.en, spec.he)}${suffix}`,
        at: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
        reached: true,
        source: "gotcha" as const,
        actor: (r.actorType === "user" ? "agent" : r.actorType === "ai" ? "ai" : "system") as any,
        ...(spec.failed ? { failed: true } : {}),
      };
    })
    .filter(Boolean) as TimelineMilestone[];
}

// ── Order card mapping ──────────────────────────────────────────────────────

const MAX_ITEMS_SHOWN = 1;

function adminUrl(shopDomain: string, orderId: string | number): string {
  const host = String(shopDomain).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}/admin/orders/${orderId}`;
}

/** Join a Shopify address into one readable line, skipping empty parts. */
function addressLine(a: any): string | undefined {
  if (!a || typeof a !== "object") return undefined;
  const parts = [a.name, a.address1, a.address2, a.city, a.province, a.zip, a.country]
    .map((x: unknown) => (x == null ? "" : String(x).trim()))
    .filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

/**
 * The expandable order detail (spec §16).
 *
 * Only what Shopify actually returned. A missing subtotal stays missing rather
 * than becoming 0.00 - the agent reads these numbers to decide whether to move
 * money, so an invented zero is worse than a blank.
 */
function mapOrderDetail(order: any, currency: string, imageByProduct: Record<string, string>): OrderDetail {
  const num = (v: unknown): number | undefined => {
    if (v === null || v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const m = (v: unknown): Money | undefined => {
    const n = num(v);
    return n === undefined ? undefined : money(n, currency);
  };

  const lines: any[] = Array.isArray(order?.line_items) ? order.line_items : [];
  const lineItems: OrderLineDetail[] = lines.map((li) => {
    const qty = num(li?.quantity) ?? 1;
    const unit = num(li?.price) ?? 0;
    return {
      lineItemId: String(li?.id ?? ""),
      title: String(li?.title ?? li?.name ?? "Item"),
      ...(li?.variant_title ? { variantTitle: String(li.variant_title) } : {}),
      ...(li?.sku ? { sku: String(li.sku) } : {}),
      quantity: qty,
      unitPrice: money(unit, currency),
      lineTotal: money(unit * qty, currency),
      imageUrl: (li?.product_id != null && imageByProduct[String(li.product_id)]) || null,
    };
  });

  const fulfillments: any[] = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  const tracking: OrderTracking[] = [];
  for (const f of fulfillments) {
    const numbers: string[] = Array.isArray(f?.tracking_numbers) ? f.tracking_numbers
      : f?.tracking_number ? [f.tracking_number] : [];
    const urls: string[] = Array.isArray(f?.tracking_urls) ? f.tracking_urls
      : f?.tracking_url ? [f.tracking_url] : [];
    if (!numbers.length && !urls.length && !f?.tracking_company) continue;
    tracking.push({
      ...(numbers[0] ? { number: String(numbers[0]) } : {}),
      ...(urls[0] ? { url: String(urls[0]) } : {}),
      ...(f?.tracking_company ? { company: String(f.tracking_company) } : {}),
    });
  }

  const refunds: OrderRefundEvent[] = (Array.isArray(order?.refunds) ? order.refunds : [])
    .map((r: any) => {
      const amt = (Array.isArray(r?.transactions) ? r.transactions : [])
        .reduce((sum: number, t: any) => sum + (num(t?.amount) ?? 0), 0);
      return {
        at: String(r?.created_at ?? order?.created_at ?? ""),
        amount: money(amt, currency),
        ...(r?.note ? { reason: String(r.note) } : {}),
      };
    })
    .filter((r: OrderRefundEvent) => !!r.at);

  // Outstanding comes from Shopify's own total_outstanding, never derived.
  // Deriving it as total - current_total_price reads a REFUNDED order as one
  // where the customer still owes the full amount, which is the opposite of
  // what happened and exactly the kind of number an agent would act on.
  const paidNum = num(order?.current_total_price) ?? num(order?.total_price);
  const outstanding = num(order?.total_outstanding);

  const shippingLine = Array.isArray(order?.shipping_lines) ? order.shipping_lines[0] : undefined;

  return {
    lineItems,
    itemCount: lines.reduce((n: number, li: any) => n + (num(li?.quantity) ?? 1), 0),
    ...(m(order?.subtotal_price) ? { subtotal: m(order?.subtotal_price)! } : {}),
    ...(m(order?.total_discounts) ? { discounts: m(order?.total_discounts)! } : {}),
    ...(m(shippingLine?.price) ? { shipping: m(shippingLine?.price)! } : {}),
    ...(m(order?.total_tax) ? { tax: m(order?.total_tax)! } : {}),
    ...(paidNum !== undefined ? { paid: money(paidNum, currency) } : {}),
    ...(outstanding !== undefined ? { outstanding: money(outstanding, currency) } : {}),
    tracking,
    ...(addressLine(order?.shipping_address) ? { shippingAddress: addressLine(order?.shipping_address)! } : {}),
    ...(addressLine(order?.billing_address) ? { billingAddress: addressLine(order?.billing_address)! } : {}),
    tags: String(order?.tags ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    ...(order?.cancel_reason ? { cancelReason: String(order.cancel_reason) } : {}),
    refunds,
    ...(order?.source_name ? { sourceName: String(order.source_name) } : {}),
  };
}

function mapOrderCard(order: any, shopDomain: string, canWrite: boolean, locale: Locale, imageByProduct: Record<string, string> = {}): OrderCard {
  const currency = order?.currency ?? order?.presentment_currency ?? "USD";
  const total = Number(order?.total_price) || 0;
  const refunded = refundedAmount(order);
  const cancelled = !!order?.cancelled_at;

  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];
  const items: OrderItem[] = lineItems.slice(0, MAX_ITEMS_SHOWN).map((li: any) => ({
    title: String(li?.title ?? li?.name ?? "Item"),
    quantity: Number(li?.quantity) || 1,
    // Shopify order line items don't carry an image URL - enriched from the
    // product's featured image (batched get_product_images), null if unknown.
    imageUrl: (li?.product_id != null && imageByProduct[String(li.product_id)]) || null,
  }));
  const extraItemCount = Math.max(0, lineItems.reduce((n: number, li: any) => n + (Number(li?.quantity) || 1), 0) - (items[0]?.quantity ?? 0));

  const refundable = Math.max(0, total - refunded);
  const isFullyRefunded = refunded >= total && total > 0;
  // Any fulfillment at all blocks cancellation, including a partial one.
  const ful = String(order?.fulfillment_status || "").toLowerCase();
  const hasFulfillment =
    ful === "fulfilled" || ful === "partial" ||
    (Array.isArray(order?.fulfillments) && order.fulfillments.length > 0);

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
    detail: mapOrderDetail(order, currency, imageByProduct),
    eligibility: {
      // Shopify REFUSES to cancel an order that has been fulfilled - it 422s
      // with the whole order echoed back. Offering the button anyway sent the
      // agent to a dead end and surfaced a raw provider error, which is the
      // exact thing order-state rules exist to prevent.
      cancellable: canWrite && !cancelled && !hasFulfillment,
      refundable: canWrite && !isFullyRefunded && refundable > 0,
      // A return is the MIRROR of a cancel: nothing can come back that never
      // shipped, so this is gated on fulfilment being present, not absent.
      // Whether any individual line is still returnable is Shopify's call -
      // the adapter reads the returnable fulfillments and refuses the rest.
      returnable: canWrite && !cancelled && hasFulfillment,
      // An exchange is an order EDIT, so it shares the cancel window: once the
      // goods have shipped the honest route is a return plus a replacement.
      exchangeable: canWrite && !cancelled && !hasFulfillment,
      reasonIfNot: cancelled
        ? "already_cancelled"
        : hasFulfillment
        ? "already_fulfilled"
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
  agent: { canOpen: boolean; canCancel: boolean; canRefund: boolean; canReturn: boolean; canTag: boolean; canNote: boolean; canNotify: boolean },
): CommerceCapabilities {
  const granted: string[] = Array.isArray(config?.grantedScopes) ? config.grantedScopes : [];
  const hasRead = granted.length === 0 || granted.includes("read_orders");
  const hasWrite = granted.length === 0 || granted.includes("write_orders");
  // Tagging and noting write the CUSTOMER record, which is a different scope.
  // Conflating the two would offer a tag button that always fails on a store
  // that granted write_orders but not write_customers.
  const hasCustomerWrite = granted.length === 0 || granted.includes("write_customers");
  // Returns are their own Shopify scope. A store can grant write_orders and
  // still refuse the returns API - the adapter surfaces exactly that as
  // "Access denied ... Required access: read_returns" - so offering a Return
  // button on write_orders alone sends the agent to a guaranteed failure.
  const hasReturnWrite = granted.length === 0 || granted.includes("write_returns");
  const missing: string[] = [];
  if (!hasWrite && (agent.canCancel || agent.canRefund)) missing.push("write_orders");
  if (!hasCustomerWrite && (agent.canTag || agent.canNote)) missing.push("write_customers");
  if (!hasReturnWrite && agent.canReturn) missing.push("write_returns");
  return {
    canOpen: agent.canOpen,
    canCancel: agent.canCancel && hasWrite,
    canRefund: agent.canRefund && hasWrite,
    // An exchange is an order edit and a return is a returns-API write, but
    // they share one grant, so this needs BOTH scopes to be honest about it.
    canReturn: agent.canReturn && hasWrite && hasReturnWrite,
    canTag: agent.canTag && hasCustomerWrite,
    canNote: agent.canNote && hasCustomerWrite,
    // Resending a confirmation is an order-side action, so it rides on the
    // order write scope rather than the customer one.
    canNotify: agent.canNotify && hasWrite,
    grantedScopes: granted,
    lastCheckedAt: config?.scopesCheckedAt ?? null,
    missingScopes: missing,
  };
}

// ── Public: build the response for the human panel ──────────────────────────

/** Batch-fetch the featured image for each order's first product (one call). */
async function fetchProductImages(
  tenantId: string,
  conversationId: string | undefined,
  orders: any[],
): Promise<Record<string, string>> {
  try {
    const ids = Array.from(
      new Set(
        orders
          .map((o) => (Array.isArray(o?.line_items) ? o.line_items[0]?.product_id : null))
          .filter((x) => x != null)
          .map(String),
      ),
    );
    if (!ids.length) return {};
    const res = await executeAdapterTool({
      tenantId,
      conversationId,
      toolFunctionName: "shopify.get_product_images",
      args: { product_ids: ids },
      accessScope: "internal",
    });
    return res.ok && res.result && typeof res.result === "object" ? (res.result as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export interface CommerceAgentPermissions {
  canRead: boolean;
  canOpen: boolean;
  canCancel: boolean;
  canRefund: boolean;
  /** Returns AND exchanges - one grant, see permission-catalog. */
  canReturn: boolean;
  canTag: boolean;
  canNote: boolean;
  canNotify: boolean;
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
  // The cached CommerceContext bakes in capabilities + per-order eligibility,
  // both derived from the VIEWER's permissions - so the key must include a
  // permission signature. Otherwise two agents with different commerce grants
  // (or the AI snapshot, which passes all-false perms) viewing the same
  // conversation would share one entry and see the wrong capabilities.
  const p = opts.perms;
  const permSig = `${p.canRead ? 1 : 0}${p.canOpen ? 1 : 0}${p.canCancel ? 1 : 0}${p.canRefund ? 1 : 0}`;
  const key = cacheKey(opts.tenantId, opts.conversationId, `${localeKey}:${opts.recentLimit ?? 5}:${permSig}`);
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
  const recentLimit = Math.min(Math.max(opts.recentLimit ?? 5, 1), 25);

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

  // Enrich the first product image per order (order line items lack images).
  const imageByProduct = await fetchProductImages(opts.tenantId, opts.conversationId, rawOrders);
  const recentOrders = rawOrders.map((o) => mapOrderCard(o, shopDomain, canWrite, locale, imageByProduct));

  // Merge in what GOTCHA itself did to these orders (spec §24). One batched
  // read for the whole page, and only for orders that actually have events -
  // the timeline stays Shopify-only when this product has never touched them.
  const gotchaEvents = await Promise.all(
    recentOrders.map((o) => gotchaOrderEvents(opts.tenantId, o.orderId, locale).catch(() => [])),
  );
  recentOrders.forEach((o, i) => {
    const evts = gotchaEvents[i];
    if (evts.length) o.timeline = [...o.timeline, ...evts];
  });

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

  // Average order value, only when BOTH inputs are real. Dividing by a zero
  // order count, or by a total the provider did not give us, would produce a
  // confident number with nothing behind it.
  const totalSpentNum = totalSpentRaw != null ? Number(totalSpentRaw) : NaN;
  const averageOrderValue: Money | undefined =
    Number.isFinite(totalSpentNum) && orderCount > 0
      ? money((totalSpentNum / orderCount).toFixed(2), shopCurrency)
      : undefined;

  // Present-only spread. An absent field must stay absent so the panel can say
  // "not available" rather than render an empty string as if it were the answer.
  const present = <T,>(v: T | null | undefined): v is T =>
    v !== null && v !== undefined && String(v).trim() !== "";

  const addr = customer?.default_address;
  const defaultAddress = addr
    ? [addr.address1, addr.address2, addr.city, addr.province, addr.zip, addr.country]
        .filter((x: unknown) => present(x))
        .join(", ")
    : undefined;

  const summary: CommerceSummary = {
    orderCount,
    totalSpentByCurrency: shopCurrencyTotal ? [shopCurrencyTotal] : [],
    shopCurrencyTotal,
    lastOrderAt,
    repeatCustomer: orderCount >= 2,
    openOrderCount,
    refundedOrCancelledCount,
    ...(present(customer?.name) ? { name: String(customer.name) } : {}),
    ...(present(customer?.email) ? { email: String(customer.email) } : {}),
    ...(present(customer?.phone) ? { phone: String(customer.phone) } : {}),
    ...(present(shopCurrency) ? { currency: shopCurrency } : {}),
    ...(averageOrderValue ? { averageOrderValue } : {}),
    ...(present(customer?.created_at) ? { customerSince: String(customer.created_at) } : {}),
    ...(present(customer?.note) ? { note: String(customer.note) } : {}),
    ...(present(defaultAddress) ? { defaultAddress } : {}),
    ...(typeof customer?.accepts_marketing === "boolean" ? { acceptsMarketing: customer.accepts_marketing } : {}),
  };

  if (orderCount === 0 && recentOrders.length === 0) {
    return { state: "no_orders", summary };
  }

  const data: CommerceContext = {
    provider: "shopify",
    customer: {
      verified: true,
      customerId,
      // Only when the provider actually gave us an array. Defaulting to [] here
      // would render as "no tags" for a customer whose tags we failed to read.
      ...(Array.isArray(customer?.tags) ? { tags: customer.tags.map((x: unknown) => String(x)) } : {}),
    },
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
  const imageByProduct = await fetchProductImages(tenantId, undefined, [order]);
  const card = mapOrderCard(order, shopDomain, canWrite, l, imageByProduct);
  // Same merge on the post-action refresh path: an executed action must not
  // disappear from the timeline the instant the card is re-read.
  const evts = await gotchaOrderEvents(tenantId, card.orderId, l).catch(() => []);
  if (evts.length) card.timeline = [...card.timeline, ...evts];
  return card;
}

// Exposed for unit tests (pure mappers).
export const __testables = {
  mapOrderDetail,
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
