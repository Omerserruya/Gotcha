/**
 * A customer's orders with details, for the inbox panel - one card shape for
 * WooCommerce and Shopify.
 *
 * ── Which store ──
 * The business-core `ecommerce` election decides. Without one, the only
 * CONNECTED store is used; with two connected and none chosen the answer is
 * `store_not_chosen` - the same "unmapped is unmapped, never a guess" rule the
 * business core applies everywhere else.
 *
 * ── How the customer is matched, and SAYING SO ──
 * Shopify: delegated to the conversation commerce panel, which resolves the
 *   customer ONLY from the verified linkage. Every card is `matchedBy:"verified"`.
 * WooCommerce: by the billing email or phone on the order, against the
 *   contact's (and its personId siblings') email/phone. That is a match, not a
 *   verification - anyone can type an email at checkout - so each card carries
 *   `matchedBy:"email"|"phone"` and the screen can say which.
 *
 * Woo cards are read-only: the panel's order actions (cancel/refund/return)
 * are implemented for Shopify, so `eligibility` is all false with a reason
 * rather than offering a button nothing would carry out.
 */
import { prisma, getRedis, assertPublicUrl } from "@chatcenter/shared";
import type { OrderCard, OrderDetail, OrderItem, TimelineMilestone, CommerceContextResponse } from "@chatcenter/shared";
import { loadConnection } from "./connectors/integration-framework";
import { getSystemForPart } from "./connectors/part-systems";
import { emailKey, phoneKey } from "./customer-commerce.service";
import {
  buildCommerceContextResponse,
  financialChip,
  fulfillmentChip,
  refundChip,
  cancelledChip,
  money,
  type Locale,
  type CommerceAgentPermissions,
} from "./commerce-context.service";

export type MatchedBy = "verified" | "email" | "phone";
export type CustomerOrderCard = OrderCard & { matchedBy: MatchedBy };

export type CustomerOrdersResponse =
  | { source: "woocommerce"; orders: CustomerOrderCard[] }
  | { source: "shopify"; state: CommerceContextResponse["state"]; orders: CustomerOrderCard[] }
  | { source: null; reason: "no_store_connected" | "store_not_chosen" | "store_unreachable" | "contact_not_found" | "no_identifiers"; orders: [] };

const WOO_CACHE_TTL_SECONDS = 60;
const MAX_ITEMS_SHOWN = 3;

// ── WooCommerce order → OrderCard ───────────────────────────────────────────

/** Woo's single order status, split into the two axes the card shows. */
const WOO_STATUS: Record<string, { financial: string; fulfillment: string; cancelled?: boolean }> = {
  pending: { financial: "pending", fulfillment: "unfulfilled" },
  "on-hold": { financial: "pending", fulfillment: "unfulfilled" },
  processing: { financial: "paid", fulfillment: "in_progress" },
  completed: { financial: "paid", fulfillment: "fulfilled" },
  refunded: { financial: "refunded", fulfillment: "unfulfilled" },
  cancelled: { financial: "voided", fulfillment: "unfulfilled", cancelled: true },
  failed: { financial: "voided", fulfillment: "unfulfilled" },
};

function wooRefunded(o: any): number {
  const refunds: any[] = Array.isArray(o?.refunds) ? o.refunds : [];
  return refunds.reduce((sum, r) => sum + Math.abs(Number(r?.total) || 0), 0);
}

function wooTimeline(o: any, locale: Locale): TimelineMilestone[] {
  const he = locale === "he";
  const iso = (gmt: unknown) => (typeof gmt === "string" && gmt ? `${gmt}Z` : null);
  const placed = iso(o?.date_created_gmt);
  const paid = iso(o?.date_paid_gmt);
  const done = iso(o?.date_completed_gmt);
  // `source` is omitted: the type's two values are "shopify" and "gotcha", and
  // these are the store's own record, not something GOTCHA did.
  return [
    { key: "placed", label: he ? "הוזמן" : "Placed", at: placed, reached: true },
    { key: "paid", label: he ? "שולם" : "Paid", at: paid, reached: !!paid },
    { key: "fulfilled", label: he ? "הושלם" : "Completed", at: done, reached: !!done },
  ];
}

