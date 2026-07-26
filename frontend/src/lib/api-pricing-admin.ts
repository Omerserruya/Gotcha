// Sysadmin pricing administration + actual-cost analytics client.
//
// Every endpoint here is platform-tier. A tenant ADMIN cannot reach any of them,
// which is the point: pricing configuration and cross-organization cost
// analytics are platform concerns, not workspace ones.
const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

async function req<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers as any) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as any).error || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Plans ───────────────────────────────────────────────────

export interface AdminEntitlement {
  key: string;
  valueType: string;
  value: unknown;
}

export interface AdminVolumeOption {
  id: string;
  key: string;
  channel: "CHAT" | "VOICE";
  dailyVolume: number;
  monthlyVolume: number;
  creditsPerUnit: string;
  additionalCredits: number;
  additionalPrice: string;
  currency: string;
  isDefault: boolean;
  enabled: boolean;
  sortOrder: number;
}

export interface AdminPlan {
  id: string;
  key: string;
  version: number;
  name: string;
  nameHe: string | null;
  descriptionEn: string | null;
  descriptionHe: string | null;
  status: "DRAFT" | "ACTIVE" | "RETIRED" | "ARCHIVED";
  kind: "PUBLIC" | "CUSTOM" | "POC" | "TRIAL" | "LEGACY";
  tenantId: string | null;
  basePrice: string | null;
  currency: string;
  includedCredits: number;
  billingInterval: string;
  sortOrder: number;
  recommended: boolean;
  salesOnly: boolean;
  supportLevel: string | null;
  chatVolumeEnabled: boolean;
  voiceVolumeEnabled: boolean;
  autoPurchaseEligible: boolean;
  creditPackagesEligible: boolean;
  effectiveFrom: string | null;
  publishedAt: string | null;
  internalNote: string | null;
  /** Organizations currently on this exact version. */
  subscriberCount: number;
  entitlements: AdminEntitlement[];
  volumeOptions: AdminVolumeOption[];
  estimation: {
    chatCreditsPerEstimatedConversation: number;
    voiceCreditsPerEstimatedCall: number;
    businessDaysPerMonth: number;
    version: number;
  } | null;
}

export interface AdminFeature {
  key: string;
  nameEn: string;
  nameHe: string;
  description: string;
  category: string;
  entitlementType: string;
  defaultValue: unknown;
  enforcementLocations: string[] | null;
  customerVisible: boolean;
  /** False = catalogued but NOT built. Cannot be attached to a plan. */
  implemented: boolean;
  sortOrder: number;
}

export const listAdminPlans = (token: string) => req<{ plans: AdminPlan[] }>("/api/admin/pricing/plans", token);
export const listAdminFeatures = (token: string) => req<{ features: AdminFeature[] }>("/api/admin/pricing/features", token);

export const createPlanVersion = (token: string, key: string, body: Record<string, unknown> = {}) =>
  req<{ ok: boolean; plan: { id: string; key: string; version: number; status: string } }>(
    `/api/admin/pricing/plans/${encodeURIComponent(key)}/versions`,
    token,
    { method: "POST", body: JSON.stringify(body) },
  );

export const updateDraftPlan = (token: string, id: string, body: Record<string, unknown>) =>
  req<{ ok: boolean }>(`/api/admin/pricing/plans/${id}`, token, { method: "PATCH", body: JSON.stringify(body) });

export const setPlanEntitlements = (token: string, id: string, entitlements: AdminEntitlement[]) =>
  req<{ ok: boolean; updated: number }>(`/api/admin/pricing/plans/${id}/entitlements`, token, {
    method: "PUT",
    body: JSON.stringify({ entitlements }),
  });

export const setPlanVolumeOptions = (token: string, id: string, options: unknown[]) =>
  req<{ ok: boolean; updated: number }>(`/api/admin/pricing/plans/${id}/volume-options`, token, {
    method: "PUT",
    body: JSON.stringify({ options }),
  });

