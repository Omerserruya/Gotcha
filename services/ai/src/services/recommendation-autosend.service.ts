/**
 * Automatic product recommendations: the AI path, not the picker path.
 *
 * ─── What was broken ─────────────────────────────────────────
 *
 * A Shopify product search produced a `ProductSearchEnvelope`, and the
 * envelope was flattened straight into the reply text by
 * `renderGroundedProductReply` - a numbered list with the exact prices and
 * the raw storefront URLs, on EVERY channel, including the one channel
 * that has a real product carousel. The carousel only ever appeared if the
 * model chose to call `send_product_card`, and a model that has just been
 * handed a tidy list of products has no reason to. So it asked "would you
 * like me to send a product card?" - offering, as a favour, the thing the
 * channel was built to do.
 *
 * Two defects, and both had to be fixed:
 *
 *   1. The flattening was unconditional. No channel capability was ever
 *      consulted.
 *   2. The carousel was discretionary. Nothing promoted a valid envelope
 *      into a structured payload.
 *
 * ─── The rule now ────────────────────────────────────────────
 *
 * On a channel that can render cards, a valid envelope with at least one
 * product ALWAYS becomes a structured payload, and the reply text is
 * reduced to a short introduction. The text list is what happens when
 * rendering or delivery genuinely fails, and when it happens it is logged
 * and marked - not the default that quietly wins.
 *
 * The promotion works by calling the SAME staging function the model
 * should have called. That is deliberate: it re-resolves every product
 * against Shopify, drops unpublished ones, and enforces the channel's
 * store binding, so the automatic path inherits every guarantee the tool
 * path already had rather than growing a second, weaker copy.
 */

import { captureError } from "@chatcenter/shared";
import type { ProductCandidate, ProductSearchEnvelope } from "./product-search.service";

export type RecoLocale = "he" | "en";

// ─── Budget ──────────────────────────────────────────────────

export interface BudgetConstraint {
  target: number;
  currency: string;
}

export interface BudgetVerdict {
  /** Candidates at or under the budget. */
  within: ProductCandidate[];
  /** Candidates over it. */
  above: ProductCandidate[];
  /**
   * Whether the over-budget ones were dropped. True when there were
   * enough within-budget products to answer without them.
   */
  excludedAbove: boolean;
  /** What actually goes out, in order. */
  selected: ProductCandidate[];
  /** True when a selected product is over budget and must be labelled. */
  hasAboveBudgetAlternative: boolean;
  /** No comparison was possible (no budget, or a currency mismatch). */
  notApplicable: boolean;
}

/**
 * Enough within-budget products to answer the question without reaching
 * for one the shopper cannot afford. Two, not one: a single option is a
 * verdict, and a shopper who named a budget is choosing.
 */
const ENOUGH_WITHIN_BUDGET = 2;

/** The same threshold, for the same reason, on stock. */
const ENOUGH_IN_STOCK = 2;

/**
 * Drop what nobody can buy.
 *
 * Live on Dev: a $10 Gift Card with `available: false` was carried into a
 * snowboard shortlist and rendered as a card with an Add to Cart button.
 * Availability is filtered BEFORE budget because an out-of-stock product
 * is useless at any price, so it should never occupy one of the three
 * slots a within-budget product could have had.
 *
 * Not unconditional: when almost nothing is in stock, showing the real
 * catalogue with its stock badges beats showing an empty carousel.
 */
export function filterByAvailability(candidates: ProductCandidate[]): ProductCandidate[] {
  const inStock = candidates.filter((c) => c.inventoryState !== "out_of_stock");
  return inStock.length >= ENOUGH_IN_STOCK ? inStock : candidates;
}

/**
 * Apply the budget to the PROVIDER's numbers.
 *
 * Not to the model's prose, and not to `matchQuality` - which is a display
 * hint computed with a 5% tolerance and was never a filter. A USD 729.95
 * board reached a shopper as a match for a 700 budget because nothing in
 * the pipeline ever compared those two numbers and acted on the result.
 *
 * A currency mismatch means no comparison is possible at all: the store
 * prices in USD, the shopper said "700 שקל", and we have no rate. Nothing
 * is excluded and nothing is claimed.
 */
