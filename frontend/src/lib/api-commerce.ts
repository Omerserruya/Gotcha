/**
 * Shopify commerce-context API helpers - talk to /api/commerce-context on the
 * AI service (services/ai/src/routes/commerce-context.ts), mounted via nginx.
 *
 * Types mirror packages/shared/src/lib/commerce-context.types.ts. The frontend
 * NEVER computes order state - it renders exactly what the verified backend
 * returns and updates only from the verified action result.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export interface Money { amount: string; currency: string }
export type ChipTone = "positive" | "warning" | "neutral" | "danger";
export interface StatusChip { key: string; label: string; tone: ChipTone }
export interface OrderItem { title: string; quantity: number; imageUrl: string | null }
export interface TimelineMilestone { key: string; label: string; at: string | null; reached: boolean }

export interface OrderCard {
  orderId: string;
  orderNumber: string;
  adminUrl: string;
  createdAt: string;
  total: Money;
  financial: StatusChip;
  fulfillment: StatusChip;
  cancelled: boolean;
  refund: StatusChip | null;
  shipping: StatusChip | null;
  items: OrderItem[];
  extraItemCount: number;
  refundedAmount: Money;
  refundableMaximum: Money;
  timeline: TimelineMilestone[];
  eligibility: { cancellable: boolean; refundable: boolean; reasonIfNot?: string };
}

export interface CommerceSummary {
  orderCount: number;
  totalSpentByCurrency: Money[];
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
  missingScopes: string[];
}

export interface CommerceContext {
  provider: "shopify";
  customer: { verified: true; customerId: string };
  summary: CommerceSummary;
  capabilities: CommerceCapabilities;
  recentOrders: OrderCard[];
  fetchedAt: string;
  cacheTtlSeconds: number;
}

export type CommerceContextResponse =
  | { state: "not_connected" }
  | { state: "connection_unhealthy" }
  | { state: "customer_not_linked" }
  | { state: "verification_required" }
  | { state: "missing_scopes"; missing: string[] }
  | { state: "no_orders"; summary: CommerceSummary }
  | { state: "unavailable"; retryable: true }
  | { state: "ok"; data: CommerceContext };

export type CommerceActionResponse =
  | { state: "pending_approval"; approvalRequestId: string }
  | { state: "denied"; reason: string }
  | { state: "unavailable"; reason: string }
  | { state: "executed"; order: OrderCard };

export interface CommerceActionInput {
  orderId: string;
  action: "cancel" | "refund";
  idempotencyKey: string;
  params?: {
    reason?: string;
    restock?: boolean;
    amount?: number;
    lineItems?: { lineItemId: string; quantity: number }[];
    refundShipping?: boolean;
    notify?: boolean;
  };
}

async function authedFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchCommerceContext(
  token: string,
  conversationId: string,
  opts: { refresh?: boolean; locale?: string } = {},
): Promise<CommerceContextResponse> {
  const q = new URLSearchParams();
  if (opts.refresh) q.set("refresh", "1");
  if (opts.locale) q.set("locale", opts.locale);
  const qs = q.toString();
  return authedFetch<CommerceContextResponse>(
    `/api/commerce-context/${encodeURIComponent(conversationId)}${qs ? `?${qs}` : ""}`,
    token,
  );
}

export async function runCommerceAction(
  token: string,
  conversationId: string,
  input: CommerceActionInput,
  locale?: string,
): Promise<CommerceActionResponse> {
  return authedFetch<CommerceActionResponse>(
    `/api/commerce-context/${encodeURIComponent(conversationId)}/actions`,
    token,
    { method: "POST", body: JSON.stringify({ ...input, locale }) },
  );
}

/** Stable idempotency key for a single click of an action on an order. */
export function commerceIdemKey(conversationId: string, orderId: string, action: string): string {
  return `${conversationId}:${orderId}:${action}:${Math.floor(Date.now() / 1000)}`;
}
