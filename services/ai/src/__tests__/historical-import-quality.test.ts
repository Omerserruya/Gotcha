/**
 * History import quality round (2026-11-18, Omer: Smoovee's 711 unreviewed candidates). Speaker truth, the
 * import model tier, the newest answer, curation that finishes, the one-off filter, the review aids.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("@chatcenter/shared", async (orig) => ({ ...(await orig<any>()), prisma: {} }));

import { speakerOf, renderTranscript } from "../services/historical-intelligence/stage-utils";
import { matchQuote, currentVariant } from "../services/historical-intelligence/knowledge-extraction.stage";
import { mergeVariants } from "../services/historical-intelligence/knowledge-dedupe.stage";
import { oneOffOrFluff } from "../services/historical-intelligence/specificity";
import { judgeAll } from "../services/historical-intelligence/knowledge-curation.stage";
import { getImportModel, importPlatformPaid } from "../services/historical-intelligence/llm";
import { autoApprovable, relevantPassages, DOC_CONFLICT } from "../services/historical-intelligence/knowledge-review.stage";
import { cosine, foldVariant, parseDryRunArgs } from "../scripts/dry-run-import";
import { parseFinishArgs } from "../scripts/finish-curation";
import { laneFeature, platformPaidScope } from "../services/ai.service";
import { NOT_REPLAY_USAGE, AI_MODEL_PRICING } from "@chatcenter/shared";

const at = (d: string) => new Date(`${d}T10:00:00Z`);

describe("1. speaker truth", () => {
  it("★ a person is an email, the phone app or imported history; the bot, the engine and an agent's name are not", () => {
    expect(speakerOf({ direction: "INBOUND" })).toBe("customer");
    expect(speakerOf({ direction: "OUTBOUND", senderName: "AI Bot", origin: "LIVE", metadata: { source: "ai_bot" } })).toBe("bot");
    expect(speakerOf({ direction: "OUTBOUND", senderName: "Maya", origin: "LIVE" })).toBe("bot");
    expect(speakerOf({ direction: "OUTBOUND", senderName: "System", origin: "LIVE" })).toBe("bot");
    expect(speakerOf({ direction: "OUTBOUND", senderName: "dana@shop.co.il", origin: "LIVE" })).toBe("business");
    expect(speakerOf({ direction: "OUTBOUND", senderName: null, origin: "HISTORICAL_IMPORT", metadata: { source: "historical_import" } })).toBe("business");
    expect(speakerOf({ direction: "OUTBOUND", senderName: "smooveee", origin: "LIVE", metadata: { source: "whatsapp_business_app" } })).toBe("business");
  });
  it("★ a text sent verbatim in many conversations is automated, whoever the row says sent it", () => {
    const auto = new Set(["שלום! קיבלנו את פנייתך ונחזור בהקדם"]);
    expect(speakerOf({ direction: "OUTBOUND", body: "שלום!  קיבלנו את פנייתך ונחזור בהקדם", origin: "HISTORICAL_IMPORT" }, auto)).toBe("bot");
    expect(speakerOf({ direction: "OUTBOUND", body: "המשלוח יוצא מחר", origin: "HISTORICAL_IMPORT" }, auto)).toBe("business");
  });
  it("★ bot lines render as Bot:, and the guard never takes a bot line as the answer", () => {
    const t = [
      { direction: "INBOUND" as const, body: "איך מממשים נקודות?", at: at("2026-11-11"), speaker: "customer" as const },
      { direction: "OUTBOUND" as const, body: "הנקודות מתממשות אוטומטית בקופה", at: at("2026-11-11"), speaker: "bot" as const },
      { direction: "OUTBOUND" as const, body: "מזינים את הטלפון בעמוד התשלום", at: at("2026-11-12"), speaker: "business" as const },
    ];
    expect(renderTranscript(t)).toMatch(/Bot: הנקודות/);
    expect(renderTranscript(t)).toMatch(/Business: מזינים/);
    expect(matchQuote(t, "הנקודות מתממשות אוטומטית בקופה", "OUTBOUND")).toBeNull();
    expect(matchQuote(t, "מזינים את הטלפון בעמוד התשלום", "OUTBOUND")?.at).toEqual(at("2026-11-12"));
    expect(matchQuote(t, "איך מממשים נקודות?", "INBOUND")).not.toBeNull();
  });
});

describe("2. the import tier", () => {
  it("★ gpt-6.2-sol unless HISTORICAL_IMPORT_MODEL; platform-paid only when the flag is set", () => {
    expect(getImportModel({} as any)).toBe("gpt-6.2-sol");
    expect(getImportModel({ HISTORICAL_IMPORT_MODEL: "gpt-6-luna" } as any)).toBe("gpt-6-luna");
    expect(importPlatformPaid({} as any)).toBe(false);
    expect(importPlatformPaid({ HISTORICAL_IMPORT_PLATFORM_PAID: "true" } as any)).toBe(true);
    expect(importPlatformPaid({ HISTORICAL_IMPORT_PLATFORM_PAID: "no" } as any)).toBe(false);
  });
  it("★ the import lane is '_import', and tenant figures leave it out; the gpt-6 family is priced", () => {
    expect(platformPaidScope.run({ reason: "historical_import" }, () => laneFeature("historical_knowledge_extraction"))).toBe("historical_knowledge_extraction_import");
    expect(laneFeature("historical_knowledge_extraction")).toBe("historical_knowledge_extraction");
    expect(JSON.stringify(NOT_REPLAY_USAGE)).toContain('"endsWith":"_import"');
    expect(AI_MODEL_PRICING["gpt-6.2-sol"]).toEqual({ prompt: 2, completion: 10, cachedPrompt: 0.1 });
    expect(AI_MODEL_PRICING["gpt-6-luna"]).toEqual({ prompt: 0.1, completion: 0.5, cachedPrompt: 0.01 });
  });
});

describe("3. the newest answer wins", () => {
  it("★ the headline is the most recent person answer, however often the old one was given", () => {
    const v = [
      { key: "n", answer: "איסוף מנשר", occurrenceCount: 9, lastSeenAt: "2026-05-01T00:00:00.000Z" },
      { key: "t", answer: "איסוף מטבעון", occurrenceCount: 1, lastSeenAt: "2026-10-01T00:00:00.000Z" },
    ];
    expect(currentVariant(v)?.answer).toBe("איסוף מטבעון");
    expect(currentVariant([{ key: "a", answer: "a", occurrenceCount: 1 }, { key: "b", answer: "b", occurrenceCount: 4 }])?.answer).toBe("b");
  });
  it("★ dedupe keeps the dates, puts the newest first, and never cuts it at the cap", () => {
    const m = (id: string, variants: any[]) => ({ id, answer: variants[0].answer, editedAnswer: null, occurrenceCount: 1, customerCount: 1, conflict: false, variants, firstSeenAt: null, lastSeenAt: null });
    const out = mergeVariants([
      m("a", [{ key: "1", answer: "one", occurrenceCount: 5, lastSeenAt: "2026-01-01" }, { key: "2", answer: "two", occurrenceCount: 4, lastSeenAt: "2026-02-01" }]),
      m("b", [{ key: "3", answer: "three", occurrenceCount: 3, lastSeenAt: "2026-03-01" }, { key: "4", answer: "four", occurrenceCount: 1, lastSeenAt: "2026-09-01" }]),
    ] as any);
    expect(out.map((v) => v.answer)).toEqual(["four", "three", "two"]);
    expect(out[0].lastSeenAt).toBe("2026-09-01");
    // The same answer in two members: its newest date survives the merge.
    const same = mergeVariants([
      m("a", [{ key: "x", answer: "x", occurrenceCount: 1, lastSeenAt: "2026-01-01" }]),
      m("b", [{ key: "x", answer: "x", occurrenceCount: 1, lastSeenAt: "2026-08-01" }]),
    ] as any);
    expect(same[0]).toMatchObject({ occurrenceCount: 2, lastSeenAt: "2026-08-01" });
  });
  it("the dry run folds the same way", () => {
    const c: any = { answer: "", variants: [], occurrenceCount: 0, customers: new Set(), lastSeenAt: null };
    foldVariant(c, "נשר", at("2026-05-01"), "a");
    foldVariant(c, "נשר", at("2026-05-02"), "b");
    foldVariant(c, "טבעון", at("2026-10-01"), "c");
    expect(c.answer).toBe("טבעון");
    expect(c.occurrenceCount).toBe(3);
    expect(c.customers.size).toBe(3);
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
});

describe("4. curation always finishes", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, question: "q", answer: "a", topic: "t", occurrenceCount: 1 }));
  const keep = (xs: any[]) => ({ verdicts: xs.map((x) => ({ id: x.id, verdict: "keep" as const })) });
  it("★ a failed batch is retried, then split, until every item has a verdict", async () => {
    let calls = 0;
    const call = vi.fn(async (xs: any[]) => { calls++; return xs.length > 2 ? null : keep(xs); });
    const out = await judgeAll(items, call);
    expect([...out.values()].every((v) => v?.verdict === "keep")).toBe(true);
    expect(out.size).toBe(5);
    expect(call.mock.calls[0][0]).toHaveLength(5);
    expect(call.mock.calls[1][0]).toHaveLength(5);
  });
  it("★ ids the model left out are judged again; an item no call can judge is null (unjudged)", async () => {
    const call = vi.fn(async (xs: any[]) => (xs.some((x) => x.id === "c4") && xs.length === 1 ? null : keep(xs.filter((x) => x.id !== "c2" || xs.length === 1).filter((x) => x.id !== "c4"))));
    const out = await judgeAll(items, call);
    expect(out.get("c2")?.verdict).toBe("keep");
    expect(out.get("c4")).toBeNull();
    expect(out.size).toBe(5);
  });
});

describe("5. one-offs and fluff", () => {
  it("★ a customer's code, an order by number, a named greeting with nothing else, a pleasantry", () => {
    expect(oneOffOrFluff({ question: "יש קוד?", answer: "הקוד שלך הוא SMV2024 להנחה" })).toBe(true);
    expect(oneOffOrFluff({ question: "מה עם ההזמנה?", answer: "הזמנה 4521 יצאה היום" })).toBe(true);
    expect(oneOffOrFluff({ question: "שאלה", answer: "היי דנה, תודה!" })).toBe(true);
    expect(oneOffOrFluff({ question: "שאלה", answer: "היי דנה, אשמח מאוד" })).toBe(true);
    expect(oneOffOrFluff({ question: "איפה?", answer: "איזה יופי ששאלת" })).toBe(true);
    expect(oneOffOrFluff({ question: "יש משלוח?", answer: "כן, יש משלוחים לכל הארץ" })).toBe(false);
    expect(oneOffOrFluff({ question: "קופון?", answer: "קוד הקופון לחברי מועדון מופיע במייל" })).toBe(false);
    expect(oneOffOrFluff({ question: "כמה זמן?", answer: "היי דנה, המשלוח לוקח 3 ימי עסקים" })).toBe(false);
  });
});

describe("6 and 7. review aids", () => {
  it("★ auto-approve per candidate: a person's, 3+, no UNRESOLVED conflict, no doc conflict, kept or rewritten, no live data", () => {
    const ok = { humanSourced: true, occurrenceCount: 3, conflict: false, curationVerdict: "kept", curationNote: null, requiresLiveLookup: false };
    expect(autoApprovable(ok)).toBe(true);
    expect(autoApprovable({ ...ok, humanSourced: false })).toBe(false);
    expect(autoApprovable({ ...ok, occurrenceCount: 2 })).toBe(false);
    expect(autoApprovable({ ...ok, conflict: true })).toBe(false);
    // Settled by the newest answer (a clean switch): not blocking.
    const switched = [{ answer: "נשר", firstSeenAt: "2026-01-01", lastSeenAt: "2026-05-01" }, { answer: "טבעון", firstSeenAt: "2026-06-01", lastSeenAt: "2026-10-01" }];
    expect(autoApprovable({ ...ok, conflict: true, variants: switched })).toBe(true);
    // Still alternating: blocking.
    const alternating = [{ answer: "נשר", firstSeenAt: "2026-01-01", lastSeenAt: "2026-09-01" }, { answer: "טבעון", firstSeenAt: "2026-06-01", lastSeenAt: "2026-10-01" }];
    expect(autoApprovable({ ...ok, conflict: true, variants: alternating })).toBe(false);
    expect(autoApprovable({ ...ok, conflict: true, variants: [{ answer: "a" }, { answer: "b" }] })).toBe(false);
    expect(autoApprovable({ ...ok, curationNote: `${DOC_CONFLICT} price differs` })).toBe(false);
    expect(autoApprovable({ ...ok, curationVerdict: "rewritten" })).toBe(true);
    expect(autoApprovable({ ...ok, curationVerdict: "unjudged" })).toBe(false);
    expect(autoApprovable({ ...ok, requiresLiveLookup: true })).toBe(false);
  });
  it("the passages sent along share words with the question", () => {
    const docs = [{ title: "תקנון", content: "משלוחים יוצאים תוך שלושה ימי עסקים לכל הארץ.\n\nהחזרות מתקבלות תוך ארבעה עשר יום." }];
    const p = relevantPassages("תוך כמה ימים יוצאים משלוחים?", "שלושה ימים", docs);
    expect(p).toHaveLength(1);
    expect(p[0].text).toMatch(/משלוחים/);
  });
});

describe("scripts", () => {
  it("dry run and finish-curation args", () => {
    expect(parseDryRunArgs(["--import", "imp1"])).toEqual({ importId: "imp1", out: "/tmp/dry-run-import-imp1.json", limit: null });
    expect(parseDryRunArgs(["--import", "imp1", "--limit", "20", "--out", "/x.json"])).toEqual({ importId: "imp1", out: "/x.json", limit: 20 });
    expect(() => parseDryRunArgs([])).toThrow(/usage/);
    expect(() => parseDryRunArgs(["--import", "i", "--limit", "0"])).toThrow(/limit/);
    expect(parseFinishArgs(["--import", "imp1"])).toEqual({ importId: "imp1", review: true });
    expect(parseFinishArgs(["--import", "imp1", "--no-review"]).review).toBe(false);
  });
});
