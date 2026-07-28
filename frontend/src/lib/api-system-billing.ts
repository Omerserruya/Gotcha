/**
 * Sysadmin paid-tenant provisioning client.
 *
 * Every commercial figure shown by the UI comes from these calls. The browser
 * computes no totals of its own and submits no price, credit or currency value:
 * the backend recomputes from option keys and rejects any smuggled commercial
 * field outright, so a total invented here would simply be refused.
 */
import { API_URL } from "./api";

async function call<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Preserve the structured code so callers can branch on it rather than
    // parsing prose.
    const err: any = new Error((body as any)?.message || (body as any)?.error || `HTTP ${res.status}`);
    err.code = (body as any)?.error;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

export interface ProvisionableVolumeOption {
  key: string;
  dailyVolume: number;
  additionalCredits: number;
  additionalPrice: string;
}

export interface ProvisionablePlan {
  id: string;
  key: string;
  version: number;
  name: string;
  basePrice: string;
  currency: string;
  includedCredits: number;
  billingInterval: string;
  chatVolumeEnabled: boolean;
  voiceVolumeEnabled: boolean;
  chatOptions: ProvisionableVolumeOption[];
  voiceOptions: ProvisionableVolumeOption[];
}

export interface ProvisioningQuote {
  planName: string;
  basePrice: string;
  totalAmount: string;
  currency: string;
  includedCredits: number;
  estimatedChatsMonthly: number;
  estimatedCallsMonthly: number;
  billingInterval: string;
  /**
   * False when the plan's currency has no verified charge contract. The tenant
   * can still be provisioned - it simply cannot be charged yet - so this drives
   * an honest warning rather than blocking the operator.
   */
  chargeableToday: boolean;
}

/** ACTIVE, PUBLIC plans only. Draft, retired and org-scoped are excluded. */
export async function getProvisionablePlans(token: string): Promise<ProvisionablePlan[]> {
  const r = await call<{ data: ProvisionablePlan[] }>("/api/admin/pricing/provisioning/plans", token);
  return r.data;
}

/** The authoritative summary. The UI renders this and computes nothing itself. */
export async function getProvisioningQuote(
  token: string,
  selection: { planVersionId: string; chatVolumeOptionKey?: string | null; voiceVolumeOptionKey?: string | null },
): Promise<ProvisioningQuote> {
  const r = await call<{ data: ProvisioningQuote }>("/api/admin/pricing/provisioning/quote", token, {
    method: "POST",
    body: JSON.stringify(selection),
  });
  return r.data;
}

/**
 * Give a plan-less organization a paid plan.
 *
 * Refused by the server for a tenant that already holds one: re-pointing a live
 * plan is a plan change, with an existing subscription and money already taken
 * to reckon with, and this route does none of that.
 */
export async function assignPaidPlan(
  token: string,
  tenantId: string,
  selection: { planVersionId: string; chatVolumeOptionKey?: string | null; voiceVolumeOptionKey?: string | null },
) {
  return call<{ data: any }>(`/api/system/tenants/${tenantId}/assign-paid-plan`, token, {
    method: "POST",
    body: JSON.stringify(selection),
  });
}

/** The license domains a POC can be scoped to. Served, never hardcoded. */
export async function getPocFeatureDomains(token: string): Promise<string[]> {
  const r = await call<{ data: string[] }>("/api/system/poc-feature-domains", token);
  return r.data;
}

export interface ProvisioningStatus {
  id: string;
  state: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED_RETRYABLE" | "FAILED_PERMANENT" | "CANCELLED";
  mode?: "PAID_PLAN" | "POC";
  planVersionId: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastFailureCode: string | null;
  lastFailureMessage: string | null;
  canRepair: boolean;
  canResend: boolean;
}

export async function getProvisioningStatus(token: string, tenantId: string): Promise<ProvisioningStatus | null> {
  const r = await call<{ data: ProvisioningStatus | null }>(
    `/api/system/tenants/${tenantId}/billing-provisioning`,
    token,
  );
  return r.data;
}

/**
 * Finish billing setup that never completed.
 *
 * Distinct from resend: this CREATES the records that were never made. It
 * charges nothing, activates nothing and grants no credits.
 */
export async function repairBillingProvisioning(token: string, tenantId: string) {
  return call<{ data: any }>(`/api/system/tenants/${tenantId}/repair-billing-provisioning`, token, {
    method: "POST",
  });
}

/** Issue a replacement link for a checkout that already exists. */
export async function resendPaymentLink(token: string, tenantId: string) {
  return call<{ data: any }>(`/api/system/tenants/${tenantId}/resend-payment-link`, token, {
    method: "POST",
  });
}
