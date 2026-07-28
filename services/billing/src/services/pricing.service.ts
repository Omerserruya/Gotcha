/**
 * Customer-facing pricing catalog composition.
 *
 * ONE place builds the payload behind the pricing page, the Adjust Plan
 * configurator and the Billing summary, so those three surfaces can never
 * disagree about what a plan costs or how much capacity it estimates.
 *
 * What crosses this boundary: plans, credits, prices, estimated conversation
 * volumes. What never does: tokens, provider costs, margin, unit-cost basis, or
 * any actual-usage statistic. That separation is asserted by a test.
 */
import {
  prisma,
  resolveEstimation,
  estimatePlanCapacity,
  estimatePricePerInteraction,
  snapshotEstimation,
  ratiosFromSnapshot,
  toDisplayPrice,
  money,
  toMinor,
  addMoney,
  toDecimalString,
  isUnsellable,
  getFeatureDef,
  type EstimationRatios,
  type BillingMoney as Money,
  type DisplayPrice,
} from "@chatcenter/shared";

export interface VolumeOptionView {
  key: string;
  channel: "CHAT" | "VOICE";
  dailyVolume: number;
  monthlyVolume: number;
  additionalCredits: number;
  additionalPrice: DisplayPrice;
  isDefault: boolean;
  /** Total recurring credits for this channel when this option is selected. */
  totalChannelCredits: number;
}

export interface PlanFeatureView {
  key: string;
  nameEn: string;
  nameHe: string;
  included: boolean;
  category: string;
}

export interface PlanView {
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
  features: PlanFeatureView[];
  limits: Record<string, number>;
  chatOptions: VolumeOptionView[];
  voiceOptions: VolumeOptionView[];
  /** Capacity + per-conversation price at the plan's DEFAULT selection. */
  estimate: QuoteEstimate;
}

export interface QuoteEstimate {
  chat: { credits: number; monthly: number; daily: number };
  voice: { credits: number; monthly: number; daily: number };
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

function num(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  const n = typeof v === "object" && "toNumber" in (v as any) ? (v as any).toNumber() : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function entitlementValue(e: { valueType: string; value: any }): unknown {
  return e.value;
}

/**
 * The chat/voice split of a plan's BASE allowance.
 *
 * The split says how the allowance is PRESENTED per channel. The size of the
 * allowance is `includedAiUnits` - the one number the plan editor asks for - and
 * this function guarantees the split always adds up to it.
 *
 * That guarantee is not cosmetic. `quoteFor()` sells and grants chat + voice,
 * so a split left over from an earlier version used to override the included
 * credits a sysadmin had just set: a plan edited to 10,000 credits still quoted
 * and granted the seeded 2,000. Where the two disagree the plan's own total
 * wins, and the voice share is kept as far as it fits.
 */
export function creditSplitFor(plan: any): { chat: number; voice: number } {
  const total = Math.max(0, Number(plan.includedAiUnits ?? 0) || 0);
  const cfg = plan.entitlements?.find((e: any) => e.entitlementKey === "config:credit_split");
  const raw = cfg ? (entitlementValue(cfg) as any) : null;
  if (raw && typeof raw === "object" && Number.isFinite(Number(raw.chat))) {
    const chat = Math.max(0, Number(raw.chat) || 0);
    const voice = Math.max(0, Number(raw.voice) || 0);
    if (chat + voice === total) return { chat, voice };
    // A sales-only plan carries no allowance of its own; there is nothing to
    // reconcile against, so the configured split stands.
    if (total === 0) return { chat, voice };
    const keptVoice = Math.min(voice, total);
    return { chat: total - keptVoice, voice: keptVoice };
  }
  // No explicit split configured: treat the whole allowance as chat, which is
  // the only claim the data actually supports.
  return { chat: total, voice: 0 };
}

/**
 * Build the capacity + price-per-conversation estimate for a concrete
 * selection. Pure composition over the estimation engine; never reads usage.
 */
export function buildEstimate(input: {
  chatCredits: number;
  voiceCredits: number;
  monthlyPrice: Money;
  ratios: EstimationRatios;
}): QuoteEstimate {
  const cap = estimatePlanCapacity({
    chatCredits: input.chatCredits,
    voiceCredits: input.voiceCredits,
    ratios: input.ratios,
  });
  const price = estimatePricePerInteraction(input.monthlyPrice, cap);
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    chat: { credits: input.chatCredits, monthly: Math.round(cap.chat.estimatedMonthly), daily: round(cap.chat.estimatedDaily) },
    voice: { credits: input.voiceCredits, monthly: Math.round(cap.voice.estimatedMonthly), daily: round(cap.voice.estimatedDaily) },
    totalInteractions: Math.round(cap.estimatedTotalInteractions),
    pricePerChat: price.pricePerChat ? toDecimalString(price.pricePerChat) : null,
    pricePerCall: price.pricePerCall ? toDecimalString(price.pricePerCall) : null,
    pricePerInteraction: price.pricePerInteraction ? toDecimalString(price.pricePerInteraction) : null,
    currency: input.monthlyPrice.currency,
    ratios: {
      chatCreditsPerEstimatedConversation: input.ratios.chatCreditsPerEstimatedConversation,
      voiceCreditsPerEstimatedCall: input.ratios.voiceCreditsPerEstimatedCall,
      businessDaysPerMonth: input.ratios.businessDaysPerMonth,
    },
  };
}

/**
 * The public catalog: every ACTIVE PUBLIC plan, plus any CUSTOM plan belonging
 * to this organization. A DRAFT, RETIRED or ARCHIVED plan is never listed.
 */
export async function listCatalogPlans(opts: {
  tenantId?: string | null;
  displayCurrency?: string;
} = {}): Promise<PlanView[]> {
  const display = opts.displayCurrency ?? "USD";
  const now = new Date();

  const plans = await prisma.plan.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { kind: "PUBLIC", tenantId: null },
        ...(opts.tenantId ? [{ kind: "CUSTOM" as const, tenantId: opts.tenantId }] : []),
      ],
      AND: [
        { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
        { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
      ],
    },
    include: { entitlements: true, volumeOptions: { orderBy: { sortOrder: "asc" } } },
    orderBy: { sortOrder: "asc" },
  });

  return Promise.all(plans.map((p) => toPlanView(p, display, now)));
}

