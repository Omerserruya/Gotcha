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

/**
 * Who the event came from (spec §24).
 *
 * "shopify" is the store's own record. "gotcha" is something this product did
 * or was asked to do. Blending them would let a GOTCHA request read as a
 * Shopify fact, which is precisely the confusion an agent reading a refund
 * history cannot afford.
 */
export type TimelineSource = "shopify" | "gotcha";
export type TimelineActor = "ai" | "agent" | "system";

export interface TimelineMilestone {
  key: string;
  label: string;
  at: string | null; // ISO; null when the milestone is reached but Shopify gave no timestamp
  reached: boolean;
  /** Defaults to "shopify" when absent, which is what every existing event is. */
  source?: TimelineSource;
  actor?: TimelineActor;
  /** True for a failed or rejected step, so the UI can show it as such. */
  failed?: boolean;
}

export interface OrderLineDetail {
  /**
   * The Shopify ORDER line item id.
   *
   * Needed so a return or a partial refund can name WHICH line it acts on.
   * Without it the only expressible action is "all of it", which for a
   * three-item order with one faulty item is the wrong answer.
   */
  lineItemId: string;
  title: string;
  variantTitle?: string;
  sku?: string;
  quantity: number;
  unitPrice: Money;
  lineTotal: Money;
  imageUrl: string | null;
}

export interface OrderTracking {
  number?: string;
  url?: string;
  company?: string;
}

export interface OrderRefundEvent {
  at: string;
  amount: Money;
  reason?: string;
}

/**
 * The expandable detail for a selected order (spec §16).
 *
 * Every money field is optional because Shopify omits them on some orders and
 * a missing subtotal must render as absent, not as 0.00 - the agent is reading
 * this to decide whether to move money.
 */
export interface OrderDetail {
  lineItems: OrderLineDetail[];
  itemCount: number;
  subtotal?: Money;
  discounts?: Money;
  shipping?: Money;
  tax?: Money;
  paid?: Money;
  /** total - paid, when both are known. Never negative. */
  outstanding?: Money;
  tracking: OrderTracking[];
  shippingAddress?: string;
  billingAddress?: string;
  tags: string[];
  cancelReason?: string;
  refunds: OrderRefundEvent[];
  sourceName?: string;
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
  /** Progressive disclosure: the panel shows the card, the drawer shows this. */
  detail?: OrderDetail;
  eligibility: {
    cancellable: boolean;
    refundable: boolean;
    /** A return needs the OPPOSITE precondition to a cancel - goods must have
     *  shipped before anything can come back. */
    returnable: boolean;
    /** An exchange is an order EDIT, so it dies the moment the order ships;
     *  after that the honest route is a return plus a replacement. */
    exchangeable: boolean;
    reasonIfNot?: string;
  };
}

export interface CommerceSummary {
  orderCount: number;
  /**
   * Identity + profile, only where the provider actually returned a value.
   * Every field is optional on purpose: an absent email must render as "not
   * available", never as an empty string that looks like a real answer, and a
   * customer with no spend history must not show a confident 0.
   */
  name?: string;
  email?: string;
  phone?: string;
  currency?: string;
  /** total spend / order count, computed only when both are known. */
  averageOrderValue?: Money;
  customerSince?: string;
  note?: string;
  defaultAddress?: string;
  acceptsMarketing?: boolean;
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
  /** Returns AND exchanges - one grant, see permission-catalog. */
  canReturn: boolean;
  /** Tag and note the CUSTOMER record. Separate from order actions because they
   *  need write_customers rather than write_orders, and a tenant may hold one
   *  scope without the other. */
  canTag: boolean;
  canNote: boolean;
  /** Reserved for customer-visible order emails. No REST endpoint exists to
   *  resend an order confirmation, so nothing consumes this yet. */
  canNotify: boolean;
  grantedScopes: string[];
  /**
   * Whether the grant above was actually read from Shopify.
   *
   * "unknown" means no probe has ever succeeded for this store. It is NOT
   * "the store granted nothing" and must never be treated as permission -
   * the panel shows a reconnect prompt for it.
   */
  scopeVerification: "verified" | "unknown";
  lastCheckedAt: string | null;
  /** Scopes required-but-missing for an otherwise-available action. */
  missingScopes: string[];
}

export interface CommerceContext {
  provider: "shopify";
  customer: {
    verified: true;
    customerId: string;
    /** Provider tags on the customer record. Absent when they could not be
     *  read, which is NOT the same as "this customer has no tags". */
    tags?: string[];
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

/**
 * Order-scoped actions act on ONE order and must prove that order belongs to
 * the conversation's verified customer. Customer-scoped actions act on the
 * verified customer directly and take no order id at all - there is nothing
 * client-supplied to forge.
 */
export type CommerceOrderActionKind = "cancel" | "refund" | "create_return" | "exchange_item";
export type CommerceCustomerActionKind = "add_tag" | "remove_tag" | "add_note";
export type CommerceActionKind = CommerceOrderActionKind | CommerceCustomerActionKind;

export const COMMERCE_ORDER_ACTIONS: CommerceOrderActionKind[] = [
  "cancel",
  "refund",
  // Returns and exchanges are the highest-volume support request a store
  // gets, and they were the largest reason an agent had to leave GOTCHA and
  // finish the job in Shopify admin - losing the conversation context, the
  // audit trail and the customer notification along the way.
  "create_return",
  "exchange_item",
];
export const COMMERCE_CUSTOMER_ACTIONS: CommerceCustomerActionKind[] = ["add_tag", "remove_tag", "add_note"];

export function isCustomerScopedAction(action: string): action is CommerceCustomerActionKind {
  return (COMMERCE_CUSTOMER_ACTIONS as string[]).includes(action);
}

export function isOrderScopedAction(action: string): action is CommerceOrderActionKind {
  return (COMMERCE_ORDER_ACTIONS as string[]).includes(action);
}

export interface CommerceActionRequest {
  /** Required for order-scoped actions; absent for customer-scoped ones. */
  orderId?: string;
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
    // create_return.
    //
    // ORDER line item ids, the same ids the refund path uses and the same ones
    // the order card already shows. Shopify authorises a return against the
    // FULFILLMENT line item, but that mapping is the adapter's job - it reads
    // the returnable fulfillments and resolves them. Asking the panel for a
    // fulfillment id would mean surfacing an id the agent never sees.
    //
    // Omit to return everything returnable on the order.
    returnLineItems?: { lineItemId: string; quantity: number; returnReason?: string }[];
    // exchange_item. The line being replaced, and what replaces it.
    exchangeLineItemId?: string;
    exchangeNewVariantId?: string;
    // customer-scoped
    tag?: string;
    note?: string;
  };
}

export type CommerceActionResponse =
  | { state: "pending_approval"; approvalRequestId: string }
  | { state: "denied"; reason: string }
  | { state: "unavailable"; reason: string }
  | { state: "executed"; order: OrderCard; note?: string }
  /** Customer-scoped result: there is no order card to refresh, so the panel is
   *  told what the customer record now holds rather than being left to guess. */
  | { state: "executed_customer"; tags?: string[]; noteAdded?: boolean };
