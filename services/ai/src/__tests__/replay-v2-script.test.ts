/** The replay script's plan: which turns, cut where, by which employee; never sandbox, test or imported. */
import { describe, it, expect, vi } from "vitest";
vi.mock("../services/connectors", () => ({}));
vi.mock("../services/reply-engine/engine", () => ({ runReplyEngineTurn: vi.fn() }));
import { parseArgs, planReplay, gateAsOf, stagesLine, reportPath } from "../scripts/replay-v2";

const at = (m: number) => new Date(Date.UTC(2026, 10, 10, 10, m));
function db(convs: any[], msgs: Record<string, any[]>, agent: any = { id: "noa" }, opts: { ownerRecent?: boolean; handovers?: Record<string, any[]> } = {}) {
  const calls: any = { conv: [] };
  return {
    calls,
    aIAgent: { findFirst: async () => agent },
    conversation: { findMany: async (a: any) => { calls.conv.push(a); return convs.slice(0, a.take); } },
    message: { findMany: async ({ where }: any) => msgs[where.conversationId] ?? [], findFirst: async () => opts.ownerRecent ? { id: "x" } : null },
    conversationHandover: { findMany: async ({ where }: any) => opts.handovers?.[where.conversationId] ?? [] },
  };
}

describe("replay-v2 plan", () => {
  it("args: tenants required, defaults 15 per tenant and a 150 cap", () => {
    expect(() => parseArgs([])).toThrow();
    expect(parseArgs(["--tenants", "a,b"])).toMatchObject({ tenants: ["a", "b"], perTenant: 15, cap: 150, dry: false, keep: false });
    expect(parseArgs(["--tenants", "a", "--dry", "--keep", "--cap", "20"])).toMatchObject({ dry: true, keep: true, cap: 20 });
  });
  it("live, non-test, non-sandbox conversations with a customer message, newest first", async () => {
    const d = db([], {});
    await planReplay(parseArgs(["--tenants", "t1"]), d);
    expect(d.calls.conv[0].where).toMatchObject({ tenantId: "t1", isTest: false, origin: "LIVE", NOT: { customerExternalId: { startsWith: "sandbox:" } }, messages: { some: { direction: "INBOUND" } } });
    expect(d.calls.conv[0].orderBy).toEqual({ lastMessageAt: "desc" });
    expect(d.calls.conv[0].take).toBe(15);
  });
  it("★ --before freezes the set: only conversations whose last message is before it; per-tenant and cap unchanged", async () => {
    const { parseBefore } = await import("../scripts/replay-v2");
    const d = db([], {});
    await planReplay(parseArgs(["--tenants", "t1", "--before", "2026-11-18T00:00:00Z"]), d);
    expect(d.calls.conv[0].where.lastMessageAt).toEqual({ lt: new Date("2026-11-18T00:00:00Z") });
    expect(d.calls.conv[0].take).toBe(15);
    const d2 = db([], {});
    await planReplay(parseArgs(["--tenants", "t1"]), d2);
    expect(d2.calls.conv[0].where.lastMessageAt).toBeUndefined();
    expect(() => parseBefore("yesterday")).toThrow(/ISO/);
    expect(parseBefore(undefined)).toBeNull();
  });
  it("one turn per customer message, as of it, with what was actually sent after it; the assigned employee first", async () => {
    const d = db([{ id: "c1", assignedAiAgentId: "maya" }, { id: "c2", assignedAiAgentId: null }], {
      c1: [
        { id: "m1", direction: "INBOUND", body: "היי", createdAt: at(1) },
        { id: "m2", direction: "OUTBOUND", body: "רגע", createdAt: at(2), senderName: "AI Bot", metadata: { kind: "holding" } },
        { id: "m3", direction: "OUTBOUND", body: "היי! מה מחפשים?", createdAt: at(2), senderName: "AI Bot" },
        { id: "m4", direction: "INBOUND", body: "תיק", createdAt: at(3) },
        { id: "m5", direction: "INBOUND", body: " ", createdAt: at(4) },
      ],
      c2: [{ id: "m6", direction: "INBOUND", body: "שלום", createdAt: at(5) }],
    });
    const plan = (await planReplay(parseArgs(["--tenants", "t1"]), d)).get("t1")!;
    expect(plan.map((p) => [p.conversationId, p.messageId, p.aiAgentId])).toEqual([["c1", "m1", "maya"], ["c1", "m4", "maya"], ["c2", "m6", "noa"]]);
    expect(plan[0].asOf).toEqual(at(1));
    expect(plan[0].sentAfter).toEqual(["AI Bot: היי! מה מחפשים?"]);
    expect(plan[1].sentAfter).toEqual([]);
  });
  it("the cap counts across tenants", async () => {
    const msgs = { c1: Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, direction: "INBOUND", body: `q${i}`, createdAt: at(i) })) };
    const plan = await planReplay(parseArgs(["--tenants", "t1,t2", "--cap", "3"]), db([{ id: "c1", assignedAiAgentId: "a" }], msgs));
    expect(plan.get("t1")!.length).toBe(3);
    expect(plan.get("t2")!.length).toBe(0);
  });
  it("★ automated mail is skipped as live skips it (the engine's own check)", async () => {
    const d = db([{ id: "c1", assignedAiAgentId: "a", channel: "GMAIL", customerExternalId: "noreply@accounts.example.com" }, { id: "c2", assignedAiAgentId: "a", channel: "GMAIL", customerExternalId: "dana@gmail.com" }], {
      c1: [{ id: "m1", direction: "INBOUND", body: "Reset your password", createdAt: at(1) }],
      c2: [{ id: "m2", direction: "INBOUND", body: "Do you have it in blue?", createdAt: at(2) }, { id: "m3", direction: "INBOUND", body: "news", createdAt: at(3), metadata: { email: { bulk: "list" } } }],
    });
    const plan = (await planReplay(parseArgs(["--tenants", "t1"]), d)).get("t1")!;
    expect(plan.map((p) => [p.messageId, p.skip ?? null])).toEqual([["m1", "automated"], ["m2", null], ["m3", "automated"]]);
  });
  it("no employee anywhere: the conversation is skipped", async () => {
    const plan = await planReplay(parseArgs(["--tenants", "t1"]), db([{ id: "c1", assignedAiAgentId: null }], { c1: [{ id: "m1", direction: "INBOUND", body: "x", createdAt: at(1) }] }, null));
    expect(plan.get("t1")).toEqual([]);
  });
});

