/**
 * A readiness score that only moves when something moved (B6, 2026-10-14).
 * Maya scored 34 then 45 with identical input: one call at temperature 0.5
 * invented AND judged the questions. Now:
 *   - the question set is made once and stored, with stable ids
 *   - each run judges that set at temperature 0
 *   - nothing changed: the stored report, no model call, unchanged: true
 *   - knowledge added: the SAME questions are judged again
 *   - role changed (what customers ask): a new set
 *   - answered questions are covered without the judge, and an older answer
 *     joins the set
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  agent: null as any, docs: [] as any[], settings: new Map<string, string>(), calls: [] as any[],
  generated: [] as string[], verdict: (_q: string): string => "none",
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readDurableSetting: async (t: string, k: string) => H.settings.get(`${t}:${k}`) ?? null,
    writeDurableSetting: async (t: string, k: string, v: string) => { H.settings.set(`${t}:${k}`, v); },
    prisma: {
      aIAgent: { findFirst: async (a: any) => (a.where.id === "maya" && a.where.tenantId === "T" ? { ...H.agent } : null) },
      businessProfile: { findUnique: async () => ({ organizationName: "Shop", industry: "retail", businessDescription: "Shoes" }) },
      aIAgentKnowledge: { findMany: async () => [] },
      knowledgeBase: { findMany: async () => [{ id: "kb", name: "Company", scope: "all", isActive: true }] },
      knowledgeDocument: { findMany: async () => H.docs.map((d) => ({ ...d, knowledgeBaseId: "kb" })) },
      agentToolPermission: { findMany: async () => [] },
    },
  };
});
vi.mock("../services/ai.service", () => ({
  generateResponse: vi.fn(async (o: any) => {
    H.calls.push({ type: o.metadata?.type, temperature: o.temperature, effort: o.reasoningEffort, prompt: o.messages[1].content });
    if (o.metadata?.type === "agent_readiness_questions") return { content: JSON.stringify({ questions: H.generated }) };
    // A "full" verdict names the shipping document as its evidence.
    const judgements = [...String(o.messages[1].content).matchAll(/^- \[(q_[0-9a-f]+)\] (.+)$/gm)].map(([, id, text]) => ({
      id, coverage: H.verdict(text), gapType: H.verdict(text) === "full" ? "none" : "knowledge", reason: "r",
      evidence: H.verdict(text) === "none" ? [] : [{ kind: "doc", name: "Shipping" }],
    }));
    return { content: JSON.stringify({ judgements, recommendations: [{ type: "add_faq", title: "Add FAQ", detail: "d" }] }) };
  }),
}));

import { generateReadinessReport, questionIdFor, questionSetKey } from "../services/agent-readiness.service";
import { readinessAnsweredKey } from "../services/readiness-answers";

/** What runAndStoreReadiness does: the report is kept on the employee. */
async function run(opts: any = {}) {
  const r: any = await generateReadinessReport("T", "maya", "en", opts);
  if (!("error" in r)) H.agent.readinessReport = r;
  return r;
}
const types = () => H.calls.map((c) => c.type);

beforeEach(() => {
  H.agent = { id: "maya", name: "Maya", role: "customer_support", goal: "help", successCriteria: "", identity: {}, readinessReport: null, departmentId: null };
  H.docs = [{ id: "d1", title: "Shipping", content: "3-5 days", updatedAt: new Date("2026-10-01") }];
  H.settings = new Map(); H.calls = [];
  H.generated = ["Do you ship to Eilat?", "What sizes do you have?", "Can I return shoes?", "Do you ship to Eilat?"];
  H.verdict = (q) => (q.includes("Eilat") ? "full" : "none");
});

