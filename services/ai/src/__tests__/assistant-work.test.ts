/**
 * ★ What is waiting (design 01a items 6 and 7):
 *   - approvals waiting for a decision, as the Approvals screen and Home's
 *     count list them (pending, not past their expiry): what, about whom,
 *     the amount, since when, each linking to /approvals?id=<id>; the total
 *     is Home's figure; one on a private number's conversation is not shown
 *   - the questions customers asked that the AI could not answer, latest
 *     first, linking to where they are answered; only with
 *     ai:knowledge:read (hidden from the tools without it, refused anyway)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ approvals: [] as any[], convs: [] as any[], contacts: [] as any[], gaps: [] as any[], rules: [] as any[] }));
function test(row: any, w: any): boolean {
  return Object.entries(w ?? {}).every(([k, v]: [string, any]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("gt" in v) return row[k] > v.gt;
      return true;
    }
    return (row[k] ?? null) === v;
  });
}
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readDurableSetting: async () => JSON.stringify({ timezone: "Asia/Jerusalem", schedule: {} }),
    prisma: {
      approvalRequest: {
        findMany: async (a: any) => H.approvals.filter((r) => test(r, a.where)).sort((x, y) => y.createdAt - x.createdAt).slice(0, a.take),
        count: async (a: any) => H.approvals.filter((r) => test(r, a.where)).length,
      },
      conversation: { findMany: async (a: any) => H.convs.filter((c) => test(c, a.where)) },
      contact: { findMany: async (a: any) => H.contacts.filter((c) => test(c, a.where)) },
      unansweredQuestion: {
        findMany: async (a: any) => H.gaps.filter((g) => test(g, a.where)).sort((x, y) => y.lastAskedAt - x.lastAskedAt).slice(0, a.take),
        count: async (a: any) => H.gaps.filter((g) => test(g, a.where)).length,
      },
      inboundExclusion: { findMany: async () => H.rules },
      tenantTool: { findMany: async () => [] },
    },
  };
});

import { dispatchSystemToolCall, buildSystemAgentTools } from "../services/system-tools.service";

const D = (iso: string) => new Date(iso);
const FUTURE = new Date(Date.now() + 86_400_000), PAST = new Date(Date.now() - 86_400_000);
const ctx = (o: any = {}) => ({ tenantId: "T", userId: "u", locale: "en", canReadKnowledge: true, ...o });
const call = async (name: string, c: any = ctx()) => {
  const r = await dispatchSystemToolCall({ id: "t", function: { name, arguments: "{}" } }, c);
  return { out: JSON.parse(r.content), artifacts: r.artifacts as any };
};

beforeEach(() => {
  H.rules = [];
  const a = (id: string, o: any) => ({ id, tenantId: "T", status: "PENDING", tool: "issue_refund", summary: `Approval ${id}`, params: {}, riskLevel: "medium", expiresAt: FUTURE, conversationId: null, contactId: null, ...o });
  H.approvals = [
    a("refund", { summary: "Refund order #1016", params: { amount: 250, currency: "ILS" }, contactId: "omer", riskLevel: "high", createdAt: D("2026-10-08T09:00:00Z") }),
    a("shopper", { summary: "Send a discount code", conversationId: "c_shop", createdAt: D("2026-10-07T09:00:00Z") }),
    a("private", { summary: "On a private number", conversationId: "c_private", createdAt: D("2026-10-06T09:00:00Z") }),
    a("expired", { expiresAt: PAST, createdAt: D("2026-10-05T09:00:00Z") }),
    a("decided", { status: "APPROVED", createdAt: D("2026-10-05T09:00:00Z") }),
    a("other", { tenantId: "OTHER", createdAt: D("2026-10-08T10:00:00Z") }),
  ];
  H.contacts = [{ id: "omer", tenantId: "T", displayName: "Omer Serruya", externalId: "972525401686" }];
  H.convs = [
    { id: "c_shop", tenantId: "T", channel: "SHOPIFY_LIVE_CHAT", customerExternalId: "s1", channelAccountId: "acc", customerName: "Shopper on demo.myshopify.com" },
    { id: "c_private", tenantId: "T", channel: "WHATSAPP", customerExternalId: "972541111111", channelAccountId: "acc", customerName: "Family" },
  ];
  H.gaps = [
    { id: "g1", tenantId: "T", question: "Do you ship to Eilat?", askCount: 3, askedBy: 2, lastAskedAt: D("2026-10-08T10:00:00Z"), resolvedAt: null },
    { id: "g2", tenantId: "T", question: "Do you have gift cards?", askCount: 1, askedBy: 1, lastAskedAt: D("2026-10-06T10:00:00Z"), resolvedAt: null },
    { id: "g_done", tenantId: "T", question: "Opening hours?", askCount: 5, askedBy: 5, lastAskedAt: D("2026-10-08T11:00:00Z"), resolvedAt: D("2026-10-08T12:00:00Z") },
    { id: "g_other", tenantId: "OTHER", question: "Not yours", askCount: 1, askedBy: 1, lastAskedAt: D("2026-10-08T11:00:00Z"), resolvedAt: null },
  ];
});

describe("★ approvals waiting for a decision", () => {
  it("pending and not expired, newest first: what, whom, the amount, since when, a link to each; the total is Home's figure", async () => {
    H.rules = [];
    const { out, artifacts } = await call("system_list_approvals");
    const card = artifacts.blocks[0];
    expect(card).toMatchObject({ type: "record_list", kind: "approval", title: "Waiting for approval" });
    expect(card.items.map((i: any) => i.id)).toEqual(["refund", "shopper", "private"]);
    expect(card.items[0]).toMatchObject({ title: "Refund order #1016", subtitle: "Omer Serruya · ₪250.00 · High risk", deepLink: "/approvals?id=refund" });
    expect(card.items[0].meta).toMatch(/^waiting since 8 October/);
    // An unnamed shopper reads as a shopper.
    expect(card.items[1].subtitle).toBe("Website shopper · Medium risk");
    const home = JSON.parse((await dispatchSystemToolCall({ id: "m", function: { name: "system_get_metric", arguments: JSON.stringify({ metric: "pending_approvals" }) } }, ctx())).content).value;
    expect(out.total).toBe(home);
    expect(out.approvals[0]).toMatchObject({ approvalId: "refund", what: "Refund order #1016", customer: "Omer Serruya", amount: "₪250.00" });
  });

  it("★ one on a private number's conversation is not shown", async () => {
    H.rules = [{ channel: "WHATSAPP", channelAccountId: null, customerExternalId: "972541111111" }];
    const { out } = await call("system_list_approvals");
    expect(out.approvals.map((a: any) => a.approvalId)).toEqual(["refund", "shopper"]);
  });

  it("in Hebrew; none waiting is said, with no card", async () => {
    const { artifacts } = await call("system_list_approvals", ctx({ locale: "he" }));
    expect(artifacts.blocks[0].title).toBe("מחכים לאישור");
    expect(artifacts.blocks[0].items[0].meta).toMatch(/^ממתין מ-8 באוקטובר/);
    H.approvals = [];
    const none = await call("system_list_approvals");
    expect(none.out).toMatchObject({ ok: true, total: 0 });
    expect(none.artifacts).toBeUndefined();
  });
});

describe("★ questions the AI could not answer", () => {
  it("open ones, latest first, how often and by how many, linking to where they are answered", async () => {
    const { out, artifacts } = await call("system_list_knowledge_gaps", ctx({ locale: "he" }));
    expect(out.total).toBe(2);
    const card = artifacts.blocks[0];
    expect(card.items.map((i: any) => i.id)).toEqual(["g1", "g2"]);
    expect(card.items[0]).toMatchObject({ title: "Do you ship to Eilat?", subtitle: "נשאלה 3 פעמים, על ידי 2 אנשים", deepLink: "/studio/knowledge?section=gaps" });
    expect(card.items[1].subtitle).toBe("נשאלה פעם אחת");
  });

  it("★ only with ai:knowledge:read: hidden from the tools, refused anyway", async () => {
    expect((await call("system_list_knowledge_gaps", ctx({ canReadKnowledge: false }))).out).toEqual({ ok: false, error: "not_permitted" });
    const names = (opts: any) => buildSystemAgentTools({ tenantId: "T", ...opts }).then((t) => t.map((x: any) => x.function.name));
    expect(await names({ knowledge: false })).not.toContain("system_list_knowledge_gaps");
    expect(await names({ knowledge: true })).toContain("system_list_knowledge_gaps");
    expect(await names({})).toContain("system_list_approvals");
  });
});

describe("★ routing and wording (replay of item 5, 2026-10-08)", () => {
  it("'tell me about X' goes straight to the customer card; finding is for 'is there / find'", async () => {
    const tools = await buildSystemAgentTools({ tenantId: "T" });
    const desc = (n: string) => (tools.find((t: any) => t.function.name === n) as any).function.description as string;
    expect(desc("system_find_customers")).toMatch(/"is there", "do we have", "find"\). For "tell me about X", "what do we know about X" or "who is X", call system_customer_card directly/);
    expect(desc("system_customer_card")).toMatch(/Use it for "tell me about X", "what do we know about X", "who is X": call it directly with the name \(customer\), without searching first/);
  });

  it("answers never describe the screen: the result texts and the thread lines say so", async () => {
    const { LIST_SHOWN_AS, SHOWN_AS } = await import("../services/assistant-query.service");
    const { threadSystemLines } = await import("../services/assistant-threads.service");
    for (const s of [LIST_SHOWN_AS, SHOWN_AS]) {
      expect(s).toMatch(/never describe the card/);
      expect(s).not.toMatch(/refer to them|the card lists them|behind "show all"\)/);
    }
    expect(threadSystemLines({ range: "last_7", channels: "all" }, "he").join("\n")).toMatch(/Never describe the screen, a card or a button/);
  });
});
