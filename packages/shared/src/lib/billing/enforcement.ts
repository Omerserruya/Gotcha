/**
 * AI runtime enforcement - the pre-flight gate + post-call metering consumed
 * in-process by services/ai at the generateResponse() choke point.
 *
 * Rollout is staged via BILLING_ENFORCEMENT_MODE:
 *   off     - billing tables not consulted (default; safe pre-seed).
 *   observe - meter Units (ledger + usage), never block, never notify.
 *   soft    - meter + notify thresholds, never block.
 *   hard    - block AI at zero Units / suspended subscription.
 *
 * Grandfathered (or any subscription with enforcementEnabled=false) is always
 * allowed and never metered as a hard stop - financial state stays deterministic
 * (no "infinite balance" hack).
 */
import { prisma } from "../prisma";
import { checkPaidAccess } from "./entitlement-gate";
import { priceUsageFromDb } from "./pricing";
import { getBalance, consumeUnits, type UsageThreshold } from "./wallet";

export type EnforcementMode = "off" | "observe" | "soft" | "hard";

/**
 * The enforcement mode, in this module's vocabulary.
 *
 * Two vocabularies exist for one setting: off/observe/soft/hard here, and
 * off/audit/enforce in the gate. Both are accepted, because a deployment set to
 * the OTHER spelling used to fall through to "off" - which does not merely skip
 * enforcement, it skips metering, so usage would stop being recorded and
 * nobody would see a number indicating anything was wrong.
 */
export function getEnforcementMode(): EnforcementMode {
  const m = String(process.env.BILLING_ENFORCEMENT_MODE || "off").toLowerCase().trim();
  if (m === "enforce") return "hard";
  if (m === "audit") return "soft";
  return (["off", "observe", "soft", "hard"].includes(m) ? m : "off") as EnforcementMode;
}

/**
 * Every way a paid operation can be refused.
 *
 * Mirrors DenialReason from the entitlement gate, which is now the single place
 * the decision is made. Two vocabularies for one decision would drift, and the
 * drift would show up as a customer being told the wrong thing.
 */
export type DenyReason =
  | "units_exhausted"
  | "suspended"
  | "canceled"
  | "payment_required"
  | "tenant_suspended"
  | "no_subscription"
  | "subscription_pending"
  | "subscription_suspended"
  | "subscription_canceled"
  | "subscription_paused"
  | "trial_expired"
  | "poc_expired"
  | "past_due_grace_expired"
  | "feature_not_in_plan"
  | "credits_exhausted";

export class AiUnitsExhaustedError extends Error {
  constructor(public reason: DenyReason, public tenantId: string) {
    super(`ai_units:${reason}`);
    this.name = "AiUnitsExhaustedError";
  }
}

export interface AiAllowance {
  /** Whether the AI call may proceed (only `hard` mode actually blocks). */
  allowed: boolean;
  /** True when the tenant is out of Units / not serviceable (any mode). */
  wouldBlock: boolean;
  reason?: DenyReason;
  mode: EnforcementMode;
  /** Total remaining Units (Infinity when enforcement is off/disabled). */
  balance: number;
}

/**
 * Pre-flight: may this tenant run an AI request right now? Cheap - reads the
 * subscription + the materialized balance snapshot. Never throws.
 */
/**
 * May this tenant run an AI request right now?
 *
 * Delegates to the entitlement gate, which asks BOTH halves of the question -
 * is the organization commercially in good standing, and does their plan
 * include what they are about to use. This used to ask only the first, so a
 * paying customer could use a capability they had never bought.
 *
 * `feature` is optional because many call sites are asking the general question
 * ("may this tenant run AI at all"). When a caller knows which capability is
 * being exercised, passing it is what makes the second half meaningful.
 *
 * Never throws.
 */
export async function checkAiAllowed(tenantId: string, feature?: string): Promise<AiAllowance> {
  const decision = await checkPaidAccess({ tenantId, feature });
  // This module's callers have always known an exhausted wallet as
  // "units_exhausted". Renaming it here would silently change what every
  // consumer switching on the reason sees.
  const reason = decision.reason === "credits_exhausted" ? "units_exhausted" : decision.reason;
  const mode = decision.mode === "enforce" ? "hard" : decision.mode === "audit" ? "soft" : "off";
  return {
    allowed: decision.allowed,
    wouldBlock: decision.wouldDeny,
    reason: reason as DenyReason | undefined,
    mode: mode as EnforcementMode,
    // Infinity means "credits were not the deciding factor", which is what the
    // callers that render a balance expect to see when the block was
    // commercial rather than a spent wallet.
    balance: decision.balance ?? Infinity,
  };
}

/** Pre-flight that throws AiUnitsExhaustedError when the call must be blocked. */
export async function assertAiAllowed(tenantId: string): Promise<AiAllowance> {
  const a = await checkAiAllowed(tenantId);
  if (!a.allowed && a.reason) throw new AiUnitsExhaustedError(a.reason, tenantId);
  return a;
}

export interface MeterResult {
  unitsConsumed: number;
  providerCostUsd: number;
  thresholds: UsageThreshold[];
  shortfall: number;
  periodKey: string | null;
}

/**
 * Post-call metering: price the usage (cost-driven), debit the wallet
 * (INCLUDED→PURCHASED FIFO, never negative), and report crossed thresholds so
 * the caller can notify / trigger auto-purchase. No-op when enforcement is off.
 */
export async function meterAiUnits(input: {
  tenantId: string;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  referenceId?: string;
}): Promise<MeterResult | null> {
  if (getEnforcementMode() === "off") return null;
  const { unitsConsumed, providerCostUsd } = await priceUsageFromDb(
    input.model,
    input.inputTokens,
    input.outputTokens,
    input.cachedInputTokens ?? 0,
  );
  const bal = await getBalance(input.tenantId);
  const res = await consumeUnits(input.tenantId, unitsConsumed, { periodKey: bal.periodKey, referenceId: input.referenceId, source: "ai_usage" });
  return { unitsConsumed, providerCostUsd, thresholds: res.thresholds, shortfall: res.shortfall, periodKey: bal.periodKey };
}
