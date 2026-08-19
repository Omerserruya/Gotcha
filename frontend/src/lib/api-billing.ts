// Billing API client - subscription, AI-Unit balance/credits, payment methods,
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
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Scheduled (not yet applied) downgrade/cancel, if any. */
  pendingChange?: {
    changeType: "DOWNGRADE" | "CANCEL";
    targetPlanKey: string | null;
    effectiveAt: string;
  } | null;
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

/**
 * Canonical customer-facing credit contract (GET /api/billing/credit-summary).
 * ONE source for every credit number the UI shows. `usage` is plan-CREDIT
 * consumption; `usageCredits` is MONEY spent on auto top-ups - never conflated.
 */
export interface CreditSummary {
  period: { startsAt: string | null; endsAt: string | null; resetsAt: string | null };
  plan: { planId: string | null; name: string | null; includedCredits: number };
  usage: { consumedCredits: number; remainingPlanCredits: number; consumedPct: number };
  purchasedCredits: { balance: number };
  totalAvailableCredits: number;
  /** Where the remaining balance came from. The ledger owns the numbers. */
  creditSources?: { plan: number; purchased: number; promotional: number; trialOrPoc: number };
  /** Capacity the balance still buys, at the PUBLIC commercial ratio. */
  estimatedRemaining?: {
    chats: number;
    calls: number;
    ratios: { chatCreditsPerEstimatedConversation: number; voiceCreditsPerEstimatedCall: number; businessDaysPerMonth: number };
  };
  disclaimer?: { en: string; he: string };
  /** Present only while the workspace is on POC or Trial access. */
  evaluation?: { kind: "POC" | "TRIAL"; expiresAt: string | null; creditCap: number; selfRenew: boolean } | null;
  usageCredits: {
    enabled: boolean;
    spentAmount: string;
    currency: string;
    monthlySpendLimit: string | null;
    thresholdPct: number | null;
    warningThresholdPct?: number | null;
    incrementCredits?: number | null;
    pricePerCredit?: string | null;
    limitBehavior?: "STOP_AI" | "HUMAN_ONLY" | "REQUIRE_APPROVAL" | "PREPAID_ONLY";
    resetsAt: string | null;
  };
}

export interface CreditPackage {
  id: string;
  key: string;
  name: string;
  units: number;
  /** The catalogue figure, before tax. Not what the card is charged. */
  price: string;
  currency: string;
  /** Net, tax and total. `gross` is the amount that will be charged. */
  taxed?: TaxBreakdown;
}

export interface AutoPurchasePolicy {
  enabled: boolean;
  thresholdPct: number;
  packageKey: string | null;
  maxMonthlySpend: string | null;
  currency: string;
  monthSpentAmount: string;
  warningThresholdPct?: number | null;
  incrementCredits?: number | null;
  pricePerCredit?: string | null;
  /**
   * What happens once credits run out and no further top-up is possible.
   *
   * PAYG is the only one that keeps serving: usage past a spent wallet accrues
   * and is billed when the cycle CLOSES, unlike a top-up which charges the card
   * at the moment it happens. Its cap is maxMonthlySpend, the same field, and it
   * is enforced on every accrual rather than at settlement.
   */
  limitBehavior?: "STOP_AI" | "HUMAN_ONLY" | "REQUIRE_APPROVAL" | "PREPAID_ONLY" | "PAYG";
  /** The pay-as-you-go rate. Separate from pricePerCredit, which prices a top-up. */
  paygPricePerCredit?: string | null;
}

// ─── Pricing catalog ─────────────────────────────────────────
// Every price the UI renders comes from the server. The client sends option
// KEYS and never a price, so a tampered payload cannot buy a plan cheaply.

/** A price rendered in both the canonical and the requested display currency. */
export interface DisplayPrice {
  base: { amount: string; currency: string; formatted: string };
  display: { amount: string; currency: string; formatted: string };
  /** True when `display` is a converted estimate, not the charged amount. */
  isEstimatedConversion: boolean;
  chargedCurrency: string;
  fx: { rate: string; source: string; rateDate: string; isFallback: boolean } | null;
}

