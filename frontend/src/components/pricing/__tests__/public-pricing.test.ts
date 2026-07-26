import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteSelection, defaultSelection, formatMinor, toMinor, type PublicPlan } from "@/lib/api-public-pricing";

const SRC = join(__dirname, "../../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

// ── Fixtures ────────────────────────────────────────────────────────────────

function price(amount: string, currency = "USD") {
  const sym = currency === "ILS" ? "₪" : "$";
  return {
    amount,
    currency,
    formatted: `${sym}${Number(amount).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    base: { amount, currency: "USD", formatted: `$${Number(amount).toFixed(0)}` },
    isEstimatedConversion: currency !== "USD",
    chargedCurrency: "USD",
  };
}

function volume(key: string, channel: "CHAT" | "VOICE", daily: number, credits: number, amount: string, isDefault = false) {
  return {
    key, channel, dailyVolume: daily, monthlyVolume: daily * 25,
    additionalCredits: credits, additionalPrice: price(amount),
    isDefault, totalChannelCredits: credits,
  };
}

function plan(over: Partial<PublicPlan> = {}): PublicPlan {
  return {
    key: "ai_voice", version: 1, name: "AI Voice", nameHe: "קול AI",
    description: "Everything in AI Workforce, on the phone as well as in chat.",
    descriptionHe: "כל היכולות של כוח עבודה AI, גם בטלפון וגם בצ'אט.",
    recommended: false, sortOrder: 30, salesOnly: false, billingInterval: "MONTHLY",
    price: price("1499.00"), includedCredits: 7000,
    creditSplit: { chat: 2000, voice: 5000 },
    supportLevel: "dedicated",
    chatVolumeEnabled: true, voiceVolumeEnabled: true,
    autoPurchaseEligible: true, creditPackagesEligible: true,
    features: [], limits: {},
    chatOptions: [
      volume("chat_10", "CHAT", 10, 0, "0.00", true),
      volume("chat_100", "CHAT", 100, 18000, "349.00"),
    ],
    voiceOptions: [
      volume("voice_10", "VOICE", 10, 0, "0.00", true),
      volume("voice_25", "VOICE", 25, 7500, "249.00"),
    ],
    estimate: {
      chat: { credits: 2000, monthly: 250, daily: 10 },
      voice: { credits: 5000, monthly: 250, daily: 10 },
      totalInteractions: 500,
      pricePerChat: "3.00", pricePerCall: "3.00", pricePerInteraction: "3.00",
      currency: "USD",
      ratios: { chatCreditsPerEstimatedConversation: 8, voiceCreditsPerEstimatedCall: 20, businessDaysPerMonth: 25 },
    },
    ...over,
  };
}

// ── Money ───────────────────────────────────────────────────────────────────

describe("money is integer minor units, never floats", () => {
  it("parses decimal strings exactly", () => {
    expect(toMinor("149.00")).toBe(14_900);
    expect(toMinor("1499.00")).toBe(149_900);
    expect(toMinor("0.00")).toBe(0);
    // 0.145 * 100 is 14.499999999999998 in IEEE-754; string parsing is exact.
    expect(toMinor("0.14")).toBe(14);
  });

  it("adds option prices without drift", () => {
    // 1499 + 349 + 249 = 2097, exactly.
    const q = quoteSelection(plan(), { chat: "chat_100", voice: "voice_25" });
    expect(q.monthlyMinor).toBe(209_700);
    expect(formatMinor(q.monthlyMinor, "USD")).toBe("$2,097");
  });

  it("formats with the right symbol per currency", () => {
    expect(formatMinor(55_500, "ILS")).toBe("₪555");
    expect(formatMinor(14_900, "USD")).toBe("$149");
    expect(formatMinor(60, "USD", 2)).toBe("$0.60");
  });
});

// ── Selection maths ─────────────────────────────────────────────────────────

describe("volume selection", () => {
  it("defaults to each channel's default option", () => {
    expect(defaultSelection(plan())).toEqual({ chat: "chat_10", voice: "voice_10" });
  });

  it("offers no selection when the plan disables the selector", () => {
    const foundation = plan({ chatVolumeEnabled: false, voiceVolumeEnabled: false });
    expect(defaultSelection(foundation)).toEqual({ chat: null, voice: null });
  });

  it("adds the selected chat option's credits to the plan base", () => {
    const q = quoteSelection(plan(), { chat: "chat_100", voice: "voice_10" });
    expect(q.chatCredits).toBe(20_000); // 2,000 base + 18,000
    expect(q.estimatedChatsMonthly).toBe(2500); // / 8
    expect(q.estimatedChatsDaily).toBe(100); // / 25 business days
  });

  it("selects chat and voice independently", () => {
    const q = quoteSelection(plan(), { chat: "chat_100", voice: "voice_25" });
    expect(q.estimatedChatsDaily).toBe(100);
    expect(q.estimatedCallsDaily).toBe(25);
    expect(q.includedCredits).toBe(32_500);
  });

  it("separates plan credits from added credits, so the change is explainable", () => {
    const q = quoteSelection(plan(), { chat: "chat_100", voice: "voice_25" });
    expect(q.baseCredits).toBe(7000);
    expect(q.addedCredits).toBe(25_500);
    expect(q.baseCredits + q.addedCredits).toBe(q.includedCredits);
  });

  it("ignores a selector the plan does not enable", () => {
    const chatOnly = plan({ voiceVolumeEnabled: false });
    const q = quoteSelection(chatOnly, { chat: "chat_100", voice: "voice_25" });
    expect(q.voiceOption).toBeNull();
    expect(q.voiceCredits).toBe(5000); // base split only, no added voice
  });

  it("survives a missing option key instead of throwing", () => {
    const q = quoteSelection(plan(), { chat: "chat_does_not_exist", voice: null });
    expect(q.chatOption).toBeNull();
    expect(q.monthlyMinor).toBe(149_900); // base price only
  });
});

describe("price per conversation", () => {
  it("splits the price proportionally across channels", () => {
    const q = quoteSelection(plan(), { chat: "chat_10", voice: "voice_10" });
    // 250 chats + 250 calls at $1,499: each channel carries half over 250 units.
    expect(formatMinor(q.pricePerChatMinor!, "USD", 2)).toBe("$3.00");
    expect(formatMinor(q.pricePerCallMinor!, "USD", 2)).toBe("$3.00");
  });

  it("returns null rather than dividing by zero", () => {
    const empty = plan({ creditSplit: { chat: 0, voice: 0 }, chatOptions: [], voiceOptions: [], chatVolumeEnabled: false, voiceVolumeEnabled: false });
    const q = quoteSelection(empty, { chat: null, voice: null });
    expect(q.pricePerChatMinor).toBeNull();
    expect(q.pricePerCallMinor).toBeNull();
    expect(q.pricePerInteractionMinor).toBeNull();
  });

  it("reports no voice capacity for a chat-only plan", () => {
    const chatOnly = plan({ creditSplit: { chat: 2000, voice: 0 }, voiceVolumeEnabled: false });
    const q = quoteSelection(chatOnly, { chat: "chat_10", voice: null });
    expect(q.estimatedCallsMonthly).toBe(0);
    expect(q.pricePerCallMinor).toBeNull();
  });
});

// ── No hardcoded commercial values in the UI ────────────────────────────────

describe("the UI holds no pricing data of its own", () => {
  const uiFiles = [
    "app/pricing/page.tsx",
    "components/pricing/PlanGrid.tsx",
    "components/pricing/VolumeConfigurator.tsx",
    "components/pricing/ComparisonTable.tsx",
    "components/landing/PricingSection.tsx",
  ];

  it.each(uiFiles)("%s contains no hardcoded price", (f) => {
    const code = read(f).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    // Any currency-prefixed figure, or a bare seeded price.
    expect(code).not.toMatch(/[$₪]\s?\d/);
    for (const seeded of ["149", "499", "1499", "2097", "79", "179", "349", "649", "249", "599", "1199", "2299"]) {
      expect(code, `${f} must not hardcode ${seeded}`).not.toMatch(new RegExp(`\\b${seeded}\\b`));
    }
  });

  it.each(uiFiles)("%s contains no hardcoded plan name", (f) => {
    const code = read(f).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const name of ["Foundation", "AI Workforce", "AI Voice", "foundation", "ai_workforce", "ai_voice"]) {
      expect(code, `${f} must not hardcode plan ${name}`).not.toContain(name);
    }
  });

  it.each(uiFiles)("%s contains no hardcoded credit allocation or ratio", (f) => {
    const code = read(f).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const n of ["2000", "7000", "5000", "18000", "38000", "95000"]) {
      expect(code, `${f} must not hardcode ${n}`).not.toMatch(new RegExp(`\\b${n}\\b`));
    }
    // The 8 / 20 / 25 commercial ratios must come from the API.
    expect(code).not.toMatch(/creditsPerEstimatedConversation\s*[:=]\s*\d/);
    expect(code).not.toMatch(/businessDaysPerMonth\s*[:=]\s*\d/);
  });

  it("computes no estimate of its own in the page", () => {
    const code = read("app/pricing/page.tsx");
    // The page composes; all arithmetic lives in the shared client helper.
    expect(code).not.toMatch(/\/\s*8\b|\/\s*20\b|\/\s*25\b/);
  });
});

// ── Feature flag ────────────────────────────────────────────────────────────

describe("publication flag", () => {
  it("the page checks the flag before rendering a catalog", () => {
    const code = read("app/pricing/page.tsx");
    expect(code).toContain("publicPricingEnabled");
    expect(code).toMatch(/if\s*\(!publicPricingEnabled\)/);
  });

  it("the landing section renders nothing when the flag is off", () => {
    const code = read("components/landing/PricingSection.tsx");
    expect(code).toMatch(/if\s*\(!publicPricingEnabled(\s*\|\|[^)]*)?\)\s*return null/);
  });

  it("every landing pricing link is flag-gated", () => {
    const code = read("components/landing/LandingPage.tsx");
    const links = [...code.matchAll(/landing\.nav\.pricing/g)];
    expect(links.length).toBeGreaterThanOrEqual(3); // desktop, mobile, footer
    // Each occurrence sits inside a publicPricingEnabled guard.
    for (const m of links) {
      const before = code.slice(Math.max(0, m.index! - 400), m.index!);
      expect(before).toContain("publicPricingEnabled");
    }
  });

  it("the flag defaults to false when the env var is unset", () => {
    const code = read("lib/api-public-pricing.ts");
    expect(code).toMatch(/NEXT_PUBLIC_PRICING_ENABLED\s*\?\?\s*"false"/);
  });
});

// ── CTA behaviour ───────────────────────────────────────────────────────────

describe("CTA destinations", () => {
  const page = read("app/pricing/page.tsx");

  it("sends unauthenticated visitors to early access", () => {
    expect(page).toMatch(/signedIn\s*\?\s*"\/settings\/billing\/plan"\s*:\s*"\/early-access"/);
  });

  it("sends signed-in visitors to the authenticated configurator", () => {
    expect(page).toContain('"/settings/billing/plan"');
  });

  it("waits for auth to settle so the CTA cannot flip under a click", () => {
    expect(page).toMatch(/!authLoading\s*&&\s*!!user/);
  });

  it("routes the custom plan through the sales path with context", () => {
    expect(page).toContain('/early-access?plan=custom');
  });
});

// ── Privacy ─────────────────────────────────────────────────────────────────

describe("public surfaces never reference private data", () => {
  const publicFiles = [
    "app/pricing/page.tsx",
    "components/pricing/PlanGrid.tsx",
    "components/pricing/VolumeConfigurator.tsx",
    "components/pricing/ComparisonTable.tsx",
    "components/pricing/PricingSections.tsx",
    "components/landing/PricingSection.tsx",
    "lib/api-public-pricing.ts",
  ];

  it.each(publicFiles)("%s references no token, cost or usage metric", (f) => {
    const code = read(f).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const forbidden of [
      "promptTokens", "completionTokens", "costUsd", "modelCost", "marginFactor",
      "unitCostBasis", "avgCreditsPerConversation", "aiUnit", "conversationUsageAggregate",
    ]) {
      expect(code, `${f} must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it.each(publicFiles)("%s calls no authenticated billing endpoint", (f) => {
    const code = read(f);
    expect(code).not.toContain("/api/billing/");
    expect(code).not.toContain("api-billing");
    expect(code).not.toContain("api-pricing-admin");
  });

  it("the public client sends no Authorization header", () => {
    const code = read("lib/api-public-pricing.ts");
    expect(code).not.toContain("Authorization");
    expect(code).not.toContain("Bearer");
  });
});

// ── i18n ────────────────────────────────────────────────────────────────────

describe("localization", () => {
  const en = JSON.parse(read("i18n/en.json"));
  const he = JSON.parse(read("i18n/he.json"));

  const keys = (o: any, p = ""): string[] =>
    o && typeof o === "object" && !Array.isArray(o)
      ? Object.entries(o).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k))
      : [p];

  it("pricing keys exist in both locales with no gaps", () => {
    const a = keys(en.pricing).sort();
    const b = keys(he.pricing).sort();
    expect(a.length).toBeGreaterThan(80);
    expect(a).toEqual(b);
  });

  it("landing pricing keys exist in both locales", () => {
    expect(keys(en.landing.pricing).sort()).toEqual(keys(he.landing.pricing).sort());
    expect(en.landing.nav.pricing).toBeTruthy();
    expect(he.landing.nav.pricing).toBeTruthy();
  });

  it("the Hebrew FAQ is real copy, not English left in place", () => {
    const hebrew = /[֐-׿]/;
    for (const item of he.pricing.faq.items) {
      expect(hebrew.test(item.q), `question not translated: ${item.q}`).toBe(true);
      expect(hebrew.test(item.a), `answer not translated: ${item.q}`).toBe(true);
    }
    expect(he.pricing.faq.items.length).toBe(en.pricing.faq.items.length);
  });

  it("Hebrew CTA copy matches the specified wording", () => {
    expect(he.pricing.cta.getStarted).toBe("התחילו עכשיו");
    expect(en.pricing.cta.getStarted).toBe("Get started");
    expect(he.pricing.custom.cta).toBe("דברו איתנו");
    expect(en.pricing.custom.cta).toBe("Contact sales");
  });

  it("no customer-facing pricing copy claims other customers' usage", () => {
    for (const blob of [JSON.stringify(en.pricing), JSON.stringify(he.pricing), JSON.stringify(en.landing.pricing), JSON.stringify(he.landing.pricing)]) {
      expect(blob).not.toMatch(/platform average|other customers|average usage|ממוצע הפלטפורמה|לקוחות אחרים/i);
    }
  });

  it("no customer-facing pricing copy mentions tokens or AI units", () => {
    for (const blob of [JSON.stringify(en.pricing), JSON.stringify(en.landing.pricing)]) {
      expect(blob).not.toMatch(/\btokens?\b|\bAI units?\b/i);
    }
    for (const blob of [JSON.stringify(he.pricing), JSON.stringify(he.landing.pricing)]) {
      expect(blob).not.toMatch(/טוקן|יחידות AI/);
    }
  });

  it("uses no em dash in customer-facing pricing copy", () => {
    for (const blob of [JSON.stringify(en.pricing), JSON.stringify(he.pricing), JSON.stringify(en.landing.pricing), JSON.stringify(he.landing.pricing)]) {
      expect(blob).not.toMatch(/[—–]/);
    }
  });

  it("avoids hype phrasing", () => {
    const blob = JSON.stringify(en.pricing) + JSON.stringify(en.landing.pricing);
    for (const banned of ["unlock the power", "supercharge", "revolutioniz", "seamless", "cutting-edge", "game-chang"]) {
      expect(blob.toLowerCase()).not.toContain(banned);
    }
  });

  it("carries the required estimate disclaimer wording", () => {
    expect(en.landing.pricing.note).toMatch(/Actual credit consumption varies by conversation length, channel, AI actions, enabled features and voice duration/);
  });
});

