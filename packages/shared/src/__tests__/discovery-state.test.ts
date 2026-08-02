/**
 * Discovery State domain logic - the deterministic backbone that changes
 * planner behavior. Uses an in-memory prisma stub so the precedence/supersede/
 * readiness/re-ask semantics are proven without a DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory tables.
const db = vi.hoisted(() => ({
  sessions: [] as any[],
  facts: [] as any[],
  questions: [] as any[],
  actions: [] as any[],
  seq: 0,
}));
const id = () => `id_${++db.seq}`;

function matchWhere(row: any, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v && typeof v === "object" && "in" in (v as any)) {
      if (!(v as any).in.includes(row[k])) return false;
    } else if (v && typeof v === "object" && "not" in (v as any)) {
      if (row[k] === (v as any).not) return false;
    } else if (row[k] !== v) return false;
  }
  return true;
}

const prismaMock = vi.hoisted(() => ({
  discoverySession: {
    findFirst: vi.fn(async ({ where }: any) => db.sessions.filter((s) => matchWhere(s, where)).slice(-1)[0] ?? null),
    create: vi.fn(async ({ data }: any) => { const r = { id: id(), version: 0, status: "active", startedAt: new Date(), ...data }; db.sessions.push(r); return r; }),
    update: vi.fn(async ({ where, data }: any) => { const s = db.sessions.find((x) => x.id === where.id); if (data.version?.increment) s.version += data.version.increment; Object.assign(s, Object.fromEntries(Object.entries(data).filter(([k]) => k !== "version"))); return s; }),
  },
  discoveryFact: {
    findMany: vi.fn(async ({ where }: any) => db.facts.filter((f) => matchWhere(f, where)).sort((a, b) => a._i - b._i)),
    create: vi.fn(async ({ data }: any) => { const r = { id: id(), _i: db.seq, ...data }; db.facts.push(r); return r; }),
    update: vi.fn(async ({ where, data }: any) => { const f = db.facts.find((x) => x.id === where.id); Object.assign(f, data); return f; }),
  },
  discoveryQuestion: {
    findFirst: vi.fn(async ({ where }: any) => db.questions.filter((q) => matchWhere(q, where)).slice(-1)[0] ?? null),
    create: vi.fn(async ({ data }: any) => { const r = { id: id(), ...data }; db.questions.push(r); return r; }),
    update: vi.fn(async ({ where, data }: any) => { const q = db.questions.find((x) => x.id === where.id); if (data.attemptCount?.increment) q.attemptCount += data.attemptCount.increment; Object.assign(q, Object.fromEntries(Object.entries(data).filter(([k]) => k !== "attemptCount"))); return q; }),
    updateMany: vi.fn(async ({ where, data }: any) => { let n = 0; for (const q of db.questions) if (matchWhere(q, where)) { Object.assign(q, data); n++; } return { count: n }; }),
  },
  discoveryActionAttempt: { create: vi.fn(async ({ data }: any) => { const r = { id: id(), ...data }; db.actions.push(r); return r; }) },
}));

vi.mock("../lib/prisma", () => ({ prisma: prismaMock }));

import {
  getOrCreateActiveSession, applyExtractedFacts, computeReadiness,
  shouldBlockQuestion, recordQuestionAsked, markAnswered, activeFacts,
} from "../lib/discovery-state";
import { PRODUCT_RECOMMENDATION_PROFILE as P } from "../lib/discovery-profiles";

async function session(tenant = "tA", conv = "c1") {
  return getOrCreateActiveSession({ tenantId: tenant, conversationId: conv, goalKey: "product_recommendation" });
}

beforeEach(() => { db.sessions = []; db.facts = []; db.questions = []; db.actions = []; db.seq = 0; vi.clearAllMocks(); });

describe("facts persistence & precedence", () => {
  it("1. explicit customer facts persist", async () => {
    const s = await session();
    await applyExtractedFacts({ session: s, profile: P, facts: [
      { key: "height", value: 171, source: "customer_explicit" },
      { key: "budget", value: { target: 700, currency: "USD" }, source: "customer_explicit" },
    ] });
    const have = await activeFacts(s.id);
    expect(have.get("height_cm")!.valueJson).toBe(171);
    expect(have.get("budget")!.valueJson).toEqual({ target: 700, currency: "USD" });
  });

  it("3. corrections supersede and keep history", async () => {
    const s = await session();
    await applyExtractedFacts({ session: s, profile: P, facts: [{ key: "budget", value: 700, source: "customer_explicit" }] });
    await applyExtractedFacts({ session: s, profile: P, facts: [{ key: "budget", value: 850, source: "customer_explicit", isCorrection: true }] });
    const have = await activeFacts(s.id);
    expect(have.get("budget")!.valueJson).toBe(850);
    expect(have.get("budget")!.source).toBe("customer_correction");
    const superseded = db.facts.filter((f) => f.normalizedKey === "budget" && f.status === "superseded");
    expect(superseded).toHaveLength(1);
    expect(superseded[0].valueJson).toBe(700);
    // the new fact references the old
    expect(have.get("budget")!.supersedesFactId).toBe(superseded[0].id);
  });

  it("4/5. model inference cannot override an explicit fact; provider can", async () => {
    const s = await session();
    await applyExtractedFacts({ session: s, profile: P, facts: [{ key: "riding_style", value: "all_mountain", source: "customer_explicit" }] });
    await applyExtractedFacts({ session: s, profile: P, facts: [{ key: "riding_style", value: "freeride", source: "model_inference" }] });
    expect((await activeFacts(s.id)).get("riding_style")!.valueJson).toBe("all_mountain");
    await applyExtractedFacts({ session: s, profile: P, facts: [{ key: "riding_style", value: "park", source: "provider" }] });
    expect((await activeFacts(s.id)).get("riding_style")!.valueJson).toBe("park");
  });

  it("rejects unknown/foreign keys (no model-invented envelope)", async () => {
    const s = await session();
    const r = await applyExtractedFacts({ session: s, profile: P, facts: [{ key: "SYSTEM_OVERRIDE", value: "x", source: "model_inference" }] });
    expect(r.written).toEqual([]);
  });

  it("normalizes multilingual/alias keys to the canonical key", async () => {
    const s = await session();
    await applyExtractedFacts({ session: s, profile: P, facts: [
      { key: "גובה", value: 171, source: "customer_explicit" },
      { key: "קטגוריה", value: "snowboard", source: "customer_explicit" },
    ] });
    const have = await activeFacts(s.id);
    expect(have.get("height_cm")!.valueJson).toBe(171);
    expect(have.get("product_category")!.valueJson).toBe("snowboard");
  });
});

describe("readiness (10/11 - optional never blocks)", () => {
  it("not ready until the 3 required facts exist", async () => {
    const s = await session();
    await applyExtractedFacts({ session: s, profile: P, facts: [{ key: "product_category", value: "snowboard", source: "customer_explicit" }] });
    let r = await computeReadiness(s, P);
    expect(r.ready).toBe(false);
    expect(r.missingRequired.sort()).toEqual(["budget", "riding_style"]);
    await applyExtractedFacts({ session: s, profile: P, facts: [
      { key: "budget", value: 700, source: "customer_explicit" },
      { key: "riding_style", value: "all_mountain", source: "customer_explicit" },
    ] });
    r = await computeReadiness(s, P);
    expect(r.ready).toBe(true);
    expect(r.nextAction).toEqual({ type: "execute_tool", tool: "shopify.search_products" });
  });

  it("11. boot size (optional) missing does NOT block readiness", async () => {
    const s = await session();
    await applyExtractedFacts({ session: s, profile: P, facts: [
      { key: "product_category", value: "snowboard", source: "customer_explicit" },
      { key: "budget", value: 700, source: "customer_explicit" },
      { key: "riding_style", value: "all_mountain", source: "customer_explicit" },
    ] });
    const r = await computeReadiness(s, P);
    expect(r.ready).toBe(true);
    expect(r.missingOptional).toContain("boot_size");
  });
});

describe("questions & re-ask gate (6/7)", () => {
  it("6. asked/answered questions persist", async () => {
    const s = await session();
    await recordQuestionAsked({ session: s, requirementKey: "flex", askedMessageId: "m1" });
    expect(db.questions.find((q) => q.normalizedQuestionKey === "flex")!.status).toBe("asked");
    await applyExtractedFacts({ session: s, profile: P, facts: [{ key: "flex", value: "medium", source: "customer_explicit" }] });
    await markAnswered({ session: s, answeredKeys: ["flex"], answeredMessageId: "m2" });
    expect(db.questions.find((q) => q.normalizedQuestionKey === "flex")!.status).toBe("answered");
  });

  it("7. an answered semantic question is blocked from being re-asked", async () => {
    const s = await session();
    await applyExtractedFacts({ session: s, profile: P, facts: [{ key: "flex", value: "medium", source: "customer_explicit" }] });
    await recordQuestionAsked({ session: s, requirementKey: "flex" });
    await markAnswered({ session: s, answeredKeys: ["flex"] });
    const gate = await shouldBlockQuestion({ session: s, profile: P, requirementKey: "flex" });
    expect(gate.block).toBe(true);
  });

  it("re-ask blocked when an active explicit answer exists (even without a question row)", async () => {
    const s = await session();
    await applyExtractedFacts({ session: s, profile: P, facts: [{ key: "availability", value: "both", source: "customer_explicit" }] });
    expect((await shouldBlockQuestion({ session: s, profile: P, requirementKey: "זמינות" })).block).toBe(true);
  });

  it("8. optional question blocked once the action is ready", async () => {
    const s = await session();
    await applyExtractedFacts({ session: s, profile: P, facts: [
      { key: "product_category", value: "snowboard", source: "customer_explicit" },
      { key: "budget", value: 700, source: "customer_explicit" },
      { key: "riding_style", value: "all_mountain", source: "customer_explicit" },
    ] });
    const gate = await shouldBlockQuestion({ session: s, profile: P, requirementKey: "boot_size" });
    expect(gate.block).toBe(true);
    expect(gate.reason).toBe("optional_and_action_ready");
  });
});

describe("isolation (12/13)", () => {
  it("12/13. sessions are keyed by tenant + conversation", async () => {
    const a = await getOrCreateActiveSession({ tenantId: "tA", conversationId: "c1", goalKey: "product_recommendation" });
    const b = await getOrCreateActiveSession({ tenantId: "tB", conversationId: "c1", goalKey: "product_recommendation" });
    const c = await getOrCreateActiveSession({ tenantId: "tA", conversationId: "c2", goalKey: "product_recommendation" });
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(c.id);
    await applyExtractedFacts({ session: a, profile: P, facts: [{ key: "budget", value: 700, source: "customer_explicit" }] });
    expect((await activeFacts(b.id)).size).toBe(0); // tenant B unaffected
  });

  it("reuses the one active session for the same key", async () => {
    const a = await session();
    const again = await session();
    expect(again.id).toBe(a.id);
  });
});
