// Billing shared library - pricing engine, AI-Unit wallet, entitlement layering.
// Money/subscription orchestration lives in services/billing; this package holds
// the cross-service read model + pure math, consumed in-process like permissions.
export {
  providerCostUsd,
  costToUnits,
  priceUsage,
  priceUsageFromDb,
  loadModelPricing,
  loadUnitPricing,
  invalidatePricingCache,
  FALLBACK_MODEL_PRICING,
  FALLBACK_UNIT_PRICING,
} from "./pricing";
export type { ModelPricing, UnitPricing } from "./pricing";

export {
  crossedThresholds,
  planConsumption,
  getBalance,
  deriveBalanceFromLots,
  grantUnits,
  consumeUnits,
  rolloverIncluded,
  refundUnitsForReference,
  expireDueLots,
} from "./wallet";
export type { BalanceView, ConsumeResult, GrantInput, UsageThreshold } from "./wallet";

export {
  getEffectiveEntitlements,
  getLimits,
  getLimit,
  materializeEntitlements,
  setTenantEntitlement,
} from "./entitlements";
export type { EffectiveEntitlement } from "./entitlements";

// The canonical entitlement resolver + the feature catalog it reads.
export {
  resolveEntitlements,
  entitledIn,
  isEntitled,
  assertEntitled,
  resolveLimit,
  resolveLimits,
  limitIn,
  isUnlimited,
  assertWithinLimit,
  overLimitDisposition,
  entitlementErrorResponse,
  EntitlementDeniedError,
  asBool,
  asNumber,
  asString,
} from "./entitlement-resolver";
export type {
  ResolvedEntitlement,
  EntitlementSet,
  EntitlementErrorBody,
  LimitBreachBehavior,
} from "./entitlement-resolver";

export {
  FEATURE_CATALOG,
  BOOLEAN_FEATURE_KEYS,
  LIMIT_KEYS,
  UNLIMITED_LIMIT,
  getFeatureDef,
  sellableFeatureKeys,
  isUnsellable,
  featuresByCategory,
} from "./feature-catalog";
// FeatureCategory is exported as BillingFeatureCategory: the shared barrel
// already carries an unrelated `FeatureCategory` from lib/features.
export type { FeatureDef, FeatureCategory as BillingFeatureCategory } from "./feature-catalog";

// Money as integer minor units - no floating point anywhere in pricing.
export {
  money,
  zero,
  toMinor,
  toDecimalString,
  toNumber,
  addMoney,
  sumMoney,
  subtractMoney,
  multiplyMoney,
  roundToIncrement,
  convertMoney,
  formatMoney,
  minorUnitScale,
} from "./money";
// Exported as BillingMoney: the shared barrel already carries an unrelated
// commerce-context `Money` (a { amount, currency } display shape).
export type { Money as BillingMoney, CurrencyCode, RoundingMode } from "./money";

// Public commercial estimation (layer B) - manually configured, never derived.
export {
  getGlobalEstimation,
  resolveEstimation,
  estimateChannel,
  estimateDeclaredChannel,
  estimatePlanCapacity,
  estimatePricePerInteraction,
  estimateRemainingConversations,
  snapshotEstimation,
  ratiosFromSnapshot,
  invalidateEstimationCache,
  FALLBACK_ESTIMATION,
  ESTIMATE_DISCLAIMER,
  ESTIMATE_DISCLAIMER_KEY,
} from "./estimation";
export type {
  EstimationRatios,
  ChannelEstimate,
  EstimateBasis,
  DeclaredVolume,
  PlanEstimate,
  PriceBreakdown,
  EstimationSnapshot,
} from "./estimation";

// USD canonical / ILS display conversion.
export {
  getCurrencyConfig,
  getUsdIlsRate,
  refreshUsdIlsRate,
  toDisplayPrice,
  resolveChargeAmount,
  invalidateCurrencyCache,
  DEFAULT_CURRENCY_CONFIG,
} from "./currency";
export type { CurrencyConfig, FxRate, DisplayPrice } from "./currency";

// ACTUAL per-conversation usage (layer A) - SYSADMIN ONLY. Never referenced by
// estimation.ts, and never surfaced through a tenant-facing route.
export {
  aggregateConversation,
  settleDueConversations,
  sweepClosedConversations,
  excludeConversation,
  computeStats,
  getUsageStats,
  getStatsByTenant,
  compareEstimateToActual,
  conversationIdOf,
  CALCULATION_VERSION,
  SETTLEMENT_WINDOW_MS,
} from "./conversation-usage";
export type {
  AggregateResult,
  UsageStats,
  UsageStatsFilter,
  EstimateComparison,
} from "./conversation-usage";

export {
  getEnforcementMode,
  checkAiAllowed,
  assertAiAllowed,
  meterAiUnits,
  AiUnitsExhaustedError,
} from "./enforcement";
export type { EnforcementMode, AiAllowance, MeterResult, DenyReason } from "./enforcement";
export * from "./payment-token-crypto";

// The unified gate: commercial standing AND feature entitlement, in one place,
// callable from background workers that have no request context.
export {
  checkPaidAccess,
  assertPaidAccess,
  getEnforcementMode as getPaidAccessMode,
  assertEnforcementConfigured,
  pastDueGraceHours,
  explainDenial,
  PaidAccessDeniedError,
} from "./entitlement-gate";
export type { PaidAccessDecision, PaidAccessQuery, DenialReason } from "./entitlement-gate";

// The tenant-commercial invariant: every organization has exactly one plan.
export {
  classifyTenantPlanAccess,
  subscriptionIsActiveSource,
  planAccessLabel,
} from "./tenant-plan-access";
export type {
  PlanAccessSource,
  PlanAccessState,
  PlanAccessVerdict,
  PlanAccessInput,
  PlanAccessSubscription,
} from "./tenant-plan-access";
export {
  resolveTenantPlanAccess,
  resolveTenantPlanAccessBatch,
  tenantPlanGateFacts,
} from "./tenant-plan-resolver";
export * from "./spend-window";

// Coupons: recurring discounts on an existing price. Pure arithmetic - the
// billing service owns loading the assignment and writing the result.
export {
  applyCouponToPrice,
  couponLabel,
  assignmentIsLive,
  breakdownToDecimals,
} from "./coupon";
export type { CouponTerms, CouponDiscountKind, DiscountBreakdown } from "./coupon";