describe("replay-v2: the worker's Gate 1, as of each message (prod replay 4)", () => {
  const inb = (id: string, m: number, body = "שאלה") => ({ id, direction: "INBOUND", body, createdAt: at(m) });
  const bot = (id: string, m: number) => ({ id, direction: "OUTBOUND", body: "תשובה", createdAt: at(m), senderName: "AI Bot" });
  const person = (id: string, m: number) => ({ id, direction: "OUTBOUND", body: "עניתי", createdAt: at(m), senderName: "dana@shop.co.il" });
  const phone = (id: string, m: number) => ({ id, direction: "OUTBOUND", body: "מהטלפון", createdAt: at(m), senderName: "Shop", metadata: { source: "whatsapp_business_app" } });
  const escalation = (id: string, m: number) => ({ id, direction: "INBOUND", body: "", messageType: "system", createdAt: at(m), metadata: { systemEvent: "ai_bot_escalation" } });

  it("★ a person replied (inbox or phone) before the message -> human_owned; the bot's own replies do not count", () => {
    expect(gateAsOf([inb("a", 1), person("b", 2), inb("c", 3)], 2, [], false)).toBe("human_owned");
    expect(gateAsOf([inb("a", 1), phone("b", 2), inb("c", 3)], 2, [], false)).toBe("human_owned");
    expect(gateAsOf([inb("a", 1), bot("b", 2), inb("c", 3)], 2, [], false)).toBeNull();
    // Only what came BEFORE the message.
    expect(gateAsOf([inb("a", 1), person("b", 2)], 0, [], false)).toBeNull();
  });
  it("★ handed over: the history says a person, or an escalation event; a hand-back to the AI clears both", () => {
    expect(gateAsOf([inb("a", 1), inb("c", 3)], 1, [{ toHandler: "human", at: at(2) }], false)).toBe("handed_over");
    expect(gateAsOf([inb("a", 1), escalation("e", 2), inb("c", 3)], 2, [], false)).toBe("handed_over");
    const handedBack = [{ toHandler: "human", at: at(2) }, { toHandler: "ai_agent", at: at(4) }];
    expect(gateAsOf([inb("a", 1), person("b", 3), inb("c", 5)], 2, handedBack, false)).toBeNull();
    // A handover after the message does not reach back.
    expect(gateAsOf([inb("a", 1)], 0, [{ toHandler: "human", at: at(2) }], false)).toBeNull();
  });
  it("★ owner_recent only for a conversation's first messages (nothing sent yet)", () => {
    expect(gateAsOf([inb("a", 1)], 0, [], true)).toBe("owner_recent");
    expect(gateAsOf([inb("a", 1), bot("b", 2), inb("c", 3)], 2, [], true)).toBeNull();
  });
  it("★ the plan marks skipped turns with the reason, and they do not count against the cap", async () => {
    const d = db([{ id: "c1", assignedAiAgentId: "maya", channel: "WEBCHAT" }], {
      c1: [inb("m1", 1), bot("m2", 2), inb("m3", 3), person("m4", 4), inb("m5", 5), inb("m6", 6)],
    });
    // Cap 3: m5 and m6 are both listed, so the two skips did not use it up.
    const plan = (await planReplay(parseArgs(["--tenants", "t1", "--cap", "3"]), d)).get("t1")!;
    expect(plan.map((p) => [p.messageId, p.skip ?? null])).toEqual([["m1", null], ["m3", null], ["m5", "human_owned"], ["m6", "human_owned"]]);
  });
  it("★ the owner on the phone in the 24h before a WhatsApp conversation's first message", async () => {
    const d = db([{ id: "c1", assignedAiAgentId: "maya", channel: "WHATSAPP", customerExternalId: "972" }], { c1: [inb("m1", 1)] }, { id: "noa" }, { ownerRecent: true });
    const plan = (await planReplay(parseArgs(["--tenants", "t1"]), d)).get("t1")!;
    expect(plan[0].skip).toBe("owner_recent");
  });
});