function wooAddress(a: any): string | undefined {
  if (!a) return undefined;
  const line = [a.address_1, a.address_2, a.city, a.postcode, a.country].filter((x) => typeof x === "string" && x.trim()).join(", ");
  return line || undefined;
}

export function mapWooOrderCard(o: any, storeUrl: string, locale: Locale, matchedBy: MatchedBy, imageByProduct: Record<string, string> = {}): CustomerOrderCard {
  const currency = String(o?.currency || "USD");
  const base = WOO_STATUS[String(o?.status || "")] ?? { financial: "pending", fulfillment: "unfulfilled" };
  // Woo has ONE status, so "refunded" hides whether the goods shipped first.
  // A completion date says they did; the chip must not contradict the timeline.
  const status = o?.date_completed_gmt && base.fulfillment === "unfulfilled" && !base.cancelled
    ? { ...base, fulfillment: "fulfilled" }
    : base;
  const total = Number(o?.total) || 0;
  const refunded = wooRefunded(o);
  const lines: any[] = Array.isArray(o?.line_items) ? o.line_items : [];
  const imageOf = (li: any): string | null =>
    (typeof li?.image?.src === "string" && li.image.src) || (li?.product_id != null && imageByProduct[String(li.product_id)]) || null;

  const items: OrderItem[] = lines.slice(0, MAX_ITEMS_SHOWN).map((li) => ({
    title: String(li?.name ?? ""),
    quantity: Number(li?.quantity) || 1,
    imageUrl: imageOf(li),
  }));
  const shownQty = items.reduce((n, i) => n + i.quantity, 0);
  const totalQty = lines.reduce((n, li) => n + (Number(li?.quantity) || 1), 0);

  const subtotal = lines.reduce((n, li) => n + (Number(li?.subtotal) || 0), 0);
  const detail: OrderDetail = {
    lineItems: lines.map((li) => ({
      lineItemId: String(li?.id ?? ""),
      title: String(li?.name ?? ""),
      sku: li?.sku ? String(li.sku) : undefined,
      quantity: Number(li?.quantity) || 1,
      unitPrice: money(li?.price, currency),
      lineTotal: money(li?.total, currency),
      imageUrl: imageOf(li),
    })),
    itemCount: totalQty,
    subtotal: lines.length ? money(subtotal, currency) : undefined,
    discounts: o?.discount_total != null ? money(o.discount_total, currency) : undefined,
    shipping: o?.shipping_total != null ? money(o.shipping_total, currency) : undefined,
    tax: o?.total_tax != null ? money(o.total_tax, currency) : undefined,
    tracking: [],
    shippingAddress: wooAddress(o?.shipping),
    billingAddress: wooAddress(o?.billing),
    tags: [],
    refunds: (Array.isArray(o?.refunds) ? o.refunds : []).map((r: any) => ({
      at: "",
      amount: money(Math.abs(Number(r?.total) || 0), currency),
      reason: r?.reason ? String(r.reason) : undefined,
    })),
    sourceName: o?.created_via ? String(o.created_via) : undefined,
  };

  return {
    orderId: String(o?.id ?? ""),
    orderNumber: `#${o?.number ?? o?.id ?? ""}`,
    adminUrl: `${storeUrl}/wp-admin/post.php?post=${encodeURIComponent(String(o?.id ?? ""))}&action=edit`,
    createdAt: o?.date_created_gmt ? `${o.date_created_gmt}Z` : String(o?.date_created ?? ""),
    total: money(total, currency),
    financial: financialChip(status.financial, locale),
    fulfillment: fulfillmentChip(status.fulfillment, locale),
    cancelled: !!status.cancelled,
    refund: refundChip(refunded, total, locale),
    shipping: null,
    items,
    extraItemCount: Math.max(0, totalQty - shownQty),
    refundedAmount: money(refunded, currency),
    refundableMaximum: money(Math.max(0, total - refunded), currency),
    timeline: wooTimeline(o, locale),
    detail,
    eligibility: {
      cancellable: false,
      refundable: false,
      returnable: false,
      exchangeable: false,
      reasonIfNot: "actions_not_supported_for_store",
    },
    matchedBy,
  };
}