export interface ChannelEstimate {
  credits: number;
  monthly: number;
  daily: number;
  /**
   * "DECLARED_VOLUME" - the volume this plan sells, shown as-is.
   * "CREDIT_RATIO"    - derived from the credit allowance and the published
   *                     credits-per-conversation assumption.
   */
  basis: "DECLARED_VOLUME" | "CREDIT_RATIO";
  creditsPerUnit: number;
}

export interface QuoteEstimate {
  chat: ChannelEstimate;
  voice: ChannelEstimate;
  totalInteractions: number;
  pricePerChat: string | null;
  pricePerCall: string | null;
  pricePerInteraction: string | null;
  currency: string;
  ratios: {
    chatCreditsPerEstimatedConversation: number;
    voiceCreditsPerEstimatedCall: number;
    businessDaysPerMonth: number;
  };
}

export interface VolumeOption {
  key: string;
  channel: "CHAT" | "VOICE";
  dailyVolume: number;
  monthlyVolume: number;
  additionalCredits: number;
  additionalPrice: DisplayPrice;
  isDefault: boolean;
  totalChannelCredits: number;
}

export interface PlanFeature {
  key: string;
  nameEn: string;
  nameHe: string;
  included: boolean;
  category: string;
}

export interface CatalogPlan {
  key: string;
  version: number;
  name: string;
  nameHe: string | null;
  description: string | null;
  descriptionHe: string | null;
  kind: string;
  recommended: boolean;
  sortOrder: number;
  salesOnly: boolean;
  billingInterval: string;
  basePrice: DisplayPrice | null;
  includedCredits: number;
  creditSplit: { chat: number; voice: number };
  supportLevel: string | null;
  chatVolumeEnabled: boolean;
  voiceVolumeEnabled: boolean;
  autoPurchaseEligible: boolean;
  creditPackagesEligible: boolean;
  features: PlanFeature[];
  limits: Record<string, number>;
  chatOptions: VolumeOption[];
  voiceOptions: VolumeOption[];
  estimate: QuoteEstimate;
}


/**
 * The tax that applies on top of a catalogue price.
 *
 * Catalogue prices are NET, so the price on a card is not the amount that
 * leaves the card. `assumed` is true when nobody has declared a billing
 * country and the default jurisdiction was used - the UI has to say so rather
 * than present it as settled.
 */
export interface TaxSummary {
  percent: number;
  label: string | null;
  countryCode: string;
  exempt: boolean;
  assumed: boolean;
}

export interface TaxBreakdown extends TaxSummary {
  net: string;
  tax: string;
  gross: string;
}

export interface PricingCatalog {
  plans: CatalogPlan[];
  tax: TaxSummary;
  currentPlanKey: string | null;
  currentPlanVersion: number | null;
  currency: {
    base: string;
    display: string;
    available: string[];
    isEstimatedConversion: boolean;
    chargedCurrency: string;
    fx: { rate: string; source: string; rateDate: string; isFallback: boolean } | null;
  };
  disclaimer: { en: string; he: string };
}

export interface Quote {
  planKey: string;
  planVersion: number;
  chatVolumeOptionKey: string | null;
  voiceVolumeOptionKey: string | null;
  monthlyPrice: DisplayPrice;
  includedCredits: number;
  estimate: QuoteEstimate;
  /** Net, tax and total. The gross is what the card is charged. */
  tax: TaxBreakdown;
  disclaimer: { en: string; he: string };
}

