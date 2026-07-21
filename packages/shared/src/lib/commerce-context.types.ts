/**
 * Shopify customer-commerce context - the typed contract shared between the AI
 * service (projection + endpoints) and the frontend panel. This is the canonical
 * shape a human agent sees and the (stripped) shape the AI employee receives.
 *
 * Invariants encoded here (see docs/product/shopify-commerce-context.md):
 *  - Money is a { amount: string; currency } pair. Amounts are NEVER summed
 *    across currencies (spec §2) - totals are grouped by currency.
 *  - Status is a business-friendly LOCALIZED chip, never a raw Shopify enum.
 *  - adminUrl is provider/tenant-derived, never model-reconstructed.
 *  - refundableMaximum is authoritative; a refund can never exceed it.
 */

export interface Money {
  amount: string; // decimal string in `currency` - never a float, never cross-currency summed
  currency: string;
}

export type ChipTone = "positive" | "warning" | "neutral" | "danger";

export interface StatusChip {
  /** Stable machine key (e.g. "paid", "partially_refunded"). */
  key: string;
  /** Localized, business-friendly label. */
  label: string;
  tone: ChipTone;
}

export interface OrderItem {
  title: string;
  quantity: number;
  imageUrl: string | null; // best-effort; Shopify order line items omit product image
}

export interface TimelineMilestone {
  key: string;
  label: string;
  at: string | null; // ISO; null when the milestone is reached but Shopify gave no timestamp
  reached: boolean;
}

export interface OrderCard {
  orderId: string;
  orderNumber: string; // e.g. "#1246"
  adminUrl: string; // provider/tenant-derived exact admin URL
  createdAt: string; // ISO
  total: Money;
  financial: StatusChip;
  fulfillment: StatusChip;
  cancelled: boolean;
  refund: StatusChip | null;
  shipping: StatusChip | null;
  items: OrderItem[];
  extraItemCount: number; // "+N items" beyond the first shown
  refundedAmount: Money;
  refundableMaximum: Money; // authoritative ceiling for a refund
  timeline: TimelineMilestone[];
  eligibility: {
    cancellable: boolean;
    refundable: boolean;
    reasonIfNot?: string;
  };
}

export interface CommerceSummary {
  orderCount: number;
  /** Grouped by currency - NEVER combined across currencies. */
  totalSpentByCurrency: Money[];
  /** Provider shop-currency total when its meaning is unambiguous (Shopify customer.total_spent). */
  shopCurrencyTotal: Money | null;
  lastOrderAt: string | null;
  repeatCustomer: boolean;
  openOrderCount: number;
  refundedOrCancelledCount: number;
}

export interface CommerceCapabilities {
  canOpen: boolean;
  canCancel: boolean;
  canRefund: boolean;
  grantedScopes: string[];
  lastCheckedAt: string | null;
  /** Scopes required-but-missing for an otherwise-available action. */
  missingScopes: string[];
}

export interface CommerceContext {
  provider: "shopify";
  customer: {
    verified: true;
    customerId: string;
  };
  summary: CommerceSummary;
  capabilities: CommerceCapabilities;
  recentOrders: OrderCard[];
  fetchedAt: string;
  cacheTtlSeconds: number;
}

/**
 * Discriminated response for the human panel endpoint. The frontend renders an
 * explicit UI for each state (spec §10) - it never guesses from a bare error.
 */
export type CommerceContextResponse =
  | { state: "not_connected" }
  | { state: "connection_unhealthy" }
  | { state: "customer_not_linked" }
  | { state: "verification_required" }
  | { state: "missing_scopes"; missing: string[] }
  | { state: "no_orders"; summary: CommerceSummary }
  | { state: "unavailable"; retryable: true }
  | { state: "ok"; data: CommerceContext };

// ── AI snapshot (spec §7) — stripped of adminUrl / refundableMax / internal LTV ──

export interface AICommerceOrder {
  orderId: string;
  orderNumber: string;
  createdAt: string;
  total: Money;
  financialStatus: string; // machine key only
  fulfillmentStatus: string;
  cancelled: boolean;
  refundedAmount: Money;
  items: { title: string; quantity: number }[];
}

export interface AICommerceSnapshot {
  provider: "shopify";
  customer: {
    verified: true;
    customerId: string;
    orderCount: number;
    totalSpent: Money | null; // shop-currency aggregate only
    lastOrderAt: string | null;
  };
  recentOrders: AICommerceOrder[];
}

// ── Quick-action request/response (spec §6) ──

export type CommerceActionKind = "cancel" | "refund";

export interface CommerceActionRequest {
  orderId: string;
  action: CommerceActionKind;
  idempotencyKey: string;
  params?: {
    reason?: string;
    restock?: boolean;
    // refund
    amount?: number;
    lineItems?: { lineItemId: string; quantity: number }[];
    refundShipping?: boolean;
    notify?: boolean;
  };
}

export type CommerceActionResponse =
  | { state: "pending_approval"; approvalRequestId: string }
  | { state: "denied"; reason: string }
  | { state: "unavailable"; reason: string }
  | { state: "executed"; order: OrderCard };