export function applyBudgetPolicy(
  envelope: ProductSearchEnvelope,
  budget: BudgetConstraint | null | undefined,
  maxProducts: number,
): BudgetVerdict {
  const candidates = filterByAvailability(envelope.candidates.slice());

  if (!budget || envelope.budgetCurrencyMismatch) {
    return {
      within: candidates,
      above: [],
      excludedAbove: false,
      selected: candidates.slice(0, maxProducts),
      hasAboveBudgetAlternative: false,
      notApplicable: true,
    };
  }

  const within: ProductCandidate[] = [];
  const above: ProductCandidate[] = [];
  for (const c of candidates) {
    const price = numericPrice(c);
    // An unpriced product cannot be shown to breach a budget, so it is not
    // excluded by one. It travels with the within-budget group and its
    // missing price is visible on the card itself.
    if (price == null || price <= budget.target) within.push(c);
    else above.push(c);
  }

  const excludedAbove = within.length >= ENOUGH_WITHIN_BUDGET;
  const selected = excludedAbove
    ? within.slice(0, maxProducts)
    : [...within, ...above].slice(0, maxProducts);

  return {
    within,
    above,
    excludedAbove,
    selected,
    hasAboveBudgetAlternative: selected.some((c) => above.includes(c)),
    notApplicable: false,
  };
}

/** The provider's price as a number, or null when there isn't one. */
export function numericPrice(candidate: ProductCandidate): number | null {
  if (candidate.price === undefined || candidate.price === null) return null;
  const n = Number(candidate.price);
  return Number.isFinite(n) ? n : null;
}

/** Is this candidate over the budget, by the provider's own number? */
export function isAboveBudget(
  candidate: ProductCandidate,
  budget: BudgetConstraint | null | undefined,
): boolean {
  if (!budget) return false;
  const price = numericPrice(candidate);
  return price != null && price > budget.target;
}

const ABOVE_BUDGET_NOTE: Record<RecoLocale, string> = {
  he: "מעל התקציב שציינת",
  en: "above the budget you gave",
};

/**
 * The per-card "why this one" line, with the over-budget fact attached
 * when it applies. The card carries the caveat, so a shopper who only
 * looks at the cards still sees it.
 */
export function reasonForCandidate(
  candidate: ProductCandidate,
  budget: BudgetConstraint | null | undefined,
  locale: RecoLocale,
  existingReason?: string | null,
): string | null {
  const base = (existingReason ?? "").trim();
  if (!isAboveBudget(candidate, budget)) return base || null;
  const note = ABOVE_BUDGET_NOTE[locale];
  if (!base) return note;
  return base.includes(note) ? base : `${base} (${note})`;
}

// ─── Introduction ────────────────────────────────────────────

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const MONEY_RE =
  /(?:[$₪€£¥]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:USD|ILS|EUR|GBP|NIS)\b|\b(?:USD|ILS|EUR|GBP|NIS)\s?\d[\d.,]*)/gi;

/**
 * Lines that ARE the numbered list. The renderer used to append these;
 * a model that has seen one in its own context will reproduce it.
 */
const NUMBERED_LINE_RE = /^\s*(?:\d+[.)]|[-•*])\s+\S/;

/**
 * "Would you like me to send a product card?"
 *
 * The single most wrong sentence this feature can produce: it offers, as
 * a favour that needs permission, the thing the channel exists to do. It
 * is removed rather than left to the prompt, because the prompt asked for
 * a carousel and got this instead.
 *
 * Narrow on purpose - a send/show verb AND a card/product-display object
 * in the same sentence. "רוצה שאבדוק מידה?" is a real question and stays.
 */
const PERMISSION_QUESTION_RE = new RegExp(
  [
    // Hebrew: to send / to show / to display + card / cards / products / links / images
    "(?:רוצ(?:ה|ים)|תרצ(?:ה|י)|האם|אפשר|שאשלח|שאציג|שאראה|לשלוח|להציג|להראות)[^.!?\\n]{0,60}",
    "(?:כרטיס|כרטיסים|כרטיסיות|קישור|קישורים|תמונות|המוצרים|כרטיסי מוצר)[^.!?\\n]{0,40}\\?",
  ].join(""),
  "gi",
);
const PERMISSION_QUESTION_EN_RE =
  /(?:would you like|do you want|shall i|should i|want me to|can i)[^.!?\n]{0,60}(?:send|show|display|share)[^.!?\n]{0,60}(?:card|cards|product card|products|links?|images?)[^.!?\n]{0,40}\?/gi;

export interface IntroductionOptions {
  locale: RecoLocale;
  /** Titles to substitute for PRODUCT_n references. */
  candidates: ProductCandidate[];
  /** How many selected products are over budget. 0 = say nothing. */
  aboveBudgetCount?: number;
  /** How many are going out in total, so "all of them" can be said plainly. */
  totalCount?: number;
  maxChars?: number;
}

