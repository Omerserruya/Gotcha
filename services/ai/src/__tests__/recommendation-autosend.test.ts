/**
 * The AUTOMATIC recommendation path.
 *
 * The regression this file exists for: a Shopify search returned three
 * products, the envelope was flattened into a numbered text list with raw
 * storefront URLs, and the assistant then asked whether the customer
 * would like a product card - offering, as a favour, the thing the
 * channel was built to do. The carousel only ever appeared when the model
 * chose to call `send_product_card`, which it had no reason to.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  planAutoRecommendation,
  applyBudgetPolicy,
  extractIntroduction,
  reasonForCandidate,
  isAboveBudget,
  numericPrice,
  filterByAvailability,
  countAboveBudget,
  stripProductEnumeration,
  decideDelivery,
  reportCarouselFallback,
} from "../services/recommendation-autosend.service";
import { normalizeShopifyProducts } from "../services/product-search.service";
import { capabilitiesFor } from "@chatcenter/shared";

const SHOP = "demo-store.myshopify.com";

function raw(id: number, title: string, price: string, available = true) {
  return {
    id,
    title,
    handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    status: "active",
    image: { src: `https://cdn.shopify.com/s/files/1/${id}.jpg` },
    variants: [{ id: 9000 + id, sku: `SKU-${id}`, price, available }],
  };
}

function envelope(products: any[], opts: { budget?: { target: number; currency: string }; shopCurrency?: string } = {}) {
  return normalizeShopifyProducts(products, {
    shopDomain: SHOP,
    shopCurrency: opts.shopCurrency ?? "USD",
    budget: opts.budget,
    requestedFilters: opts.budget ? ["query", "budget"] : ["query"],
  });
}

const THREE = () =>
  envelope([
    raw(1, "Alpha Board", "600.00"),
    raw(2, "Beta Board", "649.00"),
    raw(3, "Gamma Board", "680.00"),
  ]);

function plan(overrides: Record<string, any> = {}) {
  return planAutoRecommendation({
    envelope: THREE(),
    channelSupportsCards: true,
    alreadyStaged: false,
    modelText: "מצאתי שלוש אפשרויות שיכולות להתאים.",
    locale: "he",
    budget: null,
    maxProducts: 5,
    ...overrides,
  } as any);
}

// ─── 1. Automatic search → intro + carousel, no list, no URLs ─

describe("1. an automatic Shopify search produces cards, not a list", () => {
  it("decides to send a structured payload", () => {
    const p = plan();
    expect(p.shouldSendStructured).toBe(true);
    expect(p.selected).toHaveLength(3);
  });

  it("keeps ONE short introduction", () => {
    const p = plan();
    expect(p.introduction).toBe("מצאתי שלוש אפשרויות שיכולות להתאים.");
  });

  it("strips a numbered product list the model wrote", () => {
    const p = plan({
      modelText:
        "מצאתי שלוש אפשרויות:\n1. Alpha Board 600.00 USD\nhttps://demo-store.myshopify.com/products/alpha-board\n2. Beta Board 649.00 USD",
    });
    expect(p.introduction).not.toMatch(/^\s*\d+[.)]/m);
    expect(p.introduction).not.toContain("Alpha Board 600.00");
  });

  it("strips raw storefront URLs from the assistant text", () => {
    const p = plan({
      modelText: `הנה מה שמצאתי https://${SHOP}/products/alpha-board ותודה`,
    });
    expect(p.introduction).not.toContain("https://");
    expect(p.introduction).not.toContain(SHOP);
  });

  it("strips prices - the cards carry those", () => {
    const p = plan({ modelText: "מצאתי אפשרות טובה במחיר 600.00 USD בשבילך." });
    expect(p.introduction).not.toMatch(/600\.00\s*USD/);
  });

  it("resolves PRODUCT_n references to real titles", () => {
    const p = plan({ modelText: "PRODUCT_1 הכי מתאים למה שתיארת." });
    expect(p.introduction).toContain("Alpha Board");
    expect(p.introduction).not.toContain("PRODUCT_1");
  });
});

// ─── 2. It must not ask permission ───────────────────────────

describe("2. it never asks permission to send the cards", () => {
  it.each([
    "מצאתי שלוש אפשרויות. רוצה שאשלח לך כרטיסי מוצר?",
    "יש לי כמה רעיונות. אפשר להציג לך את המוצרים?",
    "מצאתי התאמות. האם לשלוח לך קישורים?",
    "I found three options. Would you like me to send a product card?",
    "I have some matches. Shall I show you the products?",
    "Found a few. Do you want me to share the links?",
  ])("removes: %s", (modelText) => {
    const intro = plan({ modelText }).introduction;
    expect(intro).not.toMatch(/\?\s*$/);
    expect(intro.toLowerCase()).not.toMatch(/product card|כרטיס/);
  });

  it("keeps a legitimate question that is not about sending cards", () => {
    const intro = plan({ modelText: "מצאתי שלוש אפשרויות. באיזו מידה להתמקד?" }).introduction;
    expect(intro).toContain("באיזו מידה");
  });

  it("falls back to a real lead-in when stripping leaves nothing", () => {
    const intro = plan({ modelText: "רוצה שאשלח כרטיסי מוצר?" }).introduction;
    expect(intro).toBe("מצאתי כמה אפשרויות שיכולות להתאים:");
  });
});

// ─── 5. Budget ───────────────────────────────────────────────

describe("5. budget is enforced on the provider's numbers", () => {
  const BUDGET = { target: 700, currency: "USD" };
  const MIXED = () =>
    envelope(
      [
        raw(1, "Alpha Board", "600.00"),
        raw(2, "Beta Board", "699.95"),
        raw(3, "Gamma Board", "729.95"),
      ],
      { budget: BUDGET },
    );

  it("excludes the over-budget product when two within-budget ones exist", () => {
    // The exact live failure: USD 729.95 offered against a 700 budget.
    const verdict = applyBudgetPolicy(MIXED(), BUDGET, 5);
    expect(verdict.within.map((c) => c.title)).toEqual(["Alpha Board", "Beta Board"]);
    expect(verdict.above.map((c) => c.title)).toEqual(["Gamma Board"]);
    expect(verdict.excludedAbove).toBe(true);
    expect(verdict.selected.map((c) => c.title)).toEqual(["Alpha Board", "Beta Board"]);
    expect(verdict.hasAboveBudgetAlternative).toBe(false);
  });

  it("699.95 is within a 700 budget, 729.95 is not", () => {
    const env = MIXED();
    expect(isAboveBudget(env.candidates[1], BUDGET)).toBe(false);
    expect(isAboveBudget(env.candidates[2], BUDGET)).toBe(true);
  });

  it("keeps an over-budget alternative when there are not enough matches, and MARKS it", () => {
    const thin = envelope([raw(1, "Alpha Board", "600.00"), raw(3, "Gamma Board", "729.95")], {
      budget: BUDGET,
    });
    const verdict = applyBudgetPolicy(thin, BUDGET, 5);
    expect(verdict.excludedAbove).toBe(false);
    expect(verdict.selected).toHaveLength(2);
    expect(verdict.hasAboveBudgetAlternative).toBe(true);

    const reason = reasonForCandidate(verdict.selected[1], BUDGET, "he");
    expect(reason).toContain("מעל התקציב שציינת");
  });

  it("says so in the introduction when an over-budget option is included", () => {
    const thin = envelope([raw(1, "Alpha", "600.00"), raw(3, "Gamma", "729.95")], { budget: BUDGET });
    const p = planAutoRecommendation({
      envelope: thin,
      channelSupportsCards: true,
      alreadyStaged: false,
      modelText: "מצאתי שתי אפשרויות.",
      locale: "he",
      budget: BUDGET,
      maxProducts: 5,
    });
    expect(p.introduction).toContain("מעל התקציב שציינת");
  });

  it("never claims a match it cannot substantiate across currencies", () => {
    // Budget in ILS against a USD catalog: no comparison is possible, so
    // nothing is excluded and nothing is marked.
    const mismatched = envelope([raw(1, "Alpha", "600.00"), raw(3, "Gamma", "729.95")], {
      budget: { target: 700, currency: "ILS" },
      shopCurrency: "USD",
    });
    const verdict = applyBudgetPolicy(mismatched, { target: 700, currency: "ILS" }, 5);
    expect(verdict.notApplicable).toBe(true);
    expect(verdict.selected).toHaveLength(2);
    expect(verdict.hasAboveBudgetAlternative).toBe(false);
  });

  it("does not exclude a product that simply has no price", () => {
    const noPrice = envelope(
      [raw(1, "Alpha", "600.00"), { id: 9, title: "Mystery", handle: "mystery", status: "active", variants: [] }],
      { budget: BUDGET },
    );
    const verdict = applyBudgetPolicy(noPrice, BUDGET, 5);
    expect(verdict.above).toHaveLength(0);
    expect(numericPrice(noPrice.candidates[1])).toBeNull();
  });

  it("uses numbers, not the model's prose", () => {
    // The model claiming "all within your budget" changes nothing.
    const verdict = applyBudgetPolicy(MIXED(), BUDGET, 5);
    expect(verdict.selected.every((c) => Number(c.price) <= 700)).toBe(true);
  });
});

// ─── 6/7. Channel routing and fallback ───────────────────────

describe("6. a channel that cannot render cards keeps the text path", () => {
  it("skips structured and says why", () => {
    const p = plan({ channelSupportsCards: false });
    expect(p.shouldSendStructured).toBe(false);
    expect(p.skipReason).toBe("channel_cannot_render");
  });
});

describe("7. WhatsApp is unchanged", () => {
  it("has no carousel or cards in the capability map, so it never auto-stages", () => {
    const caps = capabilitiesFor("WHATSAPP");
    expect(caps.supportsProductCarousel || caps.supportsCards).toBe(false);
    const p = plan({ channelSupportsCards: caps.supportsProductCarousel || caps.supportsCards });
    expect(p.shouldSendStructured).toBe(false);
    expect(p.skipReason).toBe("channel_cannot_render");
  });

  it("Shopify Live Chat does support them", () => {
    const caps = capabilitiesFor("SHOPIFY_LIVE_CHAT");
    expect(caps.supportsProductCarousel).toBe(true);
    expect(caps.maxCards).toBe(5);
  });
});

// ─── 9. No duplication when the model DID call the tool ──────

describe("9. products never appear in both the text and the cards", () => {
  it("still reduces the text when the model already staged cards", () => {
    const p = plan({
      alreadyStaged: true,
      modelText: `מצאתי:\n1. Alpha Board 600.00 USD https://${SHOP}/products/alpha-board`,
    });
    expect(p.shouldSendStructured).toBe(false);
    expect(p.skipReason).toBe("already_staged");
    // The critical part: the introduction is still cleaned, so the
    // customer does not receive the same three products twice.
    expect(p.introduction).not.toContain("https://");
    expect(p.introduction).not.toMatch(/^\s*\d+[.)]/m);
  });
});

// ─── Envelope states ─────────────────────────────────────────

describe("degenerate envelopes", () => {
  it("no results means no structured payload", () => {
    const p = plan({ envelope: envelope([]) });
    expect(p.shouldSendStructured).toBe(false);
    expect(p.skipReason).toBe("envelope_not_ok");
  });

  it("a provider error means no structured payload", () => {
    const p = plan({
      envelope: {
        provider: "shopify",
        tool: "shopify_product_search",
        status: "error",
        candidates: [],
        appliedFilters: [],
        unavailableFilters: [],
        safeModelSummary: "",
      },
    });
    expect(p.shouldSendStructured).toBe(false);
    expect(p.skipReason).toBe("envelope_not_ok");
  });

  it("respects the channel's card limit", () => {
    const many = envelope([
      raw(1, "A", "10.00"), raw(2, "B", "10.00"), raw(3, "C", "10.00"),
      raw(4, "D", "10.00"), raw(5, "E", "10.00"), raw(6, "F", "10.00"),
    ]);
    const p = plan({ envelope: many, maxProducts: 5 });
    expect(p.selected).toHaveLength(5);
  });
});

// ─── Introduction hygiene ────────────────────────────────────

describe("introduction hygiene", () => {
  it("caps at two sentences", () => {
    const intro = extractIntroduction("ראשונה. שנייה. שלישית. רביעית.", {
      locale: "he",
      candidates: [],
    });
    expect(intro).toBe("ראשונה. שנייה.");
  });

  it("truncates a very long lead-in", () => {
    const intro = extractIntroduction("א".repeat(500), { locale: "he", candidates: [], maxChars: 60 });
    expect(intro.length).toBeLessThanOrEqual(60);
  });

  it("has an English default", () => {
    expect(extractIntroduction("", { locale: "en", candidates: [] })).toBe(
      "Here are a few options that could suit you:",
    );
  });
});

// ─── Defects the LIVE Dev conversation exposed ───────────────

describe("live regressions (caught on Dev, not by the unit tests above)", () => {
  const BUDGET = { target: 700, currency: "USD" };

  it("says '2 of them' when two are over budget, not 'One of them'", () => {
    // Live: two of three products were over budget and the caveat read
    // "One of them is a little above the budget you gave". A sentence
    // written to be honest about budget cannot be sloppy about count.
    const thin = envelope(
      [raw(1, "Cheap", "10.00"), raw(2, "Pricey", "949.95"), raw(3, "Dear", "885.95")],
      { budget: BUDGET },
    );
    const p = planAutoRecommendation({
      envelope: thin,
      channelSupportsCards: true,
      alreadyStaged: false,
      modelText: "I searched our catalog.",
      locale: "en",
      budget: BUDGET,
      maxProducts: 5,
    });
    expect(p.introduction).toContain("2 of them are above the budget you gave");
    expect(p.introduction).not.toContain("One of them");
  });

  it("still says 'One of them' when exactly one is over budget", () => {
    const thin = envelope([raw(1, "Cheap", "10.00"), raw(2, "Pricey", "949.95")], { budget: BUDGET });
    const p = planAutoRecommendation({
      envelope: thin,
      channelSupportsCards: true,
      alreadyStaged: false,
      modelText: "I searched our catalog.",
      locale: "en",
      budget: BUDGET,
      maxProducts: 5,
    });
    expect(p.introduction).toContain("One of them is a little above");
  });

  it("counts only the products actually going out", () => {
    const mixed = envelope(
      [raw(1, "A", "600.00"), raw(2, "B", "650.00"), raw(3, "C", "949.95")],
      { budget: BUDGET },
    );
    const verdict = applyBudgetPolicy(mixed, BUDGET, 5);
    // Two within budget, so the over-budget one is excluded and the
    // caveat must not appear at all.
    expect(countAboveBudget(verdict, BUDGET)).toBe(0);
  });

  it("drops an out-of-stock product from an automatic shortlist", () => {
    // Live: a $10 Gift Card with available:false was carried into a
    // snowboard carousel, with an Add to Cart button on it.
    const withOos = envelope([
      raw(1, "Gift Card", "10.00", false),
      raw(2, "Board A", "600.00", true),
      raw(3, "Board B", "650.00", true),
    ]);
    const kept = filterByAvailability(withOos.candidates);
    expect(kept.map((c) => c.title)).toEqual(["Board A", "Board B"]);
  });

  it("out-of-stock filtering happens BEFORE budget, so it cannot waste a slot", () => {
    const withOos = envelope(
      [raw(1, "Gift Card", "10.00", false), raw(2, "Board A", "600.00"), raw(3, "Board B", "650.00")],
      { budget: BUDGET },
    );
    const verdict = applyBudgetPolicy(withOos, BUDGET, 3);
    expect(verdict.selected.map((c) => c.title)).toEqual(["Board A", "Board B"]);
  });

  it("keeps out-of-stock products when almost nothing is in stock", () => {
    // An empty carousel is worse than a truthful one with stock badges.
    const mostlyOos = envelope([
      raw(1, "Gone", "600.00", false),
      raw(2, "Also gone", "650.00", false),
      raw(3, "Last one", "680.00", true),
    ]);
    expect(filterByAvailability(mostlyOos.candidates)).toHaveLength(3);
  });
});

describe("the introduction describes what actually ships", () => {
  const BUDGET = { target: 700, currency: "USD" };

  it("counts against the STAGING limit, not the channel maximum", () => {
    // Live: the plan selected 5, staging truncated to the merchant's
    // carouselSize of 3, and the introduction announced "4 of them are
    // above the budget" over a carousel of three.
    const many = envelope(
      [
        raw(1, "A", "949.95"), raw(2, "B", "885.95"), raw(3, "C", "749.95"),
        raw(4, "D", "949.95"), raw(5, "E", "600.00"),
      ],
      { budget: BUDGET },
    );
    const p = planAutoRecommendation({
      envelope: many,
      channelSupportsCards: true,
      alreadyStaged: false,
      modelText: "I pulled some matches.",
      locale: "en",
      budget: BUDGET,
      maxProducts: 3,
    });
    expect(p.selected).toHaveLength(3);
    // Whatever it claims, it claims about three products.
    const claimed = p.introduction.match(/(\d+) of them are above/);
    if (claimed) expect(Number(claimed[1])).toBeLessThanOrEqual(3);
  });

  it("says plainly when NOTHING is within budget", () => {
    const allAbove = envelope([raw(1, "A", "949.95"), raw(2, "B", "885.95")], { budget: BUDGET });
    const p = planAutoRecommendation({
      envelope: allAbove,
      channelSupportsCards: true,
      alreadyStaged: false,
      modelText: "I pulled some matches.",
      locale: "en",
      budget: BUDGET,
      maxProducts: 3,
    });
    expect(p.introduction).toContain("None of these come in under the budget");
    expect(p.introduction).not.toMatch(/\d+ of them are above/);
  });

  it("does not add a second budget claim when the model already made one", () => {
    // Live: the model said "both are above your limit" and we appended
    // "4 of them are above the budget you gave" underneath it.
    const allAbove = envelope([raw(1, "A", "949.95"), raw(2, "B", "885.95")], { budget: BUDGET });
    const p = planAutoRecommendation({
      envelope: allAbove,
      channelSupportsCards: true,
      alreadyStaged: false,
      modelText: "Both of these are above your limit, but they are the closest we have.",
      locale: "en",
      budget: BUDGET,
      maxProducts: 3,
    });
    expect(p.introduction).toBe(
      "Both of these are above your limit, but they are the closest we have.",
    );
  });
});

describe("the introduction never re-lists the products", () => {
  it("drops a sentence that names two or more of the carded products", () => {
    // Live: four boards named inline above a carousel of three, one of
    // which was not even shown.
    const p = plan({
      modelText:
        "I loaded matching items below. Quick note: Alpha Board, Beta Board and Gamma Board are all above your limit.",
    });
    expect(p.introduction).toBe("I loaded matching items below.");
  });

  it("leaves a SINGLE product mention alone - that is normal speech", () => {
    const p = plan({ modelText: "Alpha Board is the closest to what you described." });
    expect(p.introduction).toBe("Alpha Board is the closest to what you described.");
  });

  it("cleans up a parenthesis left dangling by the removed clause", () => {
    const out = stripProductEnumeration(
      "Here is what I found ( Alpha Board Beta Board are marked ) and that is all.",
      ["Alpha Board", "Beta Board"],
    );
    expect(out).not.toContain("( )");
    expect(out).not.toContain("Beta Board");
  });

  it("falls back to a real lead-in when the whole reply was a list", () => {
    const p = plan({ modelText: "Alpha Board, Beta Board and Gamma Board." });
    expect(p.introduction).toBe("מצאתי כמה אפשרויות שיכולות להתאים:");
  });

  it("does nothing when there are fewer than two titles to match", () => {
    expect(stripProductEnumeration("Anything at all.", ["Solo"])).toBe("Anything at all.");
  });
});

// ─── 6. Carousel delivery failure → logged text fallback ─────

describe("6. the rendering invariant, including when it fails", () => {
  afterEach(() => vi.restoreAllMocks());

  const sending = () => plan();

  it("cards went out: the text is the lead-in, no fallback", () => {
    const d = decideDelivery(sending(), { ok: true });
    expect(d).toEqual({ structuredSent: true, useTextFallback: false });
  });

  it("staging REFUSED: text fallback, with the reason attached", () => {
    const d = decideDelivery(sending(), { ok: false, reason: "no_matching_products" });
    expect(d.structuredSent).toBe(false);
    expect(d.useTextFallback).toBe(true);
    expect(d.fallbackReason).toBe("stage_refused:no_matching_products");
  });

  it("staging refused with no reason still names the failure", () => {
    expect(decideDelivery(sending(), { ok: false }).fallbackReason).toBe("stage_refused:unknown");
  });

  it("staging THREW: text fallback, with the message attached", () => {
    const d = decideDelivery(sending(), { threw: new Error("shopify 502") });
    expect(d.useTextFallback).toBe(true);
    expect(d.fallbackReason).toBe("stage_threw:shopify 502");
  });

  it("a non-Error throw is still reported rather than swallowed", () => {
    expect(decideDelivery(sending(), { threw: "boom" }).fallbackReason).toBe("stage_threw:unknown");
  });

  it("never attempted, though it should have been, is itself an incident", () => {
    expect(decideDelivery(sending(), null).fallbackReason).toBe("not_attempted");
  });

  it("a channel that cannot render cards falls back WITHOUT an incident", () => {
    // Not a failure - the text list is simply the right answer there, so
    // it must not pollute the fallback rate.
    const d = decideDelivery(plan({ channelSupportsCards: false }), null);
    expect(d.useTextFallback).toBe(true);
    expect(d.fallbackReason).toBeUndefined();
  });

  it("already staged by the model: no fallback and no incident", () => {
    const d = decideDelivery(plan({ alreadyStaged: true }), null);
    expect(d.structuredSent).toBe(false);
    expect(d.useTextFallback).toBe(false);
    expect(d.fallbackReason).toBeUndefined();
  });

  it("logs the fallback so the rate is visible", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportCarouselFallback({
      conversationId: "conv1",
      tenantId: "t1",
      reason: "stage_refused:no_matching_products",
      productCount: 3,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain("shopify carousel fallback");
    expect(line).toContain("conv=conv1");
    expect(line).toContain("reason=stage_refused:no_matching_products");
    expect(line).toContain("products=3");
  });

  it("observability failing never costs the customer their reply", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("logger exploded");
    });
    // console.warn is inside reportCarouselFallback, so an exploding
    // logger would otherwise propagate straight up the reply path.
    expect(() =>
      reportCarouselFallback({ conversationId: "c", tenantId: "t", reason: "x", productCount: 1 }),
    ).not.toThrow();
  });
});