// ── Accessibility ───────────────────────────────────────────────────────────

describe("accessibility", () => {
  it("volume selectors are a real radiogroup", () => {
    const code = read("components/pricing/VolumeConfigurator.tsx");
    expect(code).toContain('role="radiogroup"');
    expect(code).toContain('role="radio"');
    expect(code).toContain("aria-checked");
    expect(code).toContain("<fieldset");
    expect(code).toContain("<legend");
  });

  it("price changes are announced to assistive technology", () => {
    expect(read("components/pricing/PricingPrimitives.tsx")).toContain('aria-live="polite"');
    expect(read("components/pricing/VolumeConfigurator.tsx")).toContain("PriceAnnouncer");
  });

  it("the currency switch is a labelled radiogroup", () => {
    const code = read("components/pricing/PricingPrimitives.tsx");
    expect(code).toContain('role="radiogroup"');
    expect(code).toContain("aria-labelledby");
  });

  it("the comparison uses real table semantics", () => {
    const code = read("components/pricing/ComparisonTable.tsx");
    expect(code).toContain("<caption");
    expect(code).toContain('scope="col"');
    expect(code).toContain('scope="row"');
    expect(code).toContain('scope="colgroup"');
  });

  it("unavailable state is not conveyed by colour alone", () => {
    const code = read("components/pricing/PricingPrimitives.tsx");
    // The dash is decorative; the word is what a screen reader gets.
    expect(code).toMatch(/NotIncluded[\s\S]{0,400}sr-only/);
  });

  it("respects reduced motion", () => {
    const code = read("components/pricing/PricingPrimitives.tsx");
    expect(code).toContain("prefers-reduced-motion");
    expect(read("components/landing/PricingSection.tsx")).toContain("prefers-reduced-motion");
  });

  it("offers a skip link to the plans", () => {
    expect(read("app/pricing/page.tsx")).toContain("skipToPlans");
  });

  it("every interactive pricing control has a visible focus state", () => {
    for (const f of [
      "components/pricing/PricingPrimitives.tsx",
      "components/pricing/VolumeConfigurator.tsx",
      "components/pricing/PlanGrid.tsx",
      "components/pricing/PricingSections.tsx",
    ]) {
      const code = read(f);
      const buttons = (code.match(/<button/g) ?? []).length;
      if (buttons > 0) expect(code, `${f} needs focus-visible styling`).toContain("focus-visible:ring");
    }
  });

  it("accordion state is exposed", () => {
    expect(read("components/pricing/PricingSections.tsx")).toContain("aria-expanded");
    expect(read("components/pricing/ComparisonTable.tsx")).toContain("aria-expanded");
  });
});

