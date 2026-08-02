/**
 * Public commercial estimation - layer B.
 *
 * This module converts CREDITS into an ESTIMATED number of conversations using
 * a ratio a human operator typed in. That is the whole point:
 *
 *   • The ratio is a deliberate commercial assumption and a deliberate
 *     commercial risk. GOTCHA owns it.
 *   • It is NOT the platform's real average, NOT any organization's real
 *     average, and is never derived from `ConversationUsageAggregate`,
 *     `UsageLog`, or any other actual-usage source. Nothing in this file reads
 *     those tables, and nothing may.
 *   • Changing it changes what a pricing page SAYS. It never writes to the
 *     credit ledger, an invoice, or an existing subscription's snapshot.
 *
 * The Sysadmin console may compare this ratio against actual internal usage and
 * warn when they diverge. Only an explicit operator action publishes a new
 * version.
 *
 * The ratio is the FALLBACK, not the first answer. Where a plan sells an
 * explicit volume - "50 conversations per business day" - that volume is the
 * offer and is reported as-is; see `estimateDeclaredChannel`.
 */
import { prisma } from "../prisma";
import { type Money, zero, multiplyMoney } from "./money";

export interface EstimationRatios {
  chatCreditsPerEstimatedConversation: number;
  voiceCreditsPerEstimatedCall: number;
  businessDaysPerMonth: number;
  /** Version + id of the config that produced these, for the snapshot. */
  version: number;
  configId: string | null;
  scope: "GLOBAL" | "PLAN" | "VOLUME_OPTION" | "FALLBACK";
}

/**
 * Last-resort configured fallback, used ONLY when the estimation tables are
 * empty (fresh install, before the first seed). Deliberately NOT derived from
 * actual usage - falling back to real analytics is exactly the coupling this
 * layer exists to prevent.
 */
export const FALLBACK_ESTIMATION: EstimationRatios = {
  chatCreditsPerEstimatedConversation: 8,
  voiceCreditsPerEstimatedCall: 20,
  businessDaysPerMonth: 25,
  version: 0,
  configId: null,
  scope: "FALLBACK",
};

const CACHE_TTL_MS = 30_000;
let globalCache: { at: number; value: EstimationRatios } | null = null;

export function invalidateEstimationCache(): void {
  globalCache = null;
}

