// Public pricing client - unauthenticated, shared by /pricing and the landing
// page section. Every number it returns was computed server-side by the
// canonical pricing service; nothing here recalculates a price.
const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

/**
 * Deployment mirror of the server flag.
 *
 * Presentation only. nginx and the billing service are the actual gate - this
 * exists so the nav and landing section render correctly on first paint instead
 * of flashing a Pricing link that leads to a redirect.
 */
export const publicPricingEnabled =
  String(process.env.NEXT_PUBLIC_PRICING_ENABLED ?? "false").toLowerCase() === "true";

export interface PublicPrice {
  amount: string;
  currency: string;
  formatted: string;
  base: { amount: string; currency: string; formatted: string };
  /** True when `formatted` is a converted estimate rather than the charged amount. */
  isEstimatedConversion: boolean;
  chargedCurrency: string;
}

export interface PublicChannelEstimate {
  credits: number;
  monthly: number;
  daily: number;
  /** "DECLARED_VOLUME" = the volume the plan sells; "CREDIT_RATIO" = derived. */
  basis: "DECLARED_VOLUME" | "CREDIT_RATIO";
  creditsPerUnit: number;
}

export interface PublicEstimate {
  chat: PublicChannelEstimate;
  voice: PublicChannelEstimate;
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

export interface PublicVolumeOption {
  key: string;
  channel: "CHAT" | "VOICE";
  dailyVolume: number;
  monthlyVolume: number;
  additionalCredits: number;
  additionalPrice: PublicPrice;
  isDefault: boolean;
  totalChannelCredits: number;
}

export interface PublicFeature {
  key: string;
  name: string;
  nameEn: string;
  nameHe: string;
  description: string | null;
  category: string;
  included: boolean;
}

export interface PublicPlan {
  key: string;
  version: number;
  name: string;
  nameHe: string | null;
  description: string | null;
  descriptionHe: string | null;
  recommended: boolean;
  sortOrder: number;
  salesOnly: boolean;
  billingInterval: string;
  price: PublicPrice | null;
  includedCredits: number;
  creditSplit: { chat: number; voice: number };
  supportLevel: string | null;
  chatVolumeEnabled: boolean;
  voiceVolumeEnabled: boolean;
  autoPurchaseEligible: boolean;
  creditPackagesEligible: boolean;
  features: PublicFeature[];
  limits: Record<string, number>;
  chatOptions: PublicVolumeOption[];
  voiceOptions: PublicVolumeOption[];
  estimate: PublicEstimate;
}

/**
 * The tax the listed prices are BEFORE.
 *
 * No visitor has declared where they are, so this is the default jurisdiction
 * and `assumed` is always true here. The page states it as "+ VAT" rather than
 * folding it into a total: an Israeli consumer may not be quoted a price with
 * the tax left unmentioned, and a visitor abroad must not be shown a total
 * including one they will not be charged.
 */
export interface PublicTaxSummary {
  percent: number;
  label: string | null;
  countryCode: string;
  exempt: boolean;
  assumed: boolean;
}

export interface PublicPricingCatalog {
  enabled: true;
  plans: PublicPlan[];
  tax: PublicTaxSummary;
  currency: {
    base: string;
    display: string;
    available: string[];
    isEstimatedConversion: boolean;
    chargedCurrency: string;
    ilsRoundingIncrement: number;
    fx: { rate: string; source: string; rateDate: string; isFallback: boolean } | null;
  };
  disclaimer: { en: string; he: string };
}

export class PricingUnavailableError extends Error {
  constructor(readonly status: number) {
    super(`pricing_unavailable:${status}`);
    this.name = "PricingUnavailableError";
  }
}

export async function getPublicPricing(
  opts: { currency?: string; locale?: string; signal?: AbortSignal } = {},
): Promise<PublicPricingCatalog> {
  const qs = new URLSearchParams();
  if (opts.currency) qs.set("currency", opts.currency);
  if (opts.locale) qs.set("locale", opts.locale);
  const res = await fetch(`${API_URL}/api/public/pricing?${qs}`, {
    signal: opts.signal,
    headers: { Accept: "application/json" },
  });
  // A disabled or unavailable catalog is a first-class state the UI renders,
  // never an exception that leaks a stack trace to a visitor.
  if (!res.ok) throw new PricingUnavailableError(res.status);
  return res.json() as Promise<PublicPricingCatalog>;
}

// ── Client-side selection maths ─────────────────────────────────────────────
// These compose SERVER-COMPUTED figures. They never price anything: credits and
// prices come from the catalog, and the only arithmetic is adding an option's
// pre-computed `additionalCredits` to the plan's pre-computed base.

export interface Selection {
  chat: string | null;
  voice: string | null;
}

export function defaultSelection(plan: PublicPlan): Selection {
  return {
    chat: plan.chatVolumeEnabled ? plan.chatOptions.find((o) => o.isDefault)?.key ?? null : null,
    voice: plan.voiceVolumeEnabled ? plan.voiceOptions.find((o) => o.isDefault)?.key ?? null : null,
  };
}

export interface Quote {
  chatCredits: number;
  voiceCredits: number;
  includedCredits: number;
  /** Credits from the plan itself, before any volume option. */
  baseCredits: number;
  /** Credits added by the selected options. */
  addedCredits: number;
  monthlyMinor: number;
  currency: string;
  /**
   * The same total in the currency actually charged.
   *
   * Needed because the plan columns now price a live selection: showing
   * "approximately X, charged in USD" against the plan's BASE price while the
   * displayed total includes chosen volume would understate what is charged.
   */
  monthlyBaseMinor: number;
  baseCurrency: string;
  isEstimatedConversion: boolean;
  chargedCurrency: string;
  chatOption: PublicVolumeOption | null;
  voiceOption: PublicVolumeOption | null;
  estimatedChatsMonthly: number;
  estimatedChatsDaily: number;
  estimatedCallsMonthly: number;
  estimatedCallsDaily: number;
  /**
   * Whether the volumes above are what the plan SELLS or what its credits
   * imply. A sold volume is a commitment and must not be hedged with a "~".
   */
  chatBasis: "DECLARED_VOLUME" | "CREDIT_RATIO";
  voiceBasis: "DECLARED_VOLUME" | "CREDIT_RATIO";
  pricePerChatMinor: number | null;
  pricePerCallMinor: number | null;
  pricePerInteractionMinor: number | null;
}

/** The monthly volume an option sells, falling back to daily x business days. */
function monthlyOf(o: PublicVolumeOption, businessDays: number): number {
  if (o.monthlyVolume > 0) return o.monthlyVolume;
  return Math.max(0, o.dailyVolume) * businessDays;
}

/** Money is handled in integer minor units, never floats. */
function toMinor(decimal: string): number {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(decimal.trim());
  if (!m) return 0;
  const [, sign, whole, frac = ""] = m;
  const cents = Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
  return sign === "-" ? -cents : cents;
}

export function formatMinor(minor: number, currency: string, decimals = 0): string {
  const symbol = currency === "ILS" ? "₪" : "$";
  const value = minor / 100;
  return `${symbol}${value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * Price a selection from catalog values.
 *
 * Capacity comes from the volume the selected option SELLS. Only an unselected
 * channel falls back to its own credit pool divided by the published ratio, so
 * the page never implies one allowance covers both. Zero denominators yield
 * null and render as "-" rather than Infinity.
 */
export function quoteSelection(plan: PublicPlan, selection: Selection): Quote {
  const chatOption = plan.chatVolumeEnabled
    ? plan.chatOptions.find((o) => o.key === selection.chat) ?? null
    : null;
  const voiceOption = plan.voiceVolumeEnabled
    ? plan.voiceOptions.find((o) => o.key === selection.voice) ?? null
    : null;

  const chatCredits = plan.creditSplit.chat + (chatOption?.additionalCredits ?? 0);
  const voiceCredits = plan.creditSplit.voice + (voiceOption?.additionalCredits ?? 0);

  const currency = plan.price?.currency ?? "USD";
  const monthlyMinor =
    toMinor(plan.price?.amount ?? "0") +
    toMinor(chatOption?.additionalPrice.amount ?? "0") +
    toMinor(voiceOption?.additionalPrice.amount ?? "0");

  // The same sum in the charged currency, so the "estimated conversion" note
  // can quote the real total rather than the plan's base price.
  const monthlyBaseMinor =
    toMinor(plan.price?.base.amount ?? "0") +
    toMinor(chatOption?.additionalPrice.base.amount ?? "0") +
    toMinor(voiceOption?.additionalPrice.base.amount ?? "0");

  const r = plan.estimate.ratios;
  const days = r.businessDaysPerMonth > 0 ? r.businessDaysPerMonth : 1;

  // A selected option SELLS a volume - "50 conversations per business day" - so
  // that volume is the estimate. Dividing credits by the global ratio instead is
  // what made the summary contradict the selector the visitor had just moved.
  // Only a channel with no selection falls back to the ratio.
  const chatsMonthly = chatOption
    ? monthlyOf(chatOption, days)
    : r.chatCreditsPerEstimatedConversation > 0
      ? chatCredits / r.chatCreditsPerEstimatedConversation
      : 0;
  const callsMonthly = voiceOption
    ? monthlyOf(voiceOption, days)
    : r.voiceCreditsPerEstimatedCall > 0
      ? voiceCredits / r.voiceCreditsPerEstimatedCall
      : 0;
  const chatsDaily = chatOption && chatOption.dailyVolume > 0 ? chatOption.dailyVolume : chatsMonthly / days;
  const callsDaily = voiceOption && voiceOption.dailyVolume > 0 ? voiceOption.dailyVolume : callsMonthly / days;
  const total = chatsMonthly + callsMonthly;

  // Each channel carries the share of the price proportional to its estimated
  // volume, so a plan with chats and calls does not claim both cost the total.
  const perChat = chatsMonthly > 0 ? Math.round((monthlyMinor * (chatsMonthly / total)) / chatsMonthly) : null;
  const perCall = callsMonthly > 0 ? Math.round((monthlyMinor * (callsMonthly / total)) / callsMonthly) : null;

  return {
    chatCredits,
    voiceCredits,
    includedCredits: chatCredits + voiceCredits,
    baseCredits: plan.includedCredits,
    addedCredits: (chatOption?.additionalCredits ?? 0) + (voiceOption?.additionalCredits ?? 0),
    monthlyMinor,
    currency,
    monthlyBaseMinor,
    baseCurrency: plan.price?.base.currency ?? currency,
    isEstimatedConversion: plan.price?.isEstimatedConversion ?? false,
    chargedCurrency: plan.price?.chargedCurrency ?? currency,
    chatOption,
    voiceOption,
    estimatedChatsMonthly: Math.round(chatsMonthly),
    estimatedChatsDaily: Math.round(chatsDaily * 10) / 10,
    estimatedCallsMonthly: Math.round(callsMonthly),
    estimatedCallsDaily: Math.round(callsDaily * 10) / 10,
    chatBasis: chatOption ? "DECLARED_VOLUME" : "CREDIT_RATIO",
    voiceBasis: voiceOption ? "DECLARED_VOLUME" : "CREDIT_RATIO",
    pricePerChatMinor: perChat,
    pricePerCallMinor: perCall,
    pricePerInteractionMinor: total > 0 ? Math.round(monthlyMinor / total) : null,
  };
}

export { toMinor };