// ── Loading and empty states ────────────────────────────────────────────────

describe("loading and failure states", () => {
  it("skeletons show no numerals, so no false price flashes", () => {
    const code = read("components/pricing/PricingPrimitives.tsx");
    const skeleton = code.slice(code.indexOf("export function PlanSkeleton"));
    expect(skeleton).not.toMatch(/[$₪]/);
    expect(skeleton).not.toMatch(/\b0\b\s*(credits|conversations)/);
  });

  it("distinguishes a disabled catalog from an outage", () => {
    const hook = read("components/pricing/usePublicPricing.ts");
    expect(hook).toMatch(/status === 404\s*\?\s*"disabled"\s*:\s*"error"/);
  });

  it("renders a notice rather than throwing to the visitor", () => {
    const page = read("app/pricing/page.tsx");
    expect(page).toContain("PricingNotice");
    expect(page).toMatch(/"disabled"\s*\|\|.*"empty"\s*\|\|.*"error"/);
  });

  it("keeps the previous catalog on screen while switching currency", () => {
    expect(read("components/pricing/usePublicPricing.ts")).toMatch(/if\s*\(!catalog\)\s*setState\("loading"\)/);
  });

  it("drops stale responses so a slow request cannot overwrite a newer one", () => {
    expect(read("components/pricing/usePublicPricing.ts")).toContain("seq.current");
  });
});