/** The current subscription rendered from its stored commercial snapshot. */
export interface CurrentSubscriptionView {
  planKey: string;
  planVersion: number;
  planName: string;
  planNameHe: string | null;
  planKind: string;
  monthlyPrice: DisplayPrice;
  includedCredits: number;
  chatVolumeOptionKey: string | null;
  voiceVolumeOptionKey: string | null;
  chatDailyVolume: number | null;
  voiceDailyVolume: number | null;
  estimate: QuoteEstimate;
  fromSnapshot: boolean;
  /**
   * Null when no coupon applies. When present, `monthlyPrice` above is still
   * the plan's LIST price - the UI shows the saving next to it rather than
   * quietly rendering a smaller number.
   */
  discount: {
    couponCode: string;
    label: string;
    amount: DisplayPrice;
    payableNow: DisplayPrice;
    endsAt: string | null;
  } | null;
}

/** The ask when a POC or trial is ending, or has ended. */
export interface EvaluationPrompt {
  kind: "POC" | "TRIAL";
  planKey: string;
  planName: string;
  endedAt: string | null;
  endingSoon: boolean;
  daysLeft: number | null;
}

export interface PaymentMethod {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

/** One attempt to take the money for an invoice. */
export interface InvoiceCharge {
  id: string;
  status: string;
  /** The agreed price, in the commercial currency. */
  amount: string;
  currency: string;
  /** What the card was actually debited. Null for older rows. */
  chargeAmount: string | null;
  chargeCurrency: string | null;
  exchangeRate: string | null;
  /** What the charge was made of. Null for rows predating the tax breakdown. */
  netAmount: string | null;
  taxPercent: number | null;
  taxAmount: string | null;
  /** The legal document iCount issued. THIS is the receipt. */
  documentRef: string | null;
  documentUrl: string | null;
  attemptNumber: number;
  createdAt: string;
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
  charges?: InvoiceCharge[];
}

/**
 * What the customer was actually charged for an invoice, if we know.
 *
 * Their bank statement shows shekels; the invoice shows dollars. Showing only
 * the second turns "why was I charged 1,821?" into a support conversation.
 */
export function settledCharge(invoice: Invoice): InvoiceCharge | null {
  return invoice.charges?.find((c) => c.status === "SUCCEEDED" && c.chargeAmount) ?? null;
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

/** Canonical credit contract - prefer this over stitching balance+sub+policy. */
export const getCreditSummary = (token: string) =>
  apiFetch<CreditSummary>("/api/billing/credit-summary", { token });

export const getPackages = (token: string) =>
  apiFetch<{ packages: CreditPackage[]; tax: TaxSummary }>("/api/billing/credits/packages", { token });

/**
 * Buy a credit package.
 *
 * `intentKey` identifies ONE purchase the customer decided on. It is generated
 * when the page loads, not when the button is clicked, so a double-click is one
 * charge rather than two. It cannot influence what is bought - price and credit
 * amount are read from the catalog server-side.
 */
export const buyCredits = (token: string, packageKey: string, intentKey: string) =>
  apiFetch<{ success: boolean; units?: number; failureCode?: string; outcomeUnknown?: boolean }>(
    "/api/billing/credits/buy",
    { token, method: "POST", body: JSON.stringify({ packageKey, intentKey }) },
  );

export const getAutoPurchase = (token: string) =>
  // `currency` travels alongside, so the screen states what a ceiling is
  // denominated in even before a policy row exists rather than guessing.
  apiFetch<{ policy: AutoPurchasePolicy | null; currency: string; paygRate: string | null }>(
    "/api/billing/auto-purchase",
    { token },
  );

export const setAutoPurchase = (token: string, policy: Partial<AutoPurchasePolicy>) =>
  apiFetch<{ ok: boolean; policy: AutoPurchasePolicy }>("/api/billing/auto-purchase", {
    token, method: "PUT", body: JSON.stringify(policy),
  });

// ─── Payment methods ─────────────────────────────────────────

export const getPaymentMethods = (token: string) =>
  apiFetch<{ paymentMethods: PaymentMethod[] }>("/api/billing/payment-methods", { token });

/**
 * Start adding a card. Returns where to send the person.
 *
 * There is deliberately no call that posts a card token. The browser used to
 * receive one from the provider and send it here, which is the same mistake as
 * treating a redirect as a receipt: the browser is reporting an outcome it is
 * not in a position to know.
 */
export const startPaymentMethodSession = (token: string) =>
  apiFetch<{ data: { redirectUrl: string; sessionId: string } }>("/api/billing/payment-methods/session", {
    token, method: "POST", body: JSON.stringify({}),
  });

/**
 * Ask the server whether a card was actually stored.
 *
 * Sends only the session id. The answer comes from the provider, compared
 * against the cards that existed before the session started.
 */
export const confirmPaymentMethod = (token: string, sessionId: string) =>
  apiFetch<{ data: { status: "STORED" | "PENDING"; paymentMethod?: PaymentMethod; reason?: string } }>(
    "/api/billing/payment-methods/confirm",
    { token, method: "POST", body: JSON.stringify({ sessionId }) },
  );

export const removePaymentMethod = (token: string, id: string) =>
  apiFetch<{ ok: boolean }>(`/api/billing/payment-methods/${id}`, { token, method: "DELETE" });

// ─── Invoices ────────────────────────────────────────────────

export const getInvoices = (token: string) =>
  apiFetch<{ invoices: Invoice[] }>("/api/billing/invoices", { token });

// ─── Pricing ─────────────────────────────────────────────────

export const getPricingCatalog = (token: string, currency = "USD") =>
  apiFetch<PricingCatalog>(`/api/billing/pricing?currency=${encodeURIComponent(currency)}`, { token });

/**
 * Price a selection server-side. Only KEYS are sent; the server recomputes the
 * price, the credit allocation and the estimate from the catalog.
 */
export const getQuote = (
  token: string,
  input: { planKey: string; chatVolumeOptionKey?: string | null; voiceVolumeOptionKey?: string | null; currency?: string },
) =>
  apiFetch<Quote>("/api/billing/pricing/quote", {
    token,
    method: "POST",
    body: JSON.stringify(input),
  });

export const getCurrentPricing = (token: string, currency = "USD") =>
  apiFetch<{
    subscription: CurrentSubscriptionView | null;
    evaluationPrompt?: EvaluationPrompt | null;
    disclaimer: { en: string; he: string };
  }>(
    `/api/billing/pricing/current?currency=${encodeURIComponent(currency)}`,
    { token },
  );

export interface PricingPackage {
  key: string;
  name: string;
  nameHe: string | null;
  credits: number;
  price: DisplayPrice;
  /** Net, tax and total. `gross` is the amount that will be charged. */
  taxed: TaxBreakdown;
  discountLabel: string | null;
  maxPurchaseQuantity: number | null;
  expiryPolicy: string;
  expiryDays: number | null;
}

export const getPricingPackages = (token: string, currency = "USD") =>
  apiFetch<{ packages: PricingPackage[]; tax: TaxSummary; eligible: boolean }>(
    `/api/billing/pricing/packages?currency=${encodeURIComponent(currency)}`,
    { token },
  );

/** Apply a plan and/or volume change. Priced server-side, provider-confirmed. */
export const applyPlanChange = (
  token: string,
  input: { planKey: string; chatVolumeOptionKey?: string | null; voiceVolumeOptionKey?: string | null },
) =>
  apiFetch<{
    ok: boolean;
    applied: "immediate" | "scheduled";
    effectiveAt?: string | null;
    monthlyPrice: string;
    currency: string;
    includedCredits: number;
  }>("/api/billing/pricing/change", { token, method: "POST", body: JSON.stringify(input) });

// ─── Billing identity ───────────────────────────────────────────
//
// Who the tax document is made out to, and where they are liable. Kept apart
// from the payment method on purpose: the card and the entity being invoiced
// are different facts, and one is not evidence of the other.

export interface BillingIdentity {
  billingName: string | null;
  vatId: string | null;
  billingEmail: string | null;
  /** ISO-3166-1 alpha-2. Selects the tax rate, so it is declared, never guessed. */
  billingCountry: string | null;
  billingAddress: string | null;
}

export const getBillingIdentity = (token: string) =>
  apiFetch<{ data: BillingIdentity }>("/api/billing/profile", { token });

export const saveBillingIdentity = (token: string, identity: Partial<BillingIdentity>) =>
  apiFetch<{ data: BillingIdentity }>("/api/billing/profile", {
    token,
    method: "PUT",
    body: JSON.stringify(identity),
  });

// ─── Coupons (Sysadmin) ─────────────────────────────────────
//
// A coupon is a discount on an existing price. It never changes the plan the
// customer is on, and the same resolver feeds both the charge and the billing
// page - so what an operator sets here is exactly what gets taken.

export interface AdminCoupon {
  id: string;
  code: string;
  nameEn: string;
  nameHe: string | null;
  discountType: "PERCENT" | "FIXED";
  percentOff: number | null;
  amountOff: string | null;
  currency: string | null;
  defaultDurationMonths: number | null;
  active: boolean;
  maxRedemptions: number | null;
  redemptionCount: number;
  assignmentCount: number;
  internalNote: string | null;
  label: string;
  createdAt: string;
}

export interface TenantCouponAssignment {
  id: string;
  code: string;
  nameEn: string;
  nameHe: string | null;
  label: string;
  discountType: "PERCENT" | "FIXED";
  percentOff: number | null;
  amountOff: string | null;
  currency: string | null;
  startsAt: string;
  endsAt: string | null;
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  /** Discounting money right now (window open AND coupon still active). */
  live: boolean;
  note: string | null;
  assignedBy: string | null;
  createdAt: string;
}

export const listCoupons = (token: string) =>
  apiFetch<{ coupons: AdminCoupon[] }>("/api/admin/coupons", { token });

export const createCoupon = (
  token: string,
  input: {
    code: string;
    nameEn: string;
    nameHe?: string | null;
    discountType: "PERCENT" | "FIXED";
    percentOff?: number | null;
    amountOff?: string | null;
    currency?: string | null;
    defaultDurationMonths?: number | null;
    maxRedemptions?: number | null;
    internalNote?: string | null;
  },
) =>
  apiFetch<{ coupon: AdminCoupon }>("/api/admin/coupons", {
    token,
    method: "POST",
    body: JSON.stringify(input),
  });

export const setCouponActive = (token: string, couponId: string, active: boolean) =>
  apiFetch<{ coupon: AdminCoupon }>(`/api/admin/coupons/${couponId}/active`, {
    token,
    method: "POST",
    body: JSON.stringify({ active }),
  });

export const listTenantCoupons = (token: string, tenantId: string) =>
  apiFetch<{ assignments: TenantCouponAssignment[] }>(`/api/admin/tenants/${tenantId}/coupons`, { token });

export const assignCouponToTenant = (
  token: string,
  tenantId: string,
  input: { couponId?: string; code?: string; startsAt?: string; endsAt?: string | null; durationMonths?: number | null; note?: string | null },
) =>
  apiFetch<{ assignment: { id: string } }>(`/api/admin/tenants/${tenantId}/coupons`, {
    token,
    method: "POST",
    body: JSON.stringify(input),
  });

export const revokeTenantCoupon = (token: string, assignmentId: string) =>
  apiFetch<{ assignment: { id: string } }>(`/api/admin/tenant-coupons/${assignmentId}`, {
    token,
    method: "DELETE",
  });

export const listAssignableTenants = (token: string, q = "") =>
  apiFetch<{ tenants: Array<{ id: string; name: string; slug: string }> }>(
    `/api/admin/coupons/assignable-tenants${q ? `?q=${encodeURIComponent(q)}` : ""}`,
    { token },
  );