async function toPlanView(plan: any, display: string, now: Date): Promise<PlanView> {
  const ratios = await resolveEstimation({ planId: plan.id }, now);
  const split = creditSplitFor(plan);
  const currency = plan.currency ?? "USD";
  const basePrice = plan.basePrice != null ? money(plan.basePrice, currency) : null;

  const chatOptions = await Promise.all(
    plan.volumeOptions
      .filter((o: any) => o.channel === "CHAT" && o.enabled && withinWindow(o, now))
      .map((o: any) => toVolumeView(o, split.chat, display)),
  );
  const voiceOptions = await Promise.all(
    plan.volumeOptions
      .filter((o: any) => o.channel === "VOICE" && o.enabled && withinWindow(o, now))
      .map((o: any) => toVolumeView(o, split.voice, display)),
  );

  // Features: report the plan's explicit entitlement, falling back to the
  // catalog default. Unbuilt capabilities are dropped entirely - they are not
  // sellable and must not appear on a pricing page.
  const features: PlanFeatureView[] = [];
  for (const e of plan.entitlements) {
    if (e.valueType !== "BOOLEAN") continue;
    const def = getFeatureDef(e.entitlementKey);
    if (!def || !def.customerVisible || isUnsellable(e.entitlementKey)) continue;
    features.push({
      key: def.key,
      nameEn: def.nameEn,
      nameHe: def.nameHe,
      included: Boolean((e.value as any)?.bool),
      category: def.category,
    });
  }
  features.sort((a, b) => (getFeatureDef(a.key)?.sortOrder ?? 0) - (getFeatureDef(b.key)?.sortOrder ?? 0));

  const limits: Record<string, number> = {};
  for (const e of plan.entitlements) {
    if (e.valueType === "COUNTER") limits[e.entitlementKey] = num((e.value as any)?.count);
  }

  return {
    key: plan.key,
    version: plan.version,
    name: plan.name,
    nameHe: plan.nameHe,
    description: plan.descriptionEn,
    descriptionHe: plan.descriptionHe,
    kind: plan.kind,
    recommended: plan.recommended,
    sortOrder: plan.sortOrder,
    salesOnly: plan.salesOnly,
    billingInterval: plan.billingInterval,
    basePrice: basePrice ? await toDisplayPrice(basePrice, display, now) : null,
    includedCredits: plan.includedAiUnits,
    creditSplit: split,
    supportLevel: plan.supportLevel,
    chatVolumeEnabled: plan.chatVolumeEnabled,
    voiceVolumeEnabled: plan.voiceVolumeEnabled,
    autoPurchaseEligible: plan.autoPurchaseEligible,
    creditPackagesEligible: plan.creditPackagesEligible,
    features,
    limits,
    chatOptions,
    voiceOptions,
    estimate: buildEstimate({
      chatCredits: split.chat,
      voiceCredits: split.voice,
      monthlyPrice: basePrice ?? money("0.00", currency),
      ratios,
    }),
  };
}