describe("the stages line (numbers and tool names only)", () => {
  it("★ marks, rounds, the rewrite and each tool", () => {
    const line = stagesLine({ stageMs: { load: 410, surface: 520, tools_r1: 3900, model: 7400, gate3: 9100 }, rounds: 2, rewriteRounds: 1, autoLookupMs: 1200, rewriteMs: 1700, tools: [{ tool: "woocommerce.list_products", outcome: "ok", ms: 3880, retried: true }, { tool: "search_knowledge", outcome: "empty", ms: 300 }] });
    expect(line).toBe("- stages: load=410 surface=520 tools_r1=3900 model=7400 gate3=9100 | rounds=2 rewriteRounds=1 autoLookupMs=1200 rewriteMs=1700 | tools: woocommerce.list_products:ok:3880ms:retried search_knowledge:empty:300ms");
    expect(stagesLine({})).toBe("- stages: - | rounds=? rewriteRounds=0 autoLookupMs=0 rewriteMs=0 | tools: -");
    // Argument names only, never their values.
    const withArgs = stagesLine({ tools: [{ tool: "search_products", outcome: "empty", ms: 636, args: { query: "a customer's words", in_stock_only: true } }] });
    expect(withArgs).toContain("search_products:empty:636ms:{query,in_stock_only}");
    expect(withArgs).not.toContain("customer");
  });
});

describe("each run its own report file", () => {
  it("★ the default carries the run's time; {run} in --out is replaced; a plain --out stays", () => {
    const now = new Date("2026-11-17T21:04:05.678Z");
    expect(reportPath(undefined, now)).toBe("/tmp/replay-v2-2026-11-17T21-04-05.md");
    expect(reportPath("/tmp/smoovee-{run}.md", now)).toBe("/tmp/smoovee-2026-11-17T21-04-05.md");
    expect(reportPath("/tmp/r.md", now)).toBe("/tmp/r.md");
  });
});

describe("the store searches in the report (rating ed780586)", () => {
  it("★ the query, her own words and the filters, cut to 60 characters", async () => {
    const { searchArgsLine } = await import("../scripts/replay-v2");
    const line = searchArgsLine([{ tool: "woocommerce.list_products", q: "מטפחת לקשירה נמוכה", cq: "היי מחפשת את הבובון לקשירה נמוכה", audience: "women", in_stock: true, price: [null, 200] }]);
    expect(line).toBe('list_products q="מטפחת לקשירה נמוכה" cq="היי מחפשת את הבובון לקשירה נמוכה" audience=women in_stock=true price=-..200');
    expect(searchArgsLine([{ tool: "x.list_products", q: "a".repeat(80), price: [null, null] }])).toBe(`list_products q="${"a".repeat(60)}"`);
  });
});
