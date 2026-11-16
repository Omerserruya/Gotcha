/** The replay script's plan: which turns, cut where, by which employee; never sandbox, test or imported. */
import { describe, it, expect, vi } from "vitest";
vi.mock("../services/connectors", () => ({}));
vi.mock("../services/reply-engine/engine", () => ({ runReplyEngineTurn: vi.fn() }));
import { parseArgs, planReplay, gateAsOf } from "../scripts/replay-v2";

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