function withinWindow(o: { activeFrom: Date | null; activeTo: Date | null }, now: Date): boolean {
  if (o.activeFrom && o.activeFrom > now) return false;
  if (o.activeTo && o.activeTo <= now) return false;
  return true;
}

async function toVolumeView(o: any, baseChannelCredits: number, display: string): Promise<VolumeOptionView> {
  const currency = o.currency ?? "USD";
  return {
    key: o.key,
    channel: o.channel,
    dailyVolume: o.dailyVolume,
    monthlyVolume: o.monthlyVolume,
    additionalCredits: o.additionalCredits,
    additionalPrice: await toDisplayPrice(money(o.additionalPrice, currency), display),
    isDefault: o.isDefault,
    totalChannelCredits: baseChannelCredits + o.additionalCredits,
  };
}

// ── Quoting a concrete selection ────────────────────────────────────────────

export interface Quote {
  planKey: string;
  planVersion: number;
  chatVolumeOptionKey: string | null;
  voiceVolumeOptionKey: string | null;
  /** Base plan price + every selected option's added price. */
  monthlyPrice: Money;
  monthlyPriceDisplay: DisplayPrice;
  includedCredits: number;
  chatCredits: number;
  voiceCredits: number;
  estimate: QuoteEstimate;
  ratios: EstimationRatios;
  currency: string;
}

/**
 * Price a concrete plan + volume selection SERVER-SIDE.
 *
 * The frontend sends option KEYS, never prices or credit amounts. Every number
 * in the result is recomputed here from the catalog, so a tampered payload
 * cannot buy a plan at a price the customer chose.
 */
export async function quote(input: {
  planKey: string;
  planVersion?: number;
  chatVolumeOptionKey?: string | null;
  voiceVolumeOptionKey?: string | null;
  tenantId?: string | null;
  displayCurrency?: string;
}): Promise<Quote> {
  const now = new Date();
  const plan = await prisma.plan.findFirst({
    where: {
      key: input.planKey,
      ...(input.planVersion ? { version: input.planVersion } : { status: "ACTIVE" }),
    },
    include: { entitlements: true, volumeOptions: true },
    orderBy: { version: "desc" },
  });
  if (!plan) throw new Error(`unknown_plan:${input.planKey}`);
  if (plan.kind === "CUSTOM" && plan.tenantId && plan.tenantId !== input.tenantId) {
    // A custom plan belongs to exactly one organization. Quoting someone else's
    // negotiated terms is a cross-tenant read, so it is refused outright.
    throw new Error("plan_not_available");
  }

  const currency = plan.currency ?? "USD";
  const split = creditSplitFor(plan);
  let price = plan.basePrice != null ? money(plan.basePrice, currency) : money("0.00", currency);
  let chatCredits = split.chat;
  let voiceCredits = split.voice;

  const pick = (key: string | null | undefined, channel: "CHAT" | "VOICE") => {
    if (!key) return null;
    const o = plan.volumeOptions.find((v) => v.key === key && v.channel === channel && v.enabled);
    if (!o) throw new Error(`unknown_volume_option:${key}`);
    return o;
  };

  const chatOpt = plan.chatVolumeEnabled ? pick(input.chatVolumeOptionKey, "CHAT") : null;
  const voiceOpt = plan.voiceVolumeEnabled ? pick(input.voiceVolumeOptionKey, "VOICE") : null;

  if (chatOpt) {
    price = addMoney(price, money(chatOpt.additionalPrice, chatOpt.currency ?? currency));
    chatCredits += chatOpt.additionalCredits;
  }
  if (voiceOpt) {
    price = addMoney(price, money(voiceOpt.additionalPrice, voiceOpt.currency ?? currency));
    voiceCredits += voiceOpt.additionalCredits;
  }

  const ratios = await resolveEstimation(
    { planId: plan.id, volumeOptionId: chatOpt?.id ?? voiceOpt?.id ?? null },
    now,
  );

  return {
    planKey: plan.key,
    planVersion: plan.version,
    chatVolumeOptionKey: chatOpt?.key ?? null,
    voiceVolumeOptionKey: voiceOpt?.key ?? null,
    monthlyPrice: price,
    monthlyPriceDisplay: await toDisplayPrice(price, input.displayCurrency ?? "USD", now),
    includedCredits: chatCredits + voiceCredits,
    chatCredits,
    voiceCredits,
    estimate: buildEstimate({ chatCredits, voiceCredits, monthlyPrice: price, ratios }),
    ratios,
    currency,
  };
}