describe("★ the same input gets the same score", () => {
  it("first run: the set is made once (no duplicates), then judged at medium reasoning", async () => {
    const r = await run();
    expect(types()).toEqual(["agent_readiness_questions", "agent_readiness"]);
    expect(H.calls[1].effort).toBe("medium");
    expect(r.questions.map((q: any) => q.question)).toEqual(["Do you ship to Eilat?", "What sizes do you have?", "Can I return shoes?"]);
    expect(r.questions[0].id).toBe(questionIdFor("Do you ship to Eilat?"));
    expect(r.score).toBe(33);
    expect(JSON.parse(H.settings.get(`T:${questionSetKey("maya")}`)!).questions).toHaveLength(3);
  });

  it("★ nothing changed: the stored report, no model call, unchanged: true", async () => {
    const first = await run();
    H.calls = [];
    // Even a judge that would now say otherwise is not asked.
    H.verdict = () => "full";
    const second = await run();
    expect(H.calls).toEqual([]);
    expect(second.unchanged).toBe(true);
    expect(second.score).toBe(first.score);
    expect(second.questions).toEqual(first.questions);
  });

  it("★ knowledge added: the SAME questions judged again, no new set", async () => {
    const first = await run();
    H.calls = [];
    H.docs.push({ id: "d2", title: "Sizes", content: "36-46", updatedAt: new Date("2026-10-14") });
    H.verdict = (q) => (q.includes("Eilat") || q.includes("sizes") ? "full" : "none");
    const second = await run();
    expect(types()).toEqual(["agent_readiness"]);
    expect(second.unchanged).toBeUndefined();
    expect(second.questions.map((q: any) => q.id)).toEqual(first.questions.map((q: any) => q.id));
    expect(second.questionSetGeneratedAt).toBe(first.questionSetGeneratedAt);
    expect(second.score).toBe(67);
  });

  it("a knowledge document edited is a change too", async () => {
    await run();
    H.calls = [];
    H.docs[0].updatedAt = new Date("2026-10-14");
    await run();
    expect(types()).toEqual(["agent_readiness"]);
  });

  it("★ what customers ask changed (the role): a new set", async () => {
    await run();
    H.calls = [];
    H.agent.role = "sales";
    H.generated = ["How much is the premium plan?"];
    const r = await run();
    expect(types()).toEqual(["agent_readiness_questions", "agent_readiness"]);
    expect(r.questions.map((q: any) => q.question)).toEqual(["How much is the premium plan?"]);
  });

  it("asked for fresh questions: a new set even with nothing changed", async () => {
    await run();
    H.calls = [];
    H.generated = ["Brand new question?"];
    const r = await run({ regenerateQuestions: true });
    expect(types()).toEqual(["agent_readiness_questions", "agent_readiness"]);
    expect(r.questions.map((q: any) => q.question)).toEqual(["Brand new question?"]);
  });
});

describe("★ answered questions", () => {
  it("are covered without the judge, and answering one re-judges the rest", async () => {
    const first = await run();
    H.calls = [];
    H.settings.set(`T:${readinessAnsweredKey("maya")}`, JSON.stringify([{ question: "What sizes do you have?", clusterKey: "x", documentId: "doc", answeredAt: "2026-10-14" }]));
    const r = await run();
    expect(types()).toEqual(["agent_readiness"]);
    expect(H.calls[0].prompt).not.toContain("What sizes do you have?");
    const sizes = r.questions.find((q: any) => q.question === "What sizes do you have?");
    expect(sizes).toMatchObject({ id: first.questions[1].id, coverage: "full", answered: true });
    expect(r.score).toBe(67);
  });

  it("★ an answer from before the stable set (or about another question) joins the set", async () => {
    H.settings.set(`T:${readinessAnsweredKey("maya")}`, JSON.stringify([{ question: "Do you have gift cards?", clusterKey: "x", documentId: "doc", answeredAt: "2026-10-13" }]));
    const r = await run();
    expect(r.questions.map((q: any) => q.question)).toContain("Do you have gift cards?");
    expect(JSON.parse(H.settings.get(`T:${questionSetKey("maya")}`)!).questions.map((q: any) => q.question)).toContain("Do you have gift cards?");
    // The question writer is told not to ask it again.
    expect(H.calls[0].prompt).toContain("Do you have gift cards?");
  });

  it("all answered: no judge call at all", async () => {
    H.generated = ["Q one?"];
    H.settings.set(`T:${readinessAnsweredKey("maya")}`, JSON.stringify([{ question: "Q one?", clusterKey: "x", documentId: "doc", answeredAt: "2026-10-14" }]));
    const r = await run();
    expect(types()).toEqual(["agent_readiness_questions"]);
    expect(r.score).toBe(100);
  });
});

it("a question the judge skipped counts as not handled, and says so", async () => {
  const { generateResponse } = await import("../services/ai.service");
  (generateResponse as any).mockImplementationOnce(async () => ({ content: JSON.stringify({ questions: ["A?", "B?"] }) }))
    .mockImplementationOnce(async (o: any) => {
      const [first] = [...String(o.messages[1].content).matchAll(/^- \[(q_[0-9a-f]+)\]/gm)];
      return { content: JSON.stringify({ judgements: [{ id: first![1], coverage: "full", gapType: "none", reason: "ok", evidence: [{ kind: "doc", name: "Shipping" }] }], recommendations: [] }) };
    });
  const r = await run();
  expect(r.questions.map((q: any) => q.coverage)).toEqual(["full", "none"]);
  expect(r.questions[1].reason).toMatch(/did not return a verdict/);
});