// ── Which store, and who the customer is ───────────────────────────────────

async function chooseStore(tenantId: string): Promise<"woocommerce" | "shopify" | { reason: "no_store_connected" | "store_not_chosen" }> {
  const elected = await getSystemForPart(tenantId, "ecommerce");
  if (elected.slug === "woocommerce" || elected.slug === "shopify") return elected.slug;
  const [woo, shop] = await Promise.all([
    loadConnection({ tenantId, slug: "woocommerce" }).catch(() => null),
    loadConnection({ tenantId, slug: "shopify" }).catch(() => null),
  ]);
  const wooOk = woo?.status === "CONNECTED";
  const shopOk = shop?.status === "CONNECTED";
  if (wooOk && shopOk) return { reason: "store_not_chosen" };
  if (wooOk) return "woocommerce";
  if (shopOk) return "shopify";
  return { reason: "no_store_connected" };
}

interface ContactIds { emails: Set<string>; phones: Set<string>; contact: { id: string; channel: string; externalId: string } }

/** The contact's email/phone keys, across its personId siblings. */
async function contactIdentifiers(tenantId: string, contactId: string): Promise<ContactIds | null> {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId },
    select: { id: true, channel: true, externalId: true, email: true, phone: true, personId: true },
  });
  if (!contact) return null;
  const rows = contact.personId
    ? await prisma.contact.findMany({
        where: { tenantId, personId: contact.personId },
        select: { channel: true, externalId: true, email: true, phone: true },
      })
    : [contact];
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const r of rows) {
    const e = emailKey(r.email);
    if (e) emails.add(e);
    for (const p of [r.phone, String(r.channel) === "WHATSAPP" || String(r.channel) === "SMS" ? r.externalId : null]) {
      const k = phoneKey(p);
      if (k) phones.add(k);
    }
  }
  return { emails, phones, contact: { id: contact.id, channel: String(contact.channel), externalId: contact.externalId } };
}

// ── WooCommerce read ───────────────────────────────────────────────────────