/** The commercial snapshot to persist on a subscription for this quote. */
export function snapshotFor(q: Quote) {
  return {
    snapshotPrice: toDecimalString(q.monthlyPrice),
    snapshotCurrency: q.monthlyPrice.currency,
    snapshotIncludedCredits: q.includedCredits,
    snapshotEstimation: snapshotEstimation(q.ratios) as any,
    snapshotAt: new Date(),
    chatVolumeOptionKey: q.chatVolumeOptionKey,
    voiceVolumeOptionKey: q.voiceVolumeOptionKey,
  };
}

/**
 * Render an EXISTING subscription's terms from its stored snapshot rather than
 * the live plan, so publishing a new plan version never restates what a current
 * customer sees.
 */
export async function describeSubscription(sub: any, displayCurrency = "USD") {
  const now = new Date();
  const plan = await prisma.plan.findUnique({
    where: { key_version: { key: sub.planKey, version: sub.planVersion } },
    include: { entitlements: true, volumeOptions: true },
  });
  const currency = sub.snapshotCurrency ?? plan?.currency ?? "USD";
  const price =
    sub.snapshotPrice != null ? money(sub.snapshotPrice, currency) : money(plan?.basePrice ?? "0.00", currency);
  const liveRatios = await resolveEstimation({ planId: plan?.id ?? null }, now);
  const ratios = ratiosFromSnapshot(sub.snapshotEstimation, liveRatios);

  const includedCredits = sub.snapshotIncludedCredits ?? plan?.includedAiUnits ?? 0;
  const split = plan ? creditSplitFor(plan) : { chat: includedCredits, voice: 0 };
  let chatCredits = split.chat;
  let voiceCredits = split.voice;
  const chatOpt = plan?.volumeOptions.find((o) => o.key === sub.chatVolumeOptionKey);
  const voiceOpt = plan?.volumeOptions.find((o) => o.key === sub.voiceVolumeOptionKey);
  if (chatOpt) chatCredits += chatOpt.additionalCredits;
  if (voiceOpt) voiceCredits += voiceOpt.additionalCredits;

  return {
    planKey: sub.planKey,
    planVersion: sub.planVersion,
    planName: plan?.name ?? sub.planKey,
    planNameHe: plan?.nameHe ?? null,
    planKind: plan?.kind ?? "LEGACY",
    monthlyPrice: await toDisplayPrice(price, displayCurrency, now),
    includedCredits,
    chatVolumeOptionKey: sub.chatVolumeOptionKey,
    voiceVolumeOptionKey: sub.voiceVolumeOptionKey,
    chatDailyVolume: chatOpt?.dailyVolume ?? null,
    voiceDailyVolume: voiceOpt?.dailyVolume ?? null,
    estimate: buildEstimate({ chatCredits, voiceCredits, monthlyPrice: price, ratios }),
    /** True when the terms come from a stored snapshot rather than the live plan. */
    fromSnapshot: sub.snapshotPrice != null,
  };
}

export { toMinor };