export interface PublishPreview {
  draft: { id: string; key: string; version: number; status: string };
  currentVersion: number | null;
  changes: {
    price: { from: string | null; to: string | null };
    currency: { from: string | null; to: string };
    includedCredits: { from: number | null; to: number };
    features: Array<{ key: string; from: boolean | null; to: boolean }>;
    limits: Array<{ key: string; from: number | null; to: number }>;
    volumeOptions: { from: number; to: number };
  };
  impact: { organizationsOnPreviousVersion: number; grandfathering: string; migrationRequired: boolean };
}

export const previewPublish = (token: string, id: string) =>
  req<PublishPreview>(`/api/admin/pricing/plans/${id}/preview`, token);

export const publishPlan = (token: string, id: string) =>
  req<{ ok: boolean; published: { key: string; version: number }; retired: number | null }>(
    `/api/admin/pricing/plans/${id}/publish`,
    token,
    { method: "POST", body: "{}" },
  );

export const reorderPlans = (token: string, order: Array<{ key: string; sortOrder: number }>, recommendedKey: string | null) =>
  req<{ ok: boolean }>("/api/admin/pricing/plans/order", token, {
    method: "POST",
    body: JSON.stringify({ order, recommendedKey }),
  });

// ─── Public estimation ───────────────────────────────────────

export interface EstimationConfig {
  id: string;
  scope: string;
  version: number;
  active: boolean;
  planKey: string | null;
  volumeOptionKey: string | null;
  chatCreditsPerEstimatedConversation: number;
  voiceCreditsPerEstimatedCall: number;
  businessDaysPerMonth: number;
  effectiveFrom: string;
  internalNote: string | null;
  publishedAt: string | null;
}

export const listEstimationConfigs = (token: string) =>
  req<{ configs: EstimationConfig[] }>("/api/admin/pricing/estimation", token);

export interface EstimationPreview {
  proposed: { chatCreditsPerEstimatedConversation: number; voiceCreditsPerEstimatedCall: number; businessDaysPerMonth: number };
  affectedPlans: Array<{
    key: string;
    version: number;
    kind: string;
    before: { monthlyChats: number; dailyChats: number; monthlyCalls: number; pricePerChat: string | null };
    after: { monthlyChats: number; dailyChats: number; monthlyCalls: number; pricePerChat: string | null };
  }>;
  impact: { subscriptionsRetainingTheirSnapshot: number; guarantee: string };
}

export const previewEstimation = (token: string, body: Record<string, unknown>) =>
  req<EstimationPreview>("/api/admin/pricing/estimation/preview", token, { method: "POST", body: JSON.stringify(body) });

export const publishEstimation = (token: string, body: Record<string, unknown>) =>
  req<{ ok: boolean; config: { id: string; version: number; scope: string } }>("/api/admin/pricing/estimation", token, {
    method: "POST",
    body: JSON.stringify(body),
  });

// ─── Packages & currency ─────────────────────────────────────

export interface AdminPackage {
  key: string;
  name: string;
  nameHe: string | null;
  credits: number;
  price: string;
  currency: string;
  status: string;
  active: boolean;
  customerVisible: boolean;
  eligiblePlanKeys: string[] | null;
  expiryPolicy: string;
  expiryDays: number | null;
  maxPurchaseQuantity: number | null;
  discountLabel: string | null;
  sortOrder: number;
  scheduledPrice: string | null;
  scheduledPriceFrom: string | null;
  internalNote: string | null;
}

export const listAdminPackages = (token: string) =>
  req<{ packages: AdminPackage[] }>("/api/admin/pricing/packages", token);

export const savePackage = (token: string, key: string, body: Record<string, unknown>) =>
  req<{ ok: boolean }>(`/api/admin/pricing/packages/${encodeURIComponent(key)}`, token, {
    method: "PUT",
    body: JSON.stringify(body),
  });

export interface CurrencyAdmin {
  config: {
    baseCurrency: string;
    displayCurrencies: string[];
    ilsRoundingIncrement: number;
    roundingMode: string;
    fxSource: string;
    fxRefreshHours: number;
    fallbackUsdIls: string;
    chargeInDisplayCurrency: boolean;
  };
  fx: { rate: string; source: string; rateDate: string; fetchedAt: string } | null;
}

