/**
 * Customer commerce facts - deterministic purchase history for the brief.
 *
 * The customer brief answered "who is this person?" purely from CONVERSATION
 * evidence: prior summaries, verbatim messages, sentiment trend, CRM notes.
 * For a merchant running a store that leaves out the half of the answer they
 * care about most - whether this is a first-time shopper or someone who has
 * spent thousands, whether they just bought yesterday or churned six months
 * ago, whether their last order is sitting unfulfilled while they message in.
 *
 * Everything here is COMPUTED, never inferred by a model. An average order
 * value is arithmetic; asking an LLM to produce one invites a confident wrong
 * number in front of an agent who will repeat it to the customer. The LLM
 * receives these facts as given and may only interpret them.
 *
 * Source: the resolved CRM adapter's `getCustomerContext`, which for Shopify
 * maps to `shopify.get_customer` + `shopify.get_customer_orders`. That keeps
 * this on the approved read path - no direct vendor DB access, no second
 * commerce credential, and it works for any vendor whose adapter projects
 * orders onto canonical `deals` (Shopify today, WooCommerce/Wix next).
 */

import { getCrmAdapter } from "./connectors/crm-adapter-resolver";
import type { CrmObjectKind } from "./connectors/crm-adapter.types";

export interface CustomerCommerceFacts {
  vendor: string | null;
  /** Lifetime order count as the STORE reports it, not as we counted it. */
  ordersCount: number | null;
  /** Lifetime spend as the store reports it. */
  totalSpent: number | null;
  currency: string | null;
  /** totalSpent / ordersCount. Null unless both are known and non-zero. */
  averageOrderValue: number | null;
  lastOrderAt: string | null;
  daysSinceLastOrder: number | null;
  firstSeenOrderAt: string | null;
  /** Merchant-managed segmentation already on the customer record. */
  tags: string[];
  /**
   * Orders in the recent window whose financial/fulfilment state is one an
   * agent should know about before speaking (refunded, cancelled, unfulfilled).
   */
  openOrderStates: string[];
  /** How many orders the recent-window read actually returned. */
  recentOrderCount: number;
  /** Recent orders, newest first, for cadence and "what did they buy". */
  recentOrders: Array<{ name: string; amount: number | null; state: string | null; at: string | null }>;
  /**
   * Coarse engagement band derived from the facts above. Deliberately coarse:
   * a band survives being wrong by a few dollars, a percentile does not.
   */
  engagement: "new" | "one_time" | "repeat" | "loyal" | "lapsed" | "unknown";
}

/** States worth surfacing to an agent before they open their mouth. */
const NOTEWORTHY_STATES = new Set([
  "refunded",
  "partially_refunded",
  "voided",
  "cancelled",
  "canceled",
  "pending",
  "unfulfilled",
  "partial",
  "authorized",
]);

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