const DEFAULT_INTRO: Record<RecoLocale, string> = {
  he: "מצאתי כמה אפשרויות שיכולות להתאים:",
  en: "Here are a few options that could suit you:",
};

/**
 * Count-aware, because the singular version was itself a false claim.
 *
 * Live on Dev: two of three products were over budget and the line said
 * "One of them is a little above the budget you gave". A sentence written
 * to be honest about the budget cannot be sloppy about how many.
 */
function aboveBudgetIntro(count: number, locale: RecoLocale, total: number): string {
  // When every option is over budget, "3 of them are above" is a strange
  // way to say "we have nothing in your range". Say the plain thing.
  const all = total > 0 && count >= total;
  if (locale === "he") {
    if (all) return "אף אחת מהן לא נכנסת לתקציב שציינת, זה מה שיש כרגע בקטגוריה.";
    return count === 1
      ? "אחת מהן מעט מעל התקציב שציינת, סימנתי אותה."
      : `${count} מהן מעל התקציב שציינת, סימנתי אותן.`;
  }
  if (all) return "None of these come in under the budget you gave, they are the closest the catalogue has.";
  return count === 1
    ? "One of them is a little above the budget you gave, and it is marked."
    : `${count} of them are above the budget you gave, and they are marked.`;
}

/**
 * Drop a sentence that ENUMERATES the products.
 *
 * Live on Dev: the reply named four boards inline - "(The Inventory Not
 * Tracked Snowboard The Minimal Snowboard The Hidden Snowboard The
 * Compare at Price Snowboard are marked...)" - above a carousel of
 * three. That is the numbered list again wearing a sentence, it
 * duplicates the cards, and it named one product that was not shown.
 *
 * A SINGLE title is left alone: "The Hidden is the closest to your
 * budget" is exactly the sentence a person would say. Two or more in one
 * sentence is a list.
 */
export function stripProductEnumeration(text: string, titles: string[]): string {
  const named = titles.map((t) => t.trim()).filter((t) => t.length >= 4);
  if (named.length < 2) return text;

  const sentences = text.match(/[^.!?\n]+[.!?]?/g) ?? [text];
  const kept = sentences.filter((sentence) => {
    const hits = named.filter((t) => sentence.toLowerCase().includes(t.toLowerCase())).length;
    return hits < 2;
  });
  const out = kept.map((x) => x.trim()).filter(Boolean).join(" ").trim();
  // Strip a parenthesis left dangling by a removed clause.
  return out.replace(/\(\s*\)/g, "").replace(/\s+([,.])/g, "$1").trim();
}

/** Has the model already made a budget claim in its own words? */
function mentionsBudget(text: string): boolean {
  return /budget|תקציב|above your limit|over your limit|מעל המחיר|above what you/i.test(text);
}

/**
 * Reduce the model's reply to a short lead-in for the cards.
 *
 * Everything the cards already carry is removed: URLs, prices, the
 * numbered list. So is the permission question. What survives is the one
 * or two sentences of reasoning a person would actually say out loud
 * before showing someone three products.
 *
 * Falls back to a deterministic line rather than sending nothing - an
 * unannounced carousel reads as an advertisement.
 */
export function extractIntroduction(
  modelText: string | null | undefined,
  opts: IntroductionOptions,
): string {
  const maxChars = opts.maxChars ?? 240;
  let text = String(modelText ?? "");

  // PRODUCT_n → the real title, so the prose reads naturally.
  text = text.replace(/PRODUCT_(\d+)/gi, (_, d) => {
    const n = Number(d);
    return n >= 1 && n <= opts.candidates.length ? opts.candidates[n - 1].title : "";
  });

  text = text
    .replace(PERMISSION_QUESTION_RE, " ")
    .replace(PERMISSION_QUESTION_EN_RE, " ")
    .replace(URL_RE, " ")
    .replace(MONEY_RE, " ");

  // Drop any line that is a list entry. The cards are the list.
  let kept = text
    .split(/\r?\n/)
    .filter((line) => !NUMBERED_LINE_RE.test(line))
    .join(" ");

  // ...and the same list written as a sentence.
  kept = stripProductEnumeration(kept, opts.candidates.map((c) => c.title));

  let intro = kept.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();

  // First two sentences at most. A lead-in is not a paragraph.
  const sentences = intro.match(/[^.!?\n]+[.!?]?/g) ?? [];
  if (sentences.length > 2) {
    // The captures keep their own leading space, so joining with another
    // one doubles it. A customer-facing line with a double space in it
    // looks like a template that did not finish rendering.
    intro = sentences.slice(0, 2).map((s) => s.trim()).join(" ").trim();
  }
  if (intro.length > maxChars) intro = `${intro.slice(0, maxChars - 1).trimEnd()}…`;

  // Anything left that is too short to be a sentence is noise from the
  // stripping above, not an introduction.
  if (intro.replace(/[^\p{L}]/gu, "").length < 8) intro = DEFAULT_INTRO[opts.locale];

  if (opts.aboveBudgetCount && opts.aboveBudgetCount > 0) {
    // Only if the model has not already said it. The prompt now asks for
    // budget honesty, so the model often does - and appending ours on top
    // produced two claims in one message that disagreed on the number.
    if (!mentionsBudget(intro)) {
      const note = aboveBudgetIntro(opts.aboveBudgetCount, opts.locale, opts.totalCount ?? 0);
      intro = `${intro} ${note}`.trim();
    }
  }
  return intro;
}

