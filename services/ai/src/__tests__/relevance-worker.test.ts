/**
 * Labels for every conversation (2026-11-17): the async job, the per-tenant switch, the debounce, and the
 * gate's use of a stored label when the job covers the tenant.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "m", platformPaidScope: { run: (_: any, f: any) => f() } }));
import { relevanceClassifyEnabled, enqueueRelevanceClassification, RELEVANCE_DEBOUNCE_MS } from "@chatcenter/shared";
import { processRelevanceJob } from "../workers/relevance/worker";
import { relevanceForTurn } from "../services/reply-engine/relevance-gate";

const ORIG = process.env.RELEVANCE_CLASSIFY_TENANTS;
afterEach(() => { if (ORIG === undefined) delete process.env.RELEVANCE_CLASSIFY_TENANTS; else process.env.RELEVANCE_CLASSIFY_TENANTS = ORIG; });

const now = new Date("2026-11-17T12:00:00Z");
const label = (category: any, confidence: number) => ({ category, confidence, reason: "r", source: "model" as const, classifiedAt: now.toISOString() });
const conv = (o: any = {}) => ({ id: "c1", tenantId: "t1", channel: "WHATSAPP", customerExternalId: "972500", relevanceCategory: null, relevanceOverriddenBy: null, ...o });
const db = (c: any) => ({
  conversation: { findFirst: async () => c },
  message: { findMany: async () => [{ direction: "INBOUND", body: "hi", createdAt: new Date("2026-11-17T11:59:00Z") }], findFirst: async () => ({ direction: "INBOUND" }) },
  user: { findMany: async () => [] },
});

describe("relevance for every conversation", () => {
  it("★ the per-tenant switch: empty is none, * is all, else the listed ids", () => {
    expect(relevanceClassifyEnabled("t1", {})).toBe(false);
    expect(relevanceClassifyEnabled("t1", { RELEVANCE_CLASSIFY_TENANTS: "" })).toBe(false);
    expect(relevanceClassifyEnabled("t1", { RELEVANCE_CLASSIFY_TENANTS: "*" })).toBe(true);
    expect(relevanceClassifyEnabled("t1", { RELEVANCE_CLASSIFY_TENANTS: "t0, t1" })).toBe(true);
    expect(relevanceClassifyEnabled("t2", { RELEVANCE_CLASSIFY_TENANTS: "t0,t1" })).toBe(false);
  });

  it("★ enqueue: one job per conversation (its id), delayed 2 minutes, removed when done; nothing when off", async () => {
    const add = vi.fn(async () => undefined);
    process.env.RELEVANCE_CLASSIFY_TENANTS = "";
    expect(await enqueueRelevanceClassification("t1", "c1", { add })).toBe(false);
    expect(add).not.toHaveBeenCalled();
    process.env.RELEVANCE_CLASSIFY_TENANTS = "t1";
    expect(await enqueueRelevanceClassification("t1", "c1", { add })).toBe(true);
    expect(add).toHaveBeenCalledWith("classify", { tenantId: "t1", conversationId: "c1" }, expect.objectContaining({ jobId: "classify-relevance-c1", delay: RELEVANCE_DEBOUNCE_MS, removeOnComplete: true, removeOnFail: true }));
    expect(RELEVANCE_DEBOUNCE_MS).toBe(120_000);
    // An enqueue failure never throws into the inbound path.
    expect(await enqueueRelevanceClassification("t1", "c1", { add: async () => { throw new Error("redis"); } })).toBe(false);
  });

  it("★ the job labels and writes through the route, whoever handles the conversation", async () => {
    process.env.RELEVANCE_CLASSIFY_TENANTS = "*";
    const write = vi.fn(async () => undefined);
    const r = await processRelevanceJob({ tenantId: "t1", conversationId: "c1" }, { db: db(conv({ handledBy: "human" })), classify: (async () => label("personal", 0.9)) as any, write, company: async () => null as any, now: () => now });
    expect(r).toMatchObject({ category: "personal", mode: "shadow" });
    expect(write).toHaveBeenCalledWith("t1", "c1", expect.objectContaining({ category: "personal" }));
  });

  it("★ the job never touches an override, a disabled tenant, or a rehearsal", async () => {
    const classify = vi.fn(async () => label("personal", 0.9));
    process.env.RELEVANCE_CLASSIFY_TENANTS = "*";
    const o = await processRelevanceJob({ tenantId: "t1", conversationId: "c1" }, { db: db(conv({ relevanceCategory: "business", relevanceOverriddenBy: "u1" })), classify: classify as any, company: async () => null as any, now: () => now });
    expect(o?.source).toBe("override");
    expect(await processRelevanceJob({ tenantId: "t1", conversationId: "c1" }, { db: db(conv({ customerExternalId: "sandbox:x" })), classify: classify as any, company: async () => null as any })).toBeNull();
    process.env.RELEVANCE_CLASSIFY_TENANTS = "other";
    expect(await processRelevanceJob({ tenantId: "t1", conversationId: "c1" }, { db: db(conv()), classify: classify as any, company: async () => null as any })).toBeNull();
    expect(classify).not.toHaveBeenCalled();
  });

  it("★ the gate uses a stored label when the job covers the tenant; classifies inline only when there is none", async () => {
    const classify = vi.fn(async () => label("business", 0.9));
    const hist = [{ direction: "INBOUND", body: "hi", createdAt: new Date("2026-11-17T11:59:00Z") }];
    const stale = conv({ relevanceCategory: "personal", relevanceConfidence: 0.5, relevanceClassifiedAt: new Date("2026-11-16T00:00:00Z") });
    const used = await relevanceForTurn({ tenantId: "t1", conversation: stale, history: hist, profile: null, mode: "on", preferStored: true }, { classify: classify as any, db: db(stale), write: async () => undefined, now: () => now });
    expect(used).toMatchObject({ source: "stored", category: "personal" });
    expect(classify).not.toHaveBeenCalled();
    const none = await relevanceForTurn({ tenantId: "t1", conversation: conv(), history: hist, profile: null, mode: "on", preferStored: true }, { classify: classify as any, db: db(conv()), write: async () => undefined, now: () => now });
    expect(none.source).toBe("model");
    // Without the job, a stale unsure label is classified again.
    await relevanceForTurn({ tenantId: "t1", conversation: stale, history: hist, profile: null, mode: "on" }, { classify: classify as any, db: db(stale), write: async () => undefined, now: () => now });
    expect(classify).toHaveBeenCalledTimes(2);
  });
});
