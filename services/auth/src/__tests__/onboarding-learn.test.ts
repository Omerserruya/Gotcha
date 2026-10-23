/**
 * The learn stages (2026-10-23): each kind lands on the feed, in the knowledge
 * base and on the discovery row as soon as it is extracted; a rescan replaces
 * documents in place; an edit rewrites the document the AI reads.
 *
 * In-memory rows and a fake AI service - no database, no model.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  disc: null as any,
  kbs: [] as any[],
  docs: [] as any[],
  catalog: [] as any[],
  connected: [] as any[],
  aiCalls: [] as any[],
  extract: {} as Record<string, any>,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const jsonPath = (row: any, where: any) => !where?.metadata || row.metadata?.[where.metadata.path[0]] === where.metadata.equals;
  return {
    ...actual,
    getInternalServiceKey: () => "k",
    prisma: {
      businessDiscovery: {
        findUnique: async () => (H.disc ? JSON.parse(JSON.stringify(H.disc)) : null),
        update: async ({ data }: any) => { H.disc = { ...H.disc, ...JSON.parse(JSON.stringify(data)) }; },
      },
      knowledgeBase: {
        findFirst: async ({ where }: any) => H.kbs.find((k) => k.tenantId === where.tenantId && k.description === where.description) ?? null,
        create: async ({ data }: any) => { const kb = { id: `kb${H.kbs.length + 1}`, ...data }; H.kbs.push(kb); return kb; },
      },
      knowledgeDocument: {
        findFirst: async ({ where }: any) => H.docs.find((d) => d.tenantId === where.tenantId && d.knowledgeBaseId === where.knowledgeBaseId && jsonPath(d, where)) ?? null,
      },
      integrationCatalog: { findMany: async ({ where }: any) => H.catalog.filter((c) => where.slug.in.includes(c.slug)) },
      tenantIntegration: { findMany: async () => H.connected },
    },
  };
});

import { learnStages, pagesFor, siteLanguage } from "../services/onboarding-discover/learn";
import { readLearned, editLearned, faqId } from "../services/onboarding-discover/learned";
import type { AiCall } from "../services/onboarding-discover/learn";

/** The AI service: extraction answers from H.extract; documents stored in H.docs. */
const ai: AiCall = async (tenantId, method, path, body: any) => {
  H.aiCalls.push({ method, path, body });
  if (path === "/api/ai-assist/onboarding-extract") {
    const r = H.extract[body.kind];
    if (r === "down") return { ok: false, status: 502, body: {} };
    return { ok: true, status: 200, body: { data: r ? { ok: true, result: r } : { ok: false } } };
  }
  const m = /^\/api\/knowledge-bases\/([^/]+)\/documents(?:\/([^/]+))?$/.exec(path);
  if (m && method === "POST") {
    const doc = { id: `d${H.docs.length + 1}`, tenantId, knowledgeBaseId: m[1], ...body };
    H.docs.push(doc);
    return { ok: true, status: 201, body: { data: { id: doc.id } } };
  }
  if (m && method === "PUT") {
    Object.assign(H.docs.find((d) => d.id === m[2]), body);
    return { ok: true, status: 200, body: { data: { id: m[2] } } };
  }
  if (m && method === "DELETE") {
    H.docs = H.docs.filter((d) => d.id !== m[2]);
    return { ok: true, status: 200, body: {} };
  }
  return { ok: false, status: 404, body: {} };
};

const O = "https://shop.example";
const PAGES: any[] = [
  { url: O, kind: "page", title: "Home", text: "Welcome", html: '<html lang="he"><body>שלום</body></html>' },
  { url: `${O}/policies/refund-policy`, kind: "returns", title: "Refunds", text: "30 days", html: "" },
  { url: `${O}/pages/faq`, kind: "faq", title: "FAQ", text: "Q A", html: "" },
  { url: `${O}/pages/about`, kind: "about", title: "About", text: "Story", html: "" },
  { url: `${O}/products/a`, kind: "product", title: "A", text: "A", html: "" },
];
const POLICIES = { kind: "policies", policies: [{ kind: "returns", summary: "30 יום להחזרה", terms: { windowDays: 30, exchange: { allowed: true, how: "בטופס" } }, sourceUrl: `${O}/policies/refund-policy` }] };
const FAQ = { kind: "faq", faq: [{ q: "מתי המשלוח מגיע?", a: "תוך 3 ימי עסקים", sourceUrl: `${O}/pages/faq` }] };
const PROFILE = { kind: "profile", profile: { name: "Shop", industry: "Fashion", summary: "S", valueProp: "V" }, contact: { emails: ["hi@shop.example"], phones: [], whatsapp: [], address: null, hours: "א-ה 9-17" }, currency: "ILS" };
const BRAND = { kind: "brand", brand: { voice: "חם", tone: "קליל", vocabulary: [], preferredTerminology: [], forbiddenWords: [], languages: ["he"] }, employeeName: "מאיה" };
const FEED = { platform: "shopify", products: { count: 3, more: false, categories: ["Tops"], priceRange: { min: 10, max: 99, currency: null }, inStock: 3, highlights: [{ title: "Tee", url: null, price: 10 }], source: "shopify_feed" }, policyUrls: [] };

