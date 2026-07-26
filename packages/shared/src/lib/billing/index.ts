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
export type { FeatureDef, FeatureCategory } from "./feature-catalog";

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
export type { Money, CurrencyCode, RoundingMode } from "./money";

// Public commercial estimation (layer B) - manually configured, never derived.
export {
  getGlobalEstimation,
  resolveEstimation,
  estimateChannel,
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

export {
  getEnforcementMode,
  checkAiAllowed,
  assertAiAllowed,
  meterAiUnits,
  AiUnitsExhaustedError,
} from "./enforcement";
export type { EnforcementMode, AiAllowance, MeterResult, DenyReason } from "./enforcement";