function dec(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  const n = typeof v === "object" && "toNumber" in (v as any) ? (v as any).toNumber() : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function fromRow(row: any, scope: EstimationRatios["scope"]): EstimationRatios {
  return {
    chatCreditsPerEstimatedConversation: dec(row.chatCreditsPerEstimatedConversation, FALLBACK_ESTIMATION.chatCreditsPerEstimatedConversation),
    voiceCreditsPerEstimatedCall: dec(row.voiceCreditsPerEstimatedCall, FALLBACK_ESTIMATION.voiceCreditsPerEstimatedCall),
    businessDaysPerMonth: Math.max(1, Math.round(dec(row.businessDaysPerMonth, FALLBACK_ESTIMATION.businessDaysPerMonth))),
    version: row.version ?? 1,
    configId: row.id ?? null,
    scope,
  };
}

/** The active global commercial assumption (newest effective row wins). */
export async function getGlobalEstimation(now = new Date()): Promise<EstimationRatios> {
  if (globalCache && Date.now() - globalCache.at < CACHE_TTL_MS) return globalCache.value;
  let value = FALLBACK_ESTIMATION;
  try {
    const row = await prisma.publicEstimationConfig.findFirst({
      where: { scope: "GLOBAL", active: true, effectiveFrom: { lte: now } },
      orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
    });
    if (row) value = fromRow(row, "GLOBAL");
  } catch (err: any) {
    console.error("[billing/estimation] global load failed:", err?.message ?? err);
  }
  globalCache = { at: Date.now(), value };
  return value;
}

/**
 * Resolve the ratios in force for a plan / volume option.
 *
 * Precedence:
 *   1. VOLUME_OPTION-scoped config  (most specific)
 *   2. PLAN-scoped config           (covers custom plans - a custom plan IS a plan)
 *   3. Active GLOBAL config
 *   4. Configured fallback
 *
 * Never falls through to actual internal usage analytics.
 */
export async function resolveEstimation(
  opts: { planId?: string | null; volumeOptionId?: string | null } = {},
  now = new Date(),
): Promise<EstimationRatios> {
  try {
    if (opts.volumeOptionId) {
      const row = await prisma.publicEstimationConfig.findFirst({
        where: { scope: "VOLUME_OPTION", volumeOptionId: opts.volumeOptionId, active: true, effectiveFrom: { lte: now } },
        orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
      });
      if (row) return fromRow(row, "VOLUME_OPTION");
    }
    if (opts.planId) {
      const row = await prisma.publicEstimationConfig.findFirst({
        where: { scope: "PLAN", planId: opts.planId, active: true, effectiveFrom: { lte: now } },
        orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
      });
      if (row) return fromRow(row, "PLAN");
    }
  } catch (err: any) {
    console.error("[billing/estimation] scoped load failed:", err?.message ?? err);
  }
  return getGlobalEstimation(now);
}

// ── Pure customer-facing formulas (DB-free, unit-tested) ───────────────────

export interface ChannelEstimate {
  allocatedCredits: number;
  /**
   * Credits assumed per conversation / call.
   *
   * With `basis: "CREDIT_RATIO"` this is the configured assumption that produced
   * the estimate. With `basis: "DECLARED_VOLUME"` it is the ratio the sold
   * volume IMPLIES - allocated credits divided by the volume being sold - which
   * is what a sysadmin needs to see to judge whether the two agree.
   */
  creditsPerUnit: number;
  estimatedMonthly: number;
  estimatedDaily: number;
  /** Where the number came from. See `estimateDeclaredChannel`. */
  basis: EstimateBasis;
}

export type EstimateBasis = "DECLARED_VOLUME" | "CREDIT_RATIO";

/**
 * The volume a plan explicitly SELLS on a channel, as chosen in the
 * configurator - "50 conversations per business day".
 */
export interface DeclaredVolume {
  daily: number;
  monthly: number;
}

/** estimatedMonthlyChats = allocatedChatCredits / creditsPerConversation. */
export function estimateChannel(
  allocatedCredits: number,
  creditsPerUnit: number,
  businessDaysPerMonth: number,
): ChannelEstimate {
  // Guard the zero denominator explicitly rather than rendering Infinity/NaN.
  if (!(creditsPerUnit > 0) || !(allocatedCredits > 0)) {
    return {
      allocatedCredits: Math.max(0, allocatedCredits),
      creditsPerUnit,
      estimatedMonthly: 0,
      estimatedDaily: 0,
      basis: "CREDIT_RATIO",
    };
  }
  const days = businessDaysPerMonth > 0 ? businessDaysPerMonth : 1;
  const monthly = allocatedCredits / creditsPerUnit;
  return {
    allocatedCredits,
    creditsPerUnit,
    estimatedMonthly: monthly,
    estimatedDaily: monthly / days,
    basis: "CREDIT_RATIO",
  };
}

/**
 * Capacity for a channel whose volume was DECLARED rather than derived.
 *
 * When a plan sells "50 conversations per business day", that number is the
 * offer. Re-deriving it from credits divided by the global credits-per-
 * conversation assumption is what let the configurator contradict itself: the
 * visitor picked 50/day and the summary underneath answered with a different
 * number, because the plan's credit allowance and the global ratio had never
 * been reconciled.
 *
 * So the declared volume wins, and the ratio it implies is reported alongside
 * it - honestly labelled - instead of being silently substituted.
 */
export function estimateDeclaredChannel(
  allocatedCredits: number,
  declared: DeclaredVolume,
  businessDaysPerMonth: number,
): ChannelEstimate {
  const days = businessDaysPerMonth > 0 ? businessDaysPerMonth : 1;
  const monthly = declared.monthly > 0 ? declared.monthly : Math.max(0, declared.daily) * days;
  const daily = declared.daily > 0 ? declared.daily : monthly / days;
  const credits = Math.max(0, allocatedCredits);
  return {
    allocatedCredits: credits,
    creditsPerUnit: monthly > 0 && credits > 0 ? credits / monthly : 0,
    estimatedMonthly: monthly,
    estimatedDaily: daily,
    basis: "DECLARED_VOLUME",
  };
}

export interface PlanEstimate {
  chat: ChannelEstimate;
  voice: ChannelEstimate;
  /** Chat + voice. The denominator for the blended price. */
  estimatedTotalInteractions: number;
  ratios: EstimationRatios;
}

/**
 * Estimate a plan's capacity. Chat and voice are calculated SEPARATELY from
 * their own credit allocations - the plan configuration decides how the total
 * recurring allowance is split, and no claim is made that one pool magically
 * covers both.
 *
 * A channel that declares the volume it sells (`chatVolume` / `voiceVolume`)
 * is reported at that volume. Only a channel with nothing declared falls back
 * to dividing its credits by the configured ratio.
 */
export function estimatePlanCapacity(input: {
  chatCredits: number;
  voiceCredits: number;
  ratios: EstimationRatios;
  chatVolume?: DeclaredVolume | null;
  voiceVolume?: DeclaredVolume | null;
}): PlanEstimate {
  const { ratios } = input;
  const chat = hasVolume(input.chatVolume)
    ? estimateDeclaredChannel(input.chatCredits, input.chatVolume!, ratios.businessDaysPerMonth)
    : estimateChannel(input.chatCredits, ratios.chatCreditsPerEstimatedConversation, ratios.businessDaysPerMonth);
  const voice = hasVolume(input.voiceVolume)
    ? estimateDeclaredChannel(input.voiceCredits, input.voiceVolume!, ratios.businessDaysPerMonth)
    : estimateChannel(input.voiceCredits, ratios.voiceCreditsPerEstimatedCall, ratios.businessDaysPerMonth);
  return {
    chat,
    voice,
    estimatedTotalInteractions: chat.estimatedMonthly + voice.estimatedMonthly,
    ratios,
  };
}

function hasVolume(v: DeclaredVolume | null | undefined): boolean {
  return !!v && (v.monthly > 0 || v.daily > 0);
}

export interface PriceBreakdown {
  monthlyPrice: Money;
  /** null when there is nothing to divide by - never Infinity, never NaN. */
  pricePerChat: Money | null;
  pricePerCall: Money | null;
  pricePerInteraction: Money | null;
}

/**
 * Price per estimated interaction.
 *
 * Chat and voice each carry the share of the monthly price proportional to their
 * estimated volume, so a plan with 250 chats and 250 calls does not claim both
 * cost the full monthly price. A zero denominator yields null, which the UI
 * renders as "-" rather than a division artefact.
 */
export function estimatePricePerInteraction(monthlyPrice: Money, est: PlanEstimate): PriceBreakdown {
  const total = est.estimatedTotalInteractions;
  if (!(total > 0)) {
    return { monthlyPrice, pricePerChat: null, pricePerCall: null, pricePerInteraction: null };
  }
  const perInteraction = divideMoney(monthlyPrice, total);
  const chatShare = est.chat.estimatedMonthly / total;
  const voiceShare = est.voice.estimatedMonthly / total;
  return {
    monthlyPrice,
    pricePerChat: est.chat.estimatedMonthly > 0
      ? divideMoney(multiplyMoney(monthlyPrice, chatShare), est.chat.estimatedMonthly)
      : null,
    pricePerCall: est.voice.estimatedMonthly > 0
      ? divideMoney(multiplyMoney(monthlyPrice, voiceShare), est.voice.estimatedMonthly)
      : null,
    pricePerInteraction: perInteraction,
  };
}

/** Integer-minor-unit division. Returns zero-money for a zero denominator. */
function divideMoney(m: Money, divisor: number): Money {
  if (!(divisor > 0)) return zero(m.currency);
  return { minor: Math.round(m.minor / divisor), currency: m.currency };
}

/**
 * How many more conversations the customer can expect from the credits they
 * have left right now. Uses the PUBLIC ratio; the balance itself comes from the
 * ledger, which remains authoritative for the number of credits.
 */
export function estimateRemainingConversations(
  remainingCredits: number,
  ratios: EstimationRatios,
  channel: "chat" | "voice" = "chat",
): number {
  const per = channel === "voice" ? ratios.voiceCreditsPerEstimatedCall : ratios.chatCreditsPerEstimatedConversation;
  if (!(per > 0) || !(remainingCredits > 0)) return 0;
  return Math.floor(remainingCredits / per);
}

// ── Snapshotting ────────────────────────────────────────────────────────────

export interface EstimationSnapshot {
  chatCreditsPerEstimatedConversation: number;
  voiceCreditsPerEstimatedCall: number;
  businessDaysPerMonth: number;
  version: number;
  configId: string | null;
  scope: string;
  capturedAt: string;
}

/**
 * Freeze the assumptions in force so an invoice, confirmation or plan summary
 * rendered months later still shows the numbers the customer actually agreed to.
 */
export function snapshotEstimation(r: EstimationRatios, at = new Date()): EstimationSnapshot {
  return {
    chatCreditsPerEstimatedConversation: r.chatCreditsPerEstimatedConversation,
    voiceCreditsPerEstimatedCall: r.voiceCreditsPerEstimatedCall,
    businessDaysPerMonth: r.businessDaysPerMonth,
    version: r.version,
    configId: r.configId,
    scope: r.scope,
    capturedAt: at.toISOString(),
  };
}

/** Read a stored snapshot back, falling through to `current` when absent. */
export function ratiosFromSnapshot(snapshot: unknown, current: EstimationRatios): EstimationRatios {
  if (!snapshot || typeof snapshot !== "object") return current;
  const s = snapshot as Partial<EstimationSnapshot>;
  if (!(Number(s.chatCreditsPerEstimatedConversation) > 0)) return current;
  return {
    chatCreditsPerEstimatedConversation: Number(s.chatCreditsPerEstimatedConversation),
    voiceCreditsPerEstimatedCall: Number(s.voiceCreditsPerEstimatedCall) || current.voiceCreditsPerEstimatedCall,
    businessDaysPerMonth: Number(s.businessDaysPerMonth) || current.businessDaysPerMonth,
    version: Number(s.version) || 0,
    configId: s.configId ?? null,
    scope: (s.scope as EstimationRatios["scope"]) ?? "GLOBAL",
  };
}

// ── Customer copy ───────────────────────────────────────────────────────────

/**
 * The disclaimer that must accompany every conversation estimate. Kept here so
 * every surface uses the same honest wording, and so it can never drift into
 * claiming the estimate comes from other customers' usage.
 */
export const ESTIMATE_DISCLAIMER_KEY = "billing.estimate.disclaimer";

export const ESTIMATE_DISCLAIMER = {
  en: "Conversation estimates are based on the plan configuration. Actual credit consumption varies by conversation length, channel, AI actions, enabled features and voice duration.",
  he: "הערכות השיחות מבוססות על תצורת התוכנית. צריכת הקרדיטים בפועל משתנה לפי אורך השיחה, הערוץ, פעולות ה-AI, היכולות שהופעלו ומשך שיחות הקול.",
};