// ─── The decision ────────────────────────────────────────────

export interface AutoRecommendationPlan {
  /** Whether a structured payload should be produced at all. */
  shouldSendStructured: boolean;
  /** Candidates to stage, after budget policy and channel limits. */
  selected: ProductCandidate[];
  /** The reply text that accompanies the cards. */
  introduction: string;
  budget: BudgetVerdict;
  /** Why structured was skipped, when it was. */
  skipReason?: "no_candidates" | "channel_cannot_render" | "already_staged" | "envelope_not_ok";
}

export interface PlanAutoRecommendationInput {
  envelope: ProductSearchEnvelope;
  /** Does this channel render cards or a carousel? */
  channelSupportsCards: boolean;
  /** The model already called send_product_card this turn. */
  alreadyStaged: boolean;
  modelText: string | null | undefined;
  locale: RecoLocale;
  budget?: BudgetConstraint | null;
  maxProducts: number;
}

/**
 * Pure. Decides what goes out; sends nothing.
 */
export function planAutoRecommendation(
  input: PlanAutoRecommendationInput,
): AutoRecommendationPlan {
  const { envelope } = input;
  const budget = applyBudgetPolicy(envelope, input.budget, input.maxProducts);

  const base = { selected: budget.selected, budget };

  if (envelope.status !== "ok" || envelope.candidates.length === 0) {
    return { ...base, shouldSendStructured: false, introduction: "", skipReason: "envelope_not_ok" };
  }
  if (!input.channelSupportsCards) {
    return { ...base, shouldSendStructured: false, introduction: "", skipReason: "channel_cannot_render" };
  }
  if (input.alreadyStaged) {
    // The model did call the tool. Nothing more to stage - but the text
    // must STILL be reduced, or the customer gets the products twice.
    return {
      ...base,
      shouldSendStructured: false,
      skipReason: "already_staged",
      introduction: extractIntroduction(input.modelText, {
        locale: input.locale,
        candidates: envelope.candidates,
        aboveBudgetCount: countAboveBudget(budget, input.budget),
        totalCount: budget.selected.length,
      }),
    };
  }
  if (!budget.selected.length) {
    return { ...base, shouldSendStructured: false, introduction: "", skipReason: "no_candidates" };
  }

  return {
    ...base,
    shouldSendStructured: true,
    introduction: extractIntroduction(input.modelText, {
      locale: input.locale,
      candidates: envelope.candidates,
      aboveBudgetCount: countAboveBudget(budget, input.budget),
      totalCount: budget.selected.length,
    }),
  };
}

/** How many of the products actually going out are over budget. */
export function countAboveBudget(
  verdict: BudgetVerdict,
  budget: BudgetConstraint | null | undefined,
): number {
  if (verdict.notApplicable || !budget) return 0;
  return verdict.selected.filter((c) => isAboveBudget(c, budget)).length;
}

/**
 * A carousel that was supposed to go out and did not.
 *
 * Reported rather than swallowed: the whole point of the invariant is
 * that a text list is now an INCIDENT, not a default. Sentry gets it so
 * the rate is visible without log-diving.
 */
export function reportCarouselFallback(args: {
  conversationId: string;
  tenantId: string;
  reason: string;
  productCount: number;
}): void {
  const message =
    `[ai-bot] shopify carousel fallback conv=${args.conversationId} ` +
    `reason=${args.reason} products=${args.productCount} (sent clean text instead)`;
  console.warn(message);
  try {
    captureError(new Error(`shopify_carousel_fallback: ${args.reason}`), {
      feature: "shopify_recommendations",
      reason: args.reason,
      conversationId: args.conversationId,
      tenantId: args.tenantId,
      productCount: String(args.productCount),
    });
  } catch {
    /* observability must never cost a customer their reply */
  }
}