function ctx(over: any = {}) {
  const events: any[] = [];
  return {
    events,
    ctx: {
      tenantId: "T", jobId: "J", origin: O, locale: "en", pages: PAGES, harvest: FEED, signals: { tools: [] } as any, tools: ["klaviyo"], doneStages: [],
      emit: async (stage: string, kind: string, key: string, params?: any, patch?: any) => { events.push({ stage, kind, key, params, patch }); },
      ...over,
    },
  };
}

beforeEach(() => {
  H.disc = { tenantId: "T", brand: null, business: null, knowledge: null, communication: null, technology: null, recommendation: null };
  H.kbs = []; H.docs = []; H.aiCalls = [];
  H.extract = { policies: POLICIES, faq: FAQ, profile: PROFILE, brand: BRAND };
  H.catalog = [
    { id: "c-shop", slug: "shopify", name: "Shopify", authType: "OAUTH2" },
    { id: "c-kla", slug: "klaviyo", name: "Klaviyo", authType: "API_KEY" },
    { id: "c-hub", slug: "hubspot", name: "HubSpot", authType: "OAUTH2" },
  ];
  H.connected = [];
});

describe("the learn stages", () => {
  it("each kind is extracted, written and announced as it lands, in the site's language", async () => {
    const { ctx: c, events } = ctx();
    await learnStages({ ai })(c as any);
    const keys = events.map((e) => e.key);
    expect(keys).toEqual([
      "knowledge.written",
      "extract.reading", "policy.found", "knowledge.written",
      "extract.reading", "faq.found", "knowledge.written",
      "extract.reading", "profile.found", "knowledge.written", "knowledge.written",
      "extract.reading", "brand.found", "knowledge.written",
      "integrations.suggested",
    ]);
    // One "Website knowledge" base, scope all, one document per key.
    expect(H.kbs).toEqual([expect.objectContaining({ name: "Website knowledge", scope: "all" })]);
    expect(H.docs.map((d) => d.metadata.dedupeKey).sort()).toEqual(["brand", "faq", "policy:returns", "products", "profile"]);
    // Written in the site's language (<html lang="he">), not the request's.
    expect(H.docs.find((d) => d.metadata.dedupeKey === "policy:returns")).toMatchObject({ title: "מדיניות החזרות" });
    expect(H.docs.find((d) => d.metadata.dedupeKey === "policy:returns").content).toContain("חלון החזרה (ימים): 30");
    expect(H.aiCalls.filter((c) => c.path.endsWith("onboarding-extract")).every((c) => c.body.locale === "he")).toBe(true);
    // The Shopify feed has no currency: the page's prices supplied it.
    expect(H.docs.find((d) => d.metadata.dedupeKey === "products").content).toContain("10-99 ILS");
  });

  it("the discovery row keeps the structured results and finishes the scan for legacy readers", async () => {
    await learnStages({ ai })(ctx().ctx as any);
    expect(H.disc.knowledge.structured).toMatchObject({ lang: "he", policies: [{ kind: "returns", terms: { windowDays: 30 } }], faq: [{ q: "מתי המשלוח מגיע?" }] });
    expect(H.disc.knowledge.policies).toEqual({ returns: true });
    expect(H.disc.business).toMatchObject({ name: "Shop", productsSummary: { count: 3 } });
    expect(H.disc.brand).toMatchObject({ voice: "חם" });
    expect(H.disc.recommendation).toEqual({ employeeName: "מאיה" });
    expect(H.disc.communication.contact).toMatchObject({ hours: "א-ה 9-17" });
    expect(H.disc.technology.platform).toMatchObject({ slug: "shopify" });
    expect(H.disc.technology.tools.map((t: any) => t.slug)).toEqual(["klaviyo"]);
    expect(H.disc.status).toBe("COMPLETE");
  });

  it("a rescan replaces each document in place: never a second copy to quote", async () => {
    await learnStages({ ai })(ctx().ctx as any);
    const first = H.docs.map((d) => d.id).sort();
    H.extract.policies = { kind: "policies", policies: [{ ...POLICIES.policies[0], terms: { windowDays: 14 } }] };
    await learnStages({ ai })(ctx().ctx as any);
    expect(H.docs.map((d) => d.id).sort()).toEqual(first);
    expect(H.docs.find((d) => d.metadata.dedupeKey === "policy:returns").content).toContain(": 14");
    expect(H.aiCalls.filter((c) => c.method === "PUT").length).toBeGreaterThan(0);
  });

  it("one kind failing is a warning; the others still land", async () => {
    H.extract.faq = "down";
    const { ctx: c, events } = ctx();
    await learnStages({ ai })(c as any);
    expect(events.find((e) => e.key === "extract.failed")).toMatchObject({ kind: "warn", params: { kind: "faq", status: 502 } });
    expect(H.docs.map((d) => d.metadata.dedupeKey)).toContain("policy:returns");
    expect(H.docs.map((d) => d.metadata.dedupeKey)).not.toContain("faq");
  });

  it("learning nothing at all fails the scan instead of pretending", async () => {
    H.extract = { policies: "down", faq: "down", profile: "down", brand: "down" };
    const { ctx: c } = ctx({ harvest: { platform: null, products: null, policyUrls: [] } });
    await expect(learnStages({ ai })(c as any)).rejects.toMatchObject({ code: "nothing_learned" });
  });

  it("without a feed, product pages are 'sampled' - never a catalogue size", async () => {
    const { ctx: c, events } = ctx({ harvest: { platform: null, products: null, policyUrls: [] } });
    await learnStages({ ai })(c as any);
    const sampled = events.find((e) => e.key === "products.sampled");
    expect(sampled).toMatchObject({ params: { count: 1 } });
    // A sample flag the chip can redraw after a reload - never productCount.
    expect(sampled.patch).toEqual({ found: { productsSampled: 1 } });
    expect(events.some((e) => e.patch?.found?.productCount)).toBe(false);
  });

  it("suggests only the platform and tools the site loads that the catalogue has, with how to connect", async () => {
    H.connected = [{ integrationId: "c-kla" }];
    const { ctx: c, events } = ctx({
      tools: ["klaviyo", "returngo-not-in-catalog"],
      toolsSeen: [{ slug: "klaviyo", evidenceUrl: `${O}/pages/about` }, { slug: "returngo-not-in-catalog", evidenceUrl: null }],
    });
    await learnStages({ ai })(c as any);
    expect(events.find((e) => e.key === "integrations.suggested")).toMatchObject({ params: { count: 2, slugs: "shopify,klaviyo" } });
    const { integrationSuggestions } = await import("../services/onboarding-discover/learn");
    expect(await integrationSuggestions("T")).toEqual([
      { slug: "shopify", name: "Shopify", reason: "platform", connect: { kind: "oauth" }, connected: false },
      { slug: "klaviyo", name: "Klaviyo", reason: "detected_on_site", evidenceUrl: `${O}/pages/about`, connect: { kind: "key" }, connected: true },
    ]);
  });
});

