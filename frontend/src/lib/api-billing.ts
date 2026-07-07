// Billing API client — subscription, AI-Unit balance/credits, payment methods,
// auto-purchase, invoices. Routed through the gateway to services/billing.
const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

interface FetchOptions extends RequestInit {
  token?: string;
}

async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { token, headers: extraHeaders, ...rest } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((extraHeaders as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { headers, ...rest });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Types ───────────────────────────────────────────────────

export type SubscriptionStatus =
  | "PENDING" | "TRIALING" | "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "CANCELED" | "PAUSED" | "GRANDFATHERED";

export interface Subscription {
  id: string;
  planKey: string;
  planVersion: number;
  status: SubscriptionStatus;
  enforcementEnabled: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface Plan {
  id: string;
  key: string;
  name: string;
  basePrice: string | null;
  currency: string;
  includedAiUnits: number;
  salesOnly: boolean;
}

export interface Balance {
  includedRemaining: number;
  purchasedRemaining: number;
  total: number;
  includedAllowance: number;
  consumedPct: number;
  periodKey: string | null;
}

export interface CreditPackage {
  id: string;
  key: string;
  name: string;
  units: number;
  price: string;
  currency: string;
}

export interface AutoPurchasePolicy {
  enabled: boolean;
  thresholdPct: number;
  packageKey: string | null;
  maxMonthlySpend: string | null;
  currency: string;
  monthSpentAmount: string;
}

export interface PaymentMethod {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

export interface Invoice {
  id: string;
  type: string;
  amount: string;
  currency: string;
  status: string;
  providerInvoiceRef: string | null;
  providerPdfUrl: string | null;
  createdAt: string;
  paidAt: string | null;
}

// ─── Subscription ────────────────────────────────────────────

export const getSubscription = (token: string) =>
  apiFetch<{ subscription: Subscription | null }>("/api/billing/subscription", { token });

export const getPlans = (token: string) =>
  apiFetch<{ plans: Plan[] }>("/api/billing/plans", { token });

export const changePlan = (token: string, planKey: string) =>
  apiFetch<{ ok: boolean; applied: "immediate" | "scheduled" }>("/api/billing/subscription/change-plan", {
    token, method: "POST", body: JSON.stringify({ planKey }),
  });

export const cancelSubscription = (token: string) =>
  apiFetch<{ ok: boolean }>("/api/billing/subscription/cancel", { token, method: "POST", body: "{}" });

export const resumeSubscription = (token: string) =>
  apiFetch<{ ok: boolean }>("/api/billing/subscription/resume", { token, method: "POST", body: "{}" });

export const migratePlan = (token: string, planKey: string) =>
  apiFetch<{ ok: boolean }>("/api/billing/subscription/migrate", {
    token, method: "POST", body: JSON.stringify({ planKey }),
  });

// ─── Credits / AI Units ──────────────────────────────────────

export const getBalance = (token: string) =>
  apiFetch<Balance>("/api/billing/credits/balance", { token });

export const getPackages = (token: string) =>
  apiFetch<{ packages: CreditPackage[] }>("/api/billing/credits/packages", { token });

export const buyCredits = (token: string, packageKey: string) =>
  apiFetch<{ success: boolean; units?: number; failureCode?: string }>("/api/billing/credits/buy", {
    token, method: "POST", body: JSON.stringify({ packageKey }),
  });

export const getAutoPurchase = (token: string) =>
  apiFetch<{ policy: AutoPurchasePolicy | null }>("/api/billing/auto-purchase", { token });

export const setAutoPurchase = (token: string, policy: Partial<AutoPurchasePolicy>) =>
  apiFetch<{ ok: boolean; policy: AutoPurchasePolicy }>("/api/billing/auto-purchase", {
    token, method: "PUT", body: JSON.stringify(policy),
  });

// ─── Payment methods ─────────────────────────────────────────

export const getPaymentMethods = (token: string) =>
  apiFetch<{ paymentMethods: PaymentMethod[] }>("/api/billing/payment-methods", { token });

export const addPaymentMethod = (token: string, pageToken: string) =>
  apiFetch<{ ok: boolean; paymentMethod: PaymentMethod }>("/api/billing/payment-methods", {
    token, method: "POST", body: JSON.stringify({ pageToken }),
  });

export const removePaymentMethod = (token: string, id: string) =>
  apiFetch<{ ok: boolean }>(`/api/billing/payment-methods/${id}`, { token, method: "DELETE" });

// ─── Invoices ────────────────────────────────────────────────

export const getInvoices = (token: string) =>
  apiFetch<{ invoices: Invoice[] }>("/api/billing/invoices", { token });
