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

export {
  getEnforcementMode,
  checkAiAllowed,
  assertAiAllowed,
  meterAiUnits,
  AiUnitsExhaustedError,
} from "./enforcement";
export type { EnforcementMode, AiAllowance, MeterResult, DenyReason } from "./enforcement";