describe("page choice and language", () => {
  it("policies come from policy pages, never product pages; brand starts at home", () => {
    expect(pagesFor("policies", PAGES).map((p) => p.url)).toEqual([`${O}/policies/refund-policy`]);
    expect(pagesFor("brand", PAGES)[0]!.url).toBe(O);
  });
  it("the site's language from <html lang>, or dir=rtl", () => {
    expect(siteLanguage('<html lang="en-US">', "he")).toBe("en");
    expect(siteLanguage('<html dir="rtl">', "en")).toBe("he");
    expect(siteLanguage("<html>", "en")).toBe("en");
  });
});

describe("/learned and its edits", () => {
  beforeEach(async () => { await learnStages({ ai })(ctx().ctx as any); });

  it("reads the structured view with stable ids", async () => {
    const v: any = await readLearned("T");
    expect(v.policies[0]).toMatchObject({ id: "returns", terms: { windowDays: 30 } });
    expect(v.faq[0]).toMatchObject({ id: faqId("מתי המשלוח מגיע?") });
    expect(v.products).toMatchObject({ count: 3, source: "shopify_feed" });
    expect(Object.keys(v.brand)).toHaveLength(12);
  });

  it("a corrected policy term rewrites the document the AI reads", async () => {
    await editLearned("T", { section: "policies", id: "returns", value: { terms: { windowDays: 45 } } }, ai);
    expect(H.docs.find((d) => d.metadata.dedupeKey === "policy:returns").content).toContain("חלון החזרה (ימים): 45");
    expect(H.disc.knowledge.structured.policies[0].terms.windowDays).toBe(45);
  });

  it("removing a policy removes its document", async () => {
    await editLearned("T", { section: "policies", id: "returns", remove: true }, ai);
    expect(H.docs.some((d) => d.metadata.dedupeKey === "policy:returns")).toBe(false);
  });

  it("a question added by hand joins the FAQ document", async () => {
    await editLearned("T", { section: "faq", value: { q: "אפשר לאסוף?", a: "כן, מהחנות" } }, ai);
    expect(H.docs.find((d) => d.metadata.dedupeKey === "faq").content).toContain("אפשר לאסוף?");
  });

  it("an unknown id is NOT_FOUND, and nothing changes", async () => {
    await expect(editLearned("T", { section: "policies", id: "nope", value: {} }, ai)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
