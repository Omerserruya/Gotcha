/**
 * Relevance in Gate 1 (2026-11-17): off by default, shadow only records, on holds the AI back.
 * A person's override wins over every rule; an error answers as today.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("@chatcenter/shared", () => ({ prisma: {}, getInternalServiceKey: () => "k" }));
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "m", platformPaidScope: { run: (_: any, f: any) => f() } }));
import { relevanceGateMode, relevanceForTurn, holdsBack, GATE_CONFIDENCE } from "../services/reply-engine/relevance-gate";

const now = new Date("2026-11-17T12:00:00Z");
const db = { user: { findMany: async () => [] }, message: { findFirst: async () => ({ direction: "INBOUND" }) } };
const conv = (o: any = {}) => ({ id: "c1", channel: "WHATSAPP", customerExternalId: "972500", relevanceCategory: null, relevanceConfidence: null, relevanceClassifiedAt: null, relevanceOverriddenBy: null, ...o });
const hist = [{ direction: "INBOUND", body: "hi", createdAt: new Date("2026-11-17T11:59:00Z") }];
const label = (category: any, confidence: number) => ({ category, confidence, reason: "r", source: "model" as const, classifiedAt: now.toISOString() });

describe("relevance gate", () => {
  it("★ off unless RELEVANCE_GATE is shadow or on; off runs nothing", async () => {
    expect(relevanceGateMode({})).toBe("off");
    expect(relevanceGateMode({ RELEVANCE_GATE: "yes" })).toBe("off");
    expect(relevanceGateMode({ RELEVANCE_GATE: "Shadow" })).toBe("shadow");
    expect(relevanceGateMode({ RELEVANCE_GATE: "on" })).toBe("on");
    const classify = vi.fn();
    const r = await relevanceForTurn({ tenantId: "t", conversation: conv(), history: hist, profile: null, mode: "off" }, { classify: classify as any, db, now: () => now });
    expect(r.hold).toBe(false);
    expect(classify).not.toHaveBeenCalled();
  });

  it("★ the override wins over every rule, with no model call", async () => {
    const classify = vi.fn();
    const biz = await relevanceForTurn({ tenantId: "t", conversation: conv({ relevanceCategory: "business", relevanceOverriddenBy: "u1" }), history: hist, profile: null, mode: "on" }, { classify: classify as any, db, now: () => now });
    expect(biz).toMatchObject({ source: "override", hold: false });
    const per = await relevanceForTurn({ tenantId: "t", conversation: conv({ relevanceCategory: "personal", relevanceConfidence: 0.1, relevanceOverriddenBy: "u1" }), history: hist, profile: null, mode: "on" }, { classify: classify as any, db, now: () => now });
    expect(per.hold).toBe(true);
    expect(classify).not.toHaveBeenCalled();
  });

  it("★ a fresh label is classified, written back, and holds at 0.7", async () => {
    const write = vi.fn(async () => undefined);
    const r = await relevanceForTurn({ tenantId: "t", conversation: conv(), history: hist, profile: null, mode: "on" }, { classify: (async () => label("auto_reply", 0.9)) as any, write, db, now: () => now });
    expect(r).toMatchObject({ category: "auto_reply", hold: true, source: "model" });
    expect(write).toHaveBeenCalledWith("t", "c1", expect.objectContaining({ category: "auto_reply" }));
    const low = await relevanceForTurn({ tenantId: "t", conversation: conv(), history: hist, profile: null, mode: "on" }, { classify: (async () => label("personal", 0.6)) as any, write, db, now: () => now });
    expect(low.hold).toBe(false);
  });

  it("★ a stored label that is still good is used without a call", async () => {
    const classify = vi.fn();
    const r = await relevanceForTurn({ tenantId: "t", conversation: conv({ relevanceCategory: "reply_to_outbound", relevanceConfidence: 0.95, relevanceClassifiedAt: new Date("2026-11-17T11:59:30Z") }), history: hist, profile: null, mode: "on" }, { classify: classify as any, db, now: () => now });
    expect(r).toMatchObject({ source: "stored", hold: true });
    expect(classify).not.toHaveBeenCalled();
  });

  it("★ an error or a timeout answers as today", async () => {
    const err = await relevanceForTurn({ tenantId: "t", conversation: conv(), history: hist, profile: null, mode: "on" }, { classify: (async () => { throw new Error("x"); }) as any, db, now: () => now });
    expect(err).toMatchObject({ hold: false, source: "error" });
    const slow = await relevanceForTurn({ tenantId: "t", conversation: conv(), history: hist, profile: null, mode: "on" }, { classify: (() => new Promise(() => {})) as any, db, now: () => now, timeoutMs: 20 });
    expect(slow.hold).toBe(false);
  });

  it("business and unclear never hold; reply_to_outbound and the silencing labels do", () => {
    expect(GATE_CONFIDENCE).toBe(0.7);
    for (const c of ["business", "unclear", null]) expect(holdsBack(c, 1, false)).toBe(false);
    for (const c of ["personal", "notice", "marketing", "auto_reply", "internal", "reply_to_outbound"]) expect(holdsBack(c, 0.7, false)).toBe(true);
    expect(holdsBack("personal", 0.69, false)).toBe(false);
  });
});
