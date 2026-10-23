/**
 * Onboarding extraction keeps only what the pages say (2026-10-23).
 *
 * The model is mocked: these pin what we KEEP from whatever it returns -
 * terms as numbers or null, sources only from pages we gave it, no invented
 * defaults, no wide dashes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ reply: "{}" as string, calls: [] as any[] }));
vi.mock("../services/ai.service", () => ({
  getDefaultModel: () => "test-model",
  generateResponse: async (p: any) => { H.calls.push(p); return { content: H.reply }; },
}));

import { extractOnboarding, normalisePolicies, normaliseFaq, normaliseProfile, normaliseBrand, withoutControlChars } from "../services/onboarding-extract.service";

const PAGES = [{ url: "https://shop.example/policies/refund-policy", text: "Returns within 30 days." }];

beforeEach(() => { H.reply = "{}"; H.calls = []; });

describe("policies", () => {
  it("terms are numbers or null, never a typical value; unknown kinds become 'other'", () => {
    const out = normalisePolicies({
      policies: [
        { kind: "returns", summary: "30 days, unworn.", terms: { windowDays: 30, exchange: { allowed: true, how: "Via the form" } }, sourceUrl: PAGES[0]!.url },
        { kind: "magic", summary: "Something", terms: { windowDays: "14" } },
        { kind: "shipping", summary: "", terms: {} },
      ],
    }, PAGES);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "returns", terms: { windowDays: 30, exchange: { allowed: true, how: "Via the form" }, shipping: null, refund: null, warranty: null }, sourceUrl: PAGES[0]!.url });
    // "14" as a string is not a stated number of days.
    expect(out[1]).toMatchObject({ kind: "other", terms: { windowDays: null } });
  });

  it("a source the model made up is dropped", () => {
    const out = normalisePolicies({ policies: [{ kind: "returns", summary: "x", terms: {}, sourceUrl: "https://elsewhere.example/p" }] }, PAGES);
    expect(out[0]!.sourceUrl).toBeNull();
  });
});

describe("faq", () => {
  it("drops empty and repeated questions and caps at 40", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ q: `Q${i}`, a: "A", sourceUrl: PAGES[0]!.url }));
    const out = normaliseFaq({ faq: [{ q: "Same?", a: "1" }, { q: "same?", a: "2" }, { q: "", a: "x" }, ...many] }, PAGES);
    expect(out[0]).toEqual({ q: "Same?", a: "1", sourceUrl: null });
    expect(out.filter((f) => f.q.toLowerCase() === "same?")).toHaveLength(1);
    expect(out).toHaveLength(40);
  });
});

describe("control characters (a NUL failed a dev scan: Postgres refuses it)", () => {
  const NUL = String.fromCharCode(0);
  it("never reach an answer, a summary or a list; tab and newline stay", () => {
    expect(normaliseFaq({ faq: [{ q: `Ship${NUL}?`, a: `Yes${NUL}\tin 3\ndays` }] }, PAGES)[0]).toMatchObject({ q: "Ship?", a: "Yes\tin 3\ndays" });
    expect(normalisePolicies({ policies: [{ kind: "returns", summary: `30${NUL} days`, terms: {} }] }, PAGES)[0].summary).toBe("30 days");
    expect(normaliseProfile({ profile: {}, contact: { emails: [`a@b.c${NUL}`, NUL] } }).contact.emails).toEqual(["a@b.c"]);
    expect(withoutControlChars(`a${String.fromCharCode(7)}b${String.fromCharCode(127)}c`)).toBe("abc");
  });
});

describe("profile and brand", () => {
  it("a currency must look like one", () => {
    expect(normaliseProfile({ currency: "ILS" }).currency).toBe("ILS");
    expect(normaliseProfile({ currency: "shekels" }).currency).toBeNull();
  });
  it("brand lists are clamped and every field is present", () => {
    const b = normaliseBrand({ brand: { voice: "warm", vocabulary: Array.from({ length: 30 }, (_, i) => `w${i}`) }, employeeName: "Maya" });
    expect(b.brand.vocabulary).toHaveLength(12);
    expect(b.brand.tone).toBeNull();
    expect(b.employeeName).toBe("Maya");
  });
});

describe("the call", () => {
  it("one JSON-mode call per kind, metered by its own type; wide dashes never come back", async () => {
    const EM = String.fromCharCode(0x2014);
    const EN = String.fromCharCode(0x2013);
    H.reply = JSON.stringify({ faq: [{ q: `Hours${EM}when?`, a: `Sun${EN}Thu`, sourceUrl: PAGES[0]!.url }] });
    const r: any = await extractOnboarding({ tenantId: "T", kind: "faq", locale: "he", pages: PAGES });
    expect(H.calls[0]).toMatchObject({ tenantId: "T", responseFormat: { type: "json_object" }, metadata: { type: "onboarding_extract_faq" } });
    expect(H.calls[0].messages[0].content).toContain("Hebrew");
    expect(JSON.stringify(r)).not.toContain(EM);
    expect(JSON.stringify(r)).not.toContain(EN);
    expect(r.faq[0].sourceUrl).toBe(PAGES[0]!.url);
  });

  it("no pages, no call; unparseable output is null, not a guess", async () => {
    expect(await extractOnboarding({ tenantId: "T", kind: "policies", pages: [] })).toBeNull();
    expect(H.calls).toHaveLength(0);
    H.reply = "not json";
    expect(await extractOnboarding({ tenantId: "T", kind: "policies", pages: PAGES })).toBeNull();
  });
});