function daysBetween(fromIso: string, now: Date): number | null {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/**
 * Band a customer by how much and how recently they have bought.
 *
 * `lapsed` deliberately outranks `loyal`/`repeat` in the check order: an
 * agent talking to someone who bought five times and then vanished for a year
 * needs to know about the silence more than about the five orders. Calling
 * that customer "loyal" would be true of their history and wrong about their
 * present.
 */
function bandEngagement(args: {
  ordersCount: number | null;
  daysSinceLastOrder: number | null;
}): CustomerCommerceFacts["engagement"] {
  const { ordersCount, daysSinceLastOrder } = args;
  if (ordersCount == null) return "unknown";
  if (ordersCount === 0) return "new";
  if (daysSinceLastOrder != null && daysSinceLastOrder > 365) return "lapsed";
  if (ordersCount === 1) return "one_time";
  if (ordersCount >= 5) return "loyal";
  return "repeat";
}

/**
 * Load commerce facts for a CRM-linked customer.
 *
 * Best-effort by contract: every failure returns `null` rather than throwing,
 * because the caller is a brief refresh that must still produce a brief when
 * the store is unreachable. A brief with no commerce block is degraded; a
 * conversation that fails to close because Shopify rate-limited us is broken.
 */
export async function loadCustomerCommerceFacts(args: {
  tenantId: string;
  crmContactId: string | null;
  crmObjectKind: CrmObjectKind | null;
  now?: Date;
}): Promise<CustomerCommerceFacts | null> {
  if (!args.crmContactId || !args.crmObjectKind) return null;

  const adapter = await getCrmAdapter(args.tenantId).catch(() => null);
  if (!adapter || adapter.capabilities.is_stub) return null;

  const res = await adapter.getCustomerContext({
    contact_id: args.crmContactId,
    kind: args.crmObjectKind,
  }).catch(() => null);
  if (!res?.ok || !res.context?.contact) return null;

  const now = args.now ?? new Date();
  const contact = res.context.contact;
  const custom = (contact.custom_fields ?? {}) as Record<string, unknown>;

  // Lifetime figures come from the CUSTOMER record, not from summing the
  // orders we fetched: the order read is a recent-window page (10 on Shopify),
  // so summing it would silently understate a customer with a long history.
  const ordersCount = toNumber(custom.orders_count);
  const totalSpent = toNumber(custom.total_spent);
  const currency = typeof custom.currency === "string" ? custom.currency : null;

  const tags = typeof custom.tags === "string"
    ? custom.tags.split(",").map((s) => s.trim()).filter(Boolean)
    : Array.isArray(custom.tags)
      ? (custom.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean)
      : [];

  const deals = Array.isArray(res.context.deals) ? res.context.deals : [];
  const dated = deals
    .map((d) => ({
      name: d.name ?? "",
      amount: toNumber(d.amount),
      state: d.stage ?? null,
      at: d.close_date ?? null,
      ts: d.close_date ? Date.parse(d.close_date) : NaN,
    }))
    .sort((a, b) => (Number.isFinite(b.ts) ? b.ts : 0) - (Number.isFinite(a.ts) ? a.ts : 0));

  const lastOrderAt = dated.find((d) => Number.isFinite(d.ts))?.at ?? null;
  const firstSeenOrderAt = [...dated].reverse().find((d) => Number.isFinite(d.ts))?.at ?? null;
  const daysSinceLastOrder = lastOrderAt ? daysBetween(lastOrderAt, now) : null;

  const averageOrderValue =
    totalSpent != null && ordersCount != null && ordersCount > 0
      ? Math.round((totalSpent / ordersCount) * 100) / 100
      : null;

  const openOrderStates = Array.from(
    new Set(
      dated
        .map((d) => (d.state ?? "").toLowerCase())
        .filter((s) => s && NOTEWORTHY_STATES.has(s)),
    ),
  );

  return {
    vendor: contact.vendor ?? null,
    ordersCount,
    totalSpent,
    currency,
    averageOrderValue,
    lastOrderAt,
    daysSinceLastOrder,
    firstSeenOrderAt,
    tags,
    openOrderStates,
    recentOrderCount: dated.length,
    recentOrders: dated.slice(0, 5).map(({ name, amount, state, at }) => ({ name, amount, state, at })),
    engagement: bandEngagement({ ordersCount, daysSinceLastOrder }),
  };
}

/**
 * Render the facts as prompt lines for the brief.
 *
 * Returns [] when there is nothing worth saying, so the caller can splice it
 * unconditionally. Money is rendered with its currency because "spent 4200"
 * is a different fact in ILS than in USD, and an agent quoting the wrong one
 * to a customer is a real failure.
 */
export function renderCommerceFactsForPrompt(facts: CustomerCommerceFacts | null): string[] {
  if (!facts) return [];
  const money = (n: number | null) =>
    n == null ? null : facts.currency ? `${n} ${facts.currency}` : String(n);

  const lines: string[] = [];
  if (facts.ordersCount != null) lines.push(`- Lifetime orders: ${facts.ordersCount}`);
  const spent = money(facts.totalSpent);
  if (spent) lines.push(`- Lifetime spend: ${spent}`);
  const aov = money(facts.averageOrderValue);
  if (aov) lines.push(`- Average order value: ${aov}`);
  if (facts.lastOrderAt) {
    const ago = facts.daysSinceLastOrder != null ? ` (${facts.daysSinceLastOrder} days ago)` : "";
    lines.push(`- Last order: ${facts.lastOrderAt.slice(0, 10)}${ago}`);
  }
  if (facts.engagement !== "unknown") lines.push(`- Engagement band: ${facts.engagement}`);
  if (facts.tags.length) lines.push(`- Store tags: ${facts.tags.slice(0, 8).join(", ")}`);
  if (facts.openOrderStates.length) {
    lines.push(`- Recent order states needing attention: ${facts.openOrderStates.join(", ")}`);
  }
  if (facts.recentOrders.length) {
    lines.push("- Recent orders (newest first):");
    for (const o of facts.recentOrders) {
      const bits = [o.name || "(unnamed)"];
      const amt = money(o.amount);
      if (amt) bits.push(amt);
      if (o.state) bits.push(o.state);
      if (o.at) bits.push(o.at.slice(0, 10));
      lines.push(`  · ${bits.join(" · ")}`);
    }
  }
  if (lines.length === 0) return [];

  return ["", `## Commerce history (${facts.vendor ?? "store"} - FACTS, already computed, do not recalculate)`, ...lines];
}
