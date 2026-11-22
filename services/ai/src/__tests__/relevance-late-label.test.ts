/**
 * Dev 2026-11-22: the first classification after a restart took 2.8 s, past the inline cap; its result was
 * thrown away and the conversation waited 2 minutes for a label while the bot answered a personal
 * message. A classification the caller stopped waiting for now finishes and writes its label anyway.
 * And a brand-new conversation's first inbound gets the longer wait at the route.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "m", platformPaidScope: { run: (_: any, f: any) => f() } }));
import { relevanceForTurn } from "../services/reply-engine/relevance-gate";

const conv = { id: "c1", tenantId: "t1", channel: "WHATSAPP", customerExternalId: "972500", relevanceCategory: null, relevanceOverriddenBy: null };
const db = { message: { findFirst: async () => ({ direction: "INBOUND" }) }, user: { findMany: async () => [] } };
const label = { category: "personal", confidence: 0.95, reason: "r", source: "model", classifiedAt: new Date().toISOString() };

describe("a timed-out classification still writes its label", () => {
  it("★ past the cap: the turn answers error now, and the label is written when the model answers", async () => {
    let finish!: (v: any) => void;
    const classify = vi.fn(() => new Promise((res) => { finish = res; }));
    const write = vi.fn(async () => undefined);
    const r = await relevanceForTurn({ tenantId: "t1", conversation: conv, history: [{ direction: "INBOUND", body: "hi", createdAt: new Date() }], profile: null, mode: "shadow" }, { classify: classify as any, write, db, timeoutMs: 20 });
    expect(r.source).toBe("error");
    expect(write).not.toHaveBeenCalled();
    finish(label);
    await new Promise((res) => setTimeout(res, 10));
    expect(write).toHaveBeenCalledWith("t1", "c1", label);
  });

  it("in time: written once, as before", async () => {
    const write = vi.fn(async () => undefined);
    const r = await relevanceForTurn({ tenantId: "t1", conversation: conv, history: [], profile: null, mode: "shadow" }, { classify: (async () => label) as any, write, db, timeoutMs: 1000 });
    expect(r).toMatchObject({ source: "model", category: "personal" });
    await new Promise((res) => setTimeout(res, 10));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("a classification that fails (not a timeout) writes nothing later", async () => {
    const write = vi.fn(async () => undefined);
    const r = await relevanceForTurn({ tenantId: "t1", conversation: conv, history: [], profile: null, mode: "shadow" }, { classify: (async () => { throw new Error("model down"); }) as any, write, db, timeoutMs: 1000 });
    expect(r.source).toBe("error");
    await new Promise((res) => setTimeout(res, 10));
    expect(write).not.toHaveBeenCalled();
  });
});

describe("the route's wait", () => {
  it("★ a new conversation's first inbound: 7.7 s; otherwise 2.7 s", async () => {
    vi.resetModules();
    const calls: any[] = [];
    vi.doMock("../workers/relevance/worker", () => ({ processRelevanceJob: vi.fn(async (_j: any, d: any) => { calls.push(d); return { category: "business", confidence: 0.9, source: "model" }; }) }));
    vi.doMock("@chatcenter/shared", async (orig) => ({ ...(await orig<any>()), requireInternalKey: (_q: any, _r: any, n: any) => n() }));
    const { default: router, NEW_CONVERSATION_CLASSIFY_TIMEOUT_MS, INLINE_CLASSIFY_TIMEOUT_MS } = await import("../routes/internal-relevance");
    const a = express(); a.use(express.json()); a.use("/api", router);
    await request(a).post("/api/internal/relevance/classify").send({ tenantId: "t1", conversationId: "c1", newConversation: true });
    await request(a).post("/api/internal/relevance/classify").send({ tenantId: "t1", conversationId: "c1" });
    expect(NEW_CONVERSATION_CLASSIFY_TIMEOUT_MS).toBe(7700);
    expect(calls.map((d) => d.timeoutMs)).toEqual([7700, INLINE_CLASSIFY_TIMEOUT_MS]);
  });
});