describe("★ a verdict counts only with evidence the code can check (B6b)", () => {
  const judgeOnce = async (judgements: (ids: string[]) => any[], questions = ["Where is my order?", "What is your privacy policy?"]) => {
    const { generateResponse } = await import("../services/ai.service");
    (generateResponse as any)
      .mockImplementationOnce(async () => ({ content: JSON.stringify({ questions }) }))
      .mockImplementationOnce(async (o: any) => {
        const ids = [...String(o.messages[1].content).matchAll(/^- \[(q_[0-9a-f]+)\]/gm)].map((m) => m[1]!);
        return { content: JSON.stringify({ judgements: judgements(ids), recommendations: [] }) };
      });
    return run();
  };

  it("★ \"full\" or \"partial\" with nothing real behind it is \"none\" and says so", async () => {
    const r = await judgeOnce((ids) => [
      { id: ids[0], coverage: "partial", gapType: "tool", reason: "hedge", evidence: [] },
      { id: ids[1], coverage: "full", gapType: "none", reason: "made up", evidence: [{ kind: "tool", name: "Refund Everything" }, { kind: "doc", name: "Privacy" }] },
    ]);
    expect(r.questions.map((q: any) => [q.coverage, q.evidence])).toEqual([["none", []], ["none", []]]);
    expect(r.questions[0].gapType).toBe("tool");
    expect(r.questions[1].gapType).toBe("knowledge");
    expect(r.questions[1].reason).toMatch(/No document or tool/);
  });

  it("★ real evidence keeps the verdict, under its exact name (case and spaces forgiven)", async () => {
    H.docs.push({ id: "d9", title: "Privacy Policy", content: "We keep data 30 days", updatedAt: new Date("2026-10-02") });
    const r = await judgeOnce((ids) => [
      { id: ids[0], coverage: "partial", gapType: "data", reason: "order known, ETA not", evidence: [{ kind: "doc", name: " shipping " }, { kind: "doc", name: "Shipping" }] },
      { id: ids[1], coverage: "full", gapType: "none", reason: "ok", evidence: [{ kind: "doc", name: "privacy policy" }, { kind: "tool", name: "Nope" }] },
    ]);
    expect(r.questions[0]).toMatchObject({ coverage: "partial", gapType: "data", evidence: [{ kind: "doc", name: "Shipping" }] });
    expect(r.questions[1]).toMatchObject({ coverage: "full", gapType: "none", evidence: [{ kind: "doc", name: "Privacy Policy" }] });
  });

  it("★ the business description is evidence (kind business), and only when there is one", async () => {
    const r = await judgeOnce((ids) => [
      { id: ids[0], coverage: "full", gapType: "none", reason: "free shipping over 299", evidence: [{ kind: "business", name: "anything" }] },
      { id: ids[1], coverage: "partial", gapType: "knowledge", reason: "x", evidence: [{ kind: "business" }] },
    ]);
    expect(r.questions.map((q: any) => [q.coverage, q.evidence])).toEqual([
      ["full", [{ kind: "business", name: "business" }]],
      ["partial", [{ kind: "business", name: "business" }]],
    ]);
  });

  it("no business description: citing it is not evidence", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const orig = (prisma as any).businessProfile.findUnique;
    (prisma as any).businessProfile.findUnique = async () => ({ organizationName: "Shop", industry: "retail", businessDescription: "" });
    try {
      const r = await judgeOnce((ids) => [{ id: ids[0], coverage: "full", gapType: "none", reason: "x", evidence: [{ kind: "business", name: "business" }] }], ["Where is my order?"]);
      expect(r.questions[0].coverage).toBe("none");
    } finally {
      (prisma as any).businessProfile.findUnique = orig;
    }
  });

  it("the judge is told to name its evidence, and the names it may use are quoted", async () => {
    await run();
    const judge = H.calls.find((c) => c.type === "agent_readiness")!.prompt;
    expect(judge).toContain('- doc "Shipping" [Company]');
    expect(judge).toMatch(/"evidence":\[\{"kind":"doc\|tool\|business"/);
    expect(judge).toContain('do not hedge with "partial"');
  });
});

describe("★ judged in batches of 8", () => {
  it("20 questions: 3 calls of at most 8, every question judged once", async () => {
    const words = ["apples", "boots", "candles", "desks", "engines", "flags", "gloves", "hats", "inks", "jackets", "kettles", "lamps", "mugs", "nails", "ovens", "pens", "quilts", "rugs", "socks", "tents"];
    H.generated = words.map((w) => `Do you sell ${w}?`);
    H.verdict = () => "full";
    const r = await run();
    const judges = H.calls.filter((c) => c.type === "agent_readiness");
    expect(judges).toHaveLength(3);
    const counts = judges.map((c) => [...String(c.prompt).matchAll(/^- \[q_/gm)].length);
    expect(counts).toEqual([8, 8, 4]);
    expect(r.totals).toEqual({ full: 20, partial: 0, none: 0, total: 20 });
    // One recommendation per title across the batches.
    expect(r.recommendations).toEqual([{ type: "add_faq", title: "Add FAQ", detail: "d" }]);
  });
});