async function wooGet(storeUrl: string, auth: string, path: string): Promise<any[]> {
  const url = `${storeUrl}/wp-json/wc/v3/${path}`;
  await assertPublicUrl(url);
  const res = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
  if (!res.ok) throw new Error(`woocommerce_${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body : [];
}

async function wooOrdersFor(tenantId: string, ids: ContactIds, locale: Locale, limit: number): Promise<CustomerOrdersResponse> {
  const woo = await loadConnection({ tenantId, slug: "woocommerce" }).catch(() => null);
  const storeUrl = String(woo?.config?.storeUrl || "").replace(/\/+$/, "");
  const ck = woo?.credentials.consumerKey || woo?.credentials.consumer_key;
  const cs = woo?.credentials.consumerSecret || woo?.credentials.consumer_secret;
  if (!woo || !storeUrl || !ck || !cs) return { source: null, reason: "store_unreachable", orders: [] };
  const auth = `Basic ${Buffer.from(`${ck}:${cs}`).toString("base64")}`;

  const cacheKey = `customers:orders:${tenantId}:woocommerce:contact:${ids.contact.id}:${locale}:${limit}`;
  try {
    const cached = await getRedis().get(cacheKey);
    if (cached) return JSON.parse(cached) as CustomerOrdersResponse;
  } catch { /* a cold cache is only slower */ }

  try {
    // Woo's `search` is a fuzzy text search, so every hit is re-checked
    // exactly against the billing email/phone below. One search per
    // identifier; the union is de-duplicated by order id.
    const terms = [...ids.emails, ...[...ids.phones]].slice(0, 4);
    const found = new Map<string, any>();
    for (const term of terms) {
      for (const o of await wooGet(storeUrl, auth, `orders?search=${encodeURIComponent(term)}&per_page=${Math.min(limit * 2, 50)}&orderby=date&order=desc`)) {
        found.set(String(o.id), o);
      }
    }
    const matched: Array<{ o: any; by: MatchedBy }> = [];
    for (const o of found.values()) {
      if (ids.emails.has(emailKey(o?.billing?.email) ?? "")) matched.push({ o, by: "email" });
      else if (ids.phones.has(phoneKey(o?.billing?.phone) ?? "")) matched.push({ o, by: "phone" });
    }
    matched.sort((a, b) => String(b.o.date_created_gmt).localeCompare(String(a.o.date_created_gmt)));
    const page = matched.slice(0, limit);

    // Line items carry `image` on current WooCommerce; for any that do not,
    // one batched products read fills the gap.
    const missing = new Set<string>();
    for (const { o } of page) for (const li of o.line_items ?? []) if (!li?.image?.src && li?.product_id) missing.add(String(li.product_id));
    const imageByProduct: Record<string, string> = {};
    if (missing.size) {
      try {
        for (const p of await wooGet(storeUrl, auth, `products?include=${[...missing].slice(0, 100).join(",")}&per_page=100`)) {
          const src = p?.images?.[0]?.src;
          if (src) imageByProduct[String(p.id)] = String(src);
        }
      } catch { /* images are best-effort */ }
    }

    const out: CustomerOrdersResponse = {
      source: "woocommerce",
      orders: page.map(({ o, by }) => mapWooOrderCard(o, storeUrl, locale, by, imageByProduct)),
    };
    await getRedis().set(cacheKey, JSON.stringify(out), "EX", WOO_CACHE_TTL_SECONDS).catch(() => undefined);
    return out;
  } catch (err: any) {
    console.warn(`[customer-orders] woocommerce read failed tenant=${tenantId}: ${err?.message}`);
    return { source: null, reason: "store_unreachable", orders: [] };
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function getCustomerOrders(opts: {
  tenantId: string;
  contactId: string;
  locale?: string;
  limit?: number;
  perms: CommerceAgentPermissions;
}): Promise<CustomerOrdersResponse> {
  const locale: Locale = String(opts.locale || "en").toLowerCase().startsWith("he") ? "he" : "en";
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 10) || 10, 1), 25);

  const ids = await contactIdentifiers(opts.tenantId, opts.contactId);
  if (!ids) return { source: null, reason: "contact_not_found", orders: [] };

  const store = await chooseStore(opts.tenantId);
  if (typeof store !== "string") return { source: null, reason: store.reason, orders: [] };

  if (store === "woocommerce") {
    if (ids.emails.size === 0 && ids.phones.size === 0) return { source: null, reason: "no_identifiers", orders: [] };
    return wooOrdersFor(opts.tenantId, ids, locale, limit);
  }

  // Shopify: the conversation panel's verified path, through this contact's
  // latest conversation (the linkage is per conversation).
  const conv = await prisma.conversation.findFirst({
    where: { tenantId: opts.tenantId, channel: ids.contact.channel as any, customerExternalId: ids.contact.externalId },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true },
  });
  if (!conv) return { source: "shopify", state: "customer_not_linked", orders: [] };
  const r = await buildCommerceContextResponse({
    tenantId: opts.tenantId,
    conversationId: conv.id,
    locale,
    perms: opts.perms,
    recentLimit: limit,
  });
  return {
    source: "shopify",
    state: r.state,
    orders: r.state === "ok" ? r.data.recentOrders.map((c) => ({ ...c, matchedBy: "verified" as const })) : [],
  };
}
