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
import { describe, it, expect } from "vitest";
import {
  planAutoRecommendation,
  applyBudgetPolicy,
  extractIntroduction,
  reasonForCandidate,
  isAboveBudget,
  numericPrice,
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