export const getCurrencyAdmin = (token: string) => req<CurrencyAdmin>("/api/admin/pricing/currency", token);
export const saveCurrencyAdmin = (token: string, body: Record<string, unknown>) =>
  req<{ ok: boolean }>("/api/admin/pricing/currency", token, { method: "PUT", body: JSON.stringify(body) });
export const refreshFx = (token: string) =>
  req<{ ok: boolean; fx: { rate: string; source: string; isFallback: boolean } }>(
    "/api/admin/pricing/currency/refresh-fx",
    token,
    { method: "POST", body: "{}" },
  );

// ─── Custom plans & evaluation ───────────────────────────────

export const createCustomPlan = (token: string, body: Record<string, unknown>) =>
  req<{ ok: boolean; plan: { id: string; key: string; version: number; status: string; tenantId: string } }>(
    "/api/admin/pricing/custom-plans",
    token,
    { method: "POST", body: JSON.stringify(body) },
  );

export const approveCustomPlan = (token: string, id: string) =>
  req<{ ok: boolean }>(`/api/admin/pricing/custom-plans/${id}/approve`, token, { method: "POST", body: "{}" });

export interface EvaluationTemplate {
  key: string;
  nameEn: string;
  nameHe: string;
  durationDays: number;
  creditCap: number;
  allFeatures: boolean;
  autoRenew: boolean;
  autoPurchaseEnabled: boolean;
  customerSelfActivate: boolean;
  transferRemainingCredits: boolean;
  bannerKind: string;
}

export const listEvaluationTemplates = (token: string) =>
  req<{ templates: EvaluationTemplate[] }>("/api/admin/evaluation/templates", token);

export const createEvaluation = (token: string, body: Record<string, unknown>) =>
  req<{ ok: boolean; kind: string; credits: number; expiresAt: string; featuresGranted: number }>(
    "/api/admin/evaluation",
    token,
    { method: "POST", body: JSON.stringify(body) },
  );

// ─── Actual conversation cost (layer A) ──────────────────────

export interface UsageStats {
  conversations: number;
  totalCredits: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalModelCostUsd: number;
  avgCreditsPerConversation: number;
  avgTokensPerConversation: number;
  avgInputTokensPerConversation: number;
  avgOutputTokensPerConversation: number;
  avgModelCostPerConversation: number;
  medianCredits: number;
  p75Credits: number;
  p90Credits: number;
  p95Credits: number;
  minCredits: number;
  maxCredits: number;
  stdDevCredits: number;
}

export const getConversationCosts = (token: string, query: Record<string, string> = {}) =>
  req<{ stats: UsageStats; averageMethod: string; scope: string }>(
    `/api/admin/analytics/conversation-costs?${new URLSearchParams(query)}`,
    token,
  );

export const getConversationCostsByTenant = (token: string, query: Record<string, string> = {}) =>
  req<{ tenants: Array<{ tenantId: string; name: string; stats: UsageStats }>; global: UsageStats; note: string }>(
    `/api/admin/analytics/conversation-costs/by-tenant?${new URLSearchParams(query)}`,
    token,
  );

export interface EstimateComparison {
  configuredPublicEstimate: number;
  actualAverage: number;
  differencePct: number | null;
  conversations: number;
  channel: string;
  warn: boolean;
  /** Always false. Actual usage never updates the public estimate. */
  autoApplied: false;
}

export const getEstimateVsActual = (token: string, query: Record<string, string> = {}) =>
  req<{ chat: EstimateComparison; voice: EstimateComparison; estimationVersion: number; guarantee: string }>(
    `/api/admin/analytics/estimate-vs-actual?${new URLSearchParams(query)}`,
    token,
  );

export const settleConversations = (token: string) =>
  req<{ ok: boolean; settled: number; discovered: number }>("/api/admin/analytics/settle", token, {
    method: "POST",
    body: "{}",
  });

export const backfillConversations = (token: string, limit = 200) =>
  req<{ ok: boolean; processed: number; linkedEvents: number }>("/api/admin/analytics/backfill", token, {
    method: "POST",
    body: JSON.stringify({ limit }),
  });
