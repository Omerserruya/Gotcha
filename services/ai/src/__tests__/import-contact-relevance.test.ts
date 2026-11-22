/**
 * The history import marks each contact personal or business (2026-11-22): historical-intelligence
 * relevance.stage. A mixed contact is never personal; a person's mark is copied as it is; the verdict is
 * written as source "import" through the conversation service. No model is reached: the classifier is a
 * double.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ events: [] as any[] }));
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "m", platformPaidScope: { run: (_: any, f: any) => f() } }));
vi.mock("../services/historical-intelligence/stage-utils", async (orig) => ({
  ...(await orig<any>()),
  recordEvent: async (...a: any[]) => { H.events.push(a); },
}));

import { windowsOf, importVerdict, runRelevanceStage, PERSONAL_MIN, IMPORT_WINDOW } from "../services/historical-intelligence/relevance.stage";

const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ direction: i % 2 ? "OUTBOUND" : "INBOUND", body: `m${i}`, createdAt: new Date(2026, 0, 1, 0, i), messageType: "text" }));
const lab = (category: string, confidence = 0.95) => ({ category, confidence, reason: "r", source: "model", classifiedAt: "x" }) as any;

describe("the windows and the verdict", () => {
  it("one window for 12 or fewer; the earliest, middle and latest 12 for a long history", () => {
    expect(IMPORT_WINDOW).toBe(12);
    expect(windowsOf(msgs(0))).toEqual([]);
    expect(windowsOf(msgs(12))).toHaveLength(1);
    const w = windowsOf(msgs(100));
    expect(w.map((x) => [x[0]!.body, x.length])).toEqual([["m0", 12], ["m44", 12], ["m88", 12]]);
  });

  it("★ personal only when every window is personal at 0.8 or more; mixed is business", () => {
    expect(PERSONAL_MIN).toBe(0.8);
    expect(importVerdict([lab("personal", 0.9), lab("personal", 0.85), lab("personal", 0.99)])).toMatchObject({ category: "personal", confidence: 0.85 });
    expect(importVerdict([lab("personal"), lab("business"), lab("personal")])).toMatchObject({ category: "business", reason: expect.stringContaining("mixed") });
    expect(importVerdict([lab("personal", 0.79)])).toMatchObject({ category: "business" });
    expect(importVerdict([lab("unclear", 0)])).toMatchObject({ category: "business" });
    expect(importVerdict([])).toMatchObject({ category: "business" });
  });
});

describe("the stage", () => {
  let customers: any[]; let hand: any; let history: Record<string, any[]>; let writes: any[]; let classify: any; let writeOk: boolean;
  const db: any = () => ({
    historicalCustomer: { findMany: async (a: any) => { db.lastWhere = a.where; return customers; } },
    conversation: { findFirst: async (a: any) => { db.handWhere = a.where; return hand; } },
    message: { findMany: async (a: any) => history[a.where.conversationId] ?? [] },
    user: { findMany: async () => [] },
  }) as any;
  (db as any).lastWhere = null; (db as any).handWhere = null;
  const run = () => runRelevanceStage({ tenantId: "T", importId: "imp1" }, {
    db: db(), classify, profile: async () => null, now: () => new Date("2026-11-22T20:00:00Z"),
    write: (async (t: string, c: string, v: any) => { writes.push([t, c, v.category]); return writeOk; }) as any,
  });
  beforeEach(() => {
    H.events = []; writes = []; hand = null; writeOk = true;
    customers = [{ id: "h1", conversationId: "cv1", externalId: "972501111111" }];
    history = { cv1: msgs(40) };
    classify = vi.fn(async () => lab("personal"));
  });

  it("★ every window personal: marked personal (3 calls), written for this contact's imported conversation", async () => {
    const r = await run();
    expect(classify).toHaveBeenCalledTimes(3);
    expect(writes).toEqual([["T", "cv1", "personal"]]);
    expect(r).toMatchObject({ done: false, marked: { personal: 1, business: 0 } });
    expect((db as any).lastWhere).toMatchObject({ importId: "imp1", tenantId: "T", conversation: { is: { relevanceClassifiedAt: null } } });
  });

  it("★ the first window business: business, and no more model calls", async () => {
    classify = vi.fn(async () => lab("business"));
    await run();
    expect(classify).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([["T", "cv1", "business"]]);
  });

  it("personal, then business (a friend who also bought): business", async () => {
    classify = vi.fn().mockResolvedValueOnce(lab("personal")).mockResolvedValueOnce(lab("business"));
    await run();
    expect(writes[0][2]).toBe("business");
  });

  it("★ a person's mark on the sender is copied, with no model call, both ways", async () => {
    hand = { relevanceCategory: "business" };
    await run();
    expect(classify).not.toHaveBeenCalled();
    expect(writes[0][2]).toBe("business");
    expect((db as any).handWhere).toMatchObject({ tenantId: "T", relevanceSource: "override", customerExternalId: { in: ["972501111111", "+972501111111"] }, origin: { in: ["LIVE", "HISTORICAL_IMPORT"] } });
    writes = []; hand = { relevanceCategory: "personal" };
    await run();
    expect(writes[0][2]).toBe("personal");
  });

  it("nothing left: the stage is done", async () => {
    customers = [];
    expect(await run()).toMatchObject({ done: true });
  });

  it("★ nothing could be written (the conversation service down): the stage ends instead of looping", async () => {
    writeOk = false;
    expect(await run()).toMatchObject({ ok: false, done: true });
    expect(H.events.at(-1)).toEqual(expect.arrayContaining(["imp1", "CONTACT_RELEVANCE", "FAILED"]));
  });

  it("one contact's failure does not stop the others", async () => {
    customers = [{ id: "h1", conversationId: "cv1", externalId: "9725011" }, { id: "h2", conversationId: "cv2", externalId: "9725022" }];
    history = { cv1: msgs(5), cv2: msgs(5) };
    classify = vi.fn().mockRejectedValueOnce(new Error("model down")).mockResolvedValue(lab("business"));
    await run();
    expect(writes).toHaveLength(1);
  });
});
