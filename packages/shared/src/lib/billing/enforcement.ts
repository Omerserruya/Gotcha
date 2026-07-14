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
import { priceUsageFromDb } from "./pricing";
import { getBalance, consumeUnits, type UsageThreshold } from "./wallet";

export type EnforcementMode = "off" | "observe" | "soft" | "hard";

export function getEnforcementMode(): EnforcementMode {
  const m = (process.env.BILLING_ENFORCEMENT_MODE || "off").toLowerCase();
  return (["off", "observe", "soft", "hard"].includes(m) ? m : "off") as EnforcementMode;
}

export type DenyReason = "units_exhausted" | "suspended" | "canceled";

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
export async function checkAiAllowed(tenantId: string): Promise<AiAllowance> {
  const mode = getEnforcementMode();
  if (mode === "off") return { allowed: true, wouldBlock: false, mode, balance: Infinity };

  let sub: { status: string; enforcementEnabled: boolean } | null = null;
  try {
    const link = await prisma.billableEntityTenant.findUnique({
      where: { tenantId },
      include: { entity: { include: { subscription: true } } },
    });
    sub = link?.entity.subscription ?? null;
  } catch {
    // Fail-open on read error - never block paying customers on a DB blip.
    return { allowed: true, wouldBlock: false, mode, balance: Infinity };
  }

  // No subscription yet, or enforcement explicitly disabled (grandfathered).
  if (!sub || !sub.enforcementEnabled) return { allowed: true, wouldBlock: false, mode, balance: Infinity };

  let reason: DenyReason | undefined;
  let balance = 0;
  if (sub.status === "SUSPENDED") reason = "suspended";
  else if (sub.status === "CANCELED") reason = "canceled";
  else {
    const bal = await getBalance(tenantId);
    balance = bal.total;
    if (bal.total <= 0) reason = "units_exhausted";
  }

  const wouldBlock = reason != null;
  // Only `hard` mode actually blocks; observe/soft meter+notify but allow.
  return { allowed: wouldBlock ? mode !== "hard" : true, wouldBlock, reason, mode, balance };
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
