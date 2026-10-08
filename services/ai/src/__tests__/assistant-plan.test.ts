/**
 * ★ A plan is pinned when it is proposed (2026-10-08, the first Home
 * proposal: { assignee: "me", customerId } resolved at execution, so "me"
 * was whoever approved and "their open conversation" could be another one).
 *   - a conversation step names its conversation (a customer's open one,
 *     found now, as the requester sees it) and its assignee ("me" = the
 *     requester)
 *   - what the requester cannot see, or a closed conversation, is refused
 *   - the summary is written from the steps, in the turn's language
 *   - the approval names the requester and where they asked; each step has
 *     a target; no "requiresApproval" flag on a pending plan
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ approvals: [] as any[], convs: [] as any[], contacts: [] as any[], users: [] as any[], questions: [] as any[] }));
function test(row: any, w: any): boolean {
  return Object.entries(w ?? {}).every(([k, v]: [string, any]) => {
    if (k === "AND") return v.every((x: any) => test(row, x));
    if (k === "OR") return v.some((x: any) => test(row, x));
    if (k === "NOT") return !test(row, v);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("startsWith" in v) return String(row[k] ?? "").startsWith(v.startsWith);
      return true;
    }
    return (row[k] ?? null) === v;
  });
}
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    createApprovalRequest: async (a: any) => { H.approvals.push(a); return { id: `apr_${H.approvals.length}` }; },
    evaluateToolGate: async () => ({ decision: "REQUIRE_APPROVAL", reason: "test" }),
    prisma: {
      conversation: {
        findFirst: async (a: any) => H.convs.find((c) => test(c, a.where)) ?? null,
        findMany: async (a: any) => H.convs.filter((c) => test(c, a.where)),
      },
      contact: { findMany: async (a: any) => H.contacts.filter((c) => test(c, a.where)) },
      user: { findFirst: async (a: any) => H.users.find((u) => test(u, a.where)) ?? null },
      unansweredQuestion: { findFirst: async (a: any) => H.questions.find((q) => test(q, a.where)) ?? null },
      inboundExclusion: { findMany: async () => [] },
      tenantTool: { findMany: async () => [] },
    },
  };
});

import { dispatchSystemToolCall } from "../services/system-tools.service";

const SALES = { userId: "matan", role: "AGENT", departmentId: "sales" };
const ctx = (o: any = {}) => ({ tenantId: "T", userId: "matan", userName: "Matan", viewer: { userId: "matan", role: "ADMIN" }, locale: "he", canReadContacts: true, surface: "home", ...o });
const propose = async (steps: any[], c: any = ctx()) => {
  const r = await dispatchSystemToolCall({ id: "p", function: { name: "propose_plan", arguments: JSON.stringify({ summary: "model prose, never shown", steps }) } }, c);
  return JSON.parse(r.content);
};

beforeEach(() => {
  H.approvals = [];
  H.contacts = [{ id: "omer", tenantId: "T", channel: "WHATSAPP", externalId: "972525401686", displayName: "Omer Serruya", personId: null, mergedIntoId: null, email: null, phone: null, tags: [], updatedAt: new Date() }];
  const base = { tenantId: "T", isTest: false, channelAccountId: "acc", handledBy: "ai_agent", isHandedOver: false, assignedAgentId: null, departmentId: null, createdAt: new Date() };
  H.convs = [
    { ...base, id: "wa_open", channel: "WHATSAPP", customerExternalId: "972525401686", customerName: "Omer Serruya", status: "OPEN", lastMessageAt: new Date("2026-10-08") },
    { ...base, id: "wa_old", channel: "WHATSAPP", customerExternalId: "972525401686", customerName: "Omer Serruya", status: "CLOSED", lastMessageAt: new Date("2026-10-09") },
    { ...base, id: "support_c", channel: "WEBCHAT", customerExternalId: "wc_1", customerName: "Dana", status: "OPEN", departmentId: "support" },
  ];
  H.users = [{ id: "matan", tenantId: "T", isActive: true, name: "Matan", email: "m@x" }, { id: "noa", tenantId: "T", isActive: true, name: "Noa", email: "n@x" }];
  H.questions = [{ id: "q1", tenantId: "T", question: "Do you ship to Eilat?" }];
});

describe("★ pinned at proposal", () => {
  it("'assign me Omer's open conversation': the open one, the requester as assignee, a target, words from the steps", async () => {
    const out = await propose([{ tool: "assign_conversation", params: { assignee: "me", customerId: "omer" }, reason: "asked" }]);
    expect(out).toMatchObject({ ok: true, summary: "לשייך אליך את השיחה של Omer Serruya (וואטסאפ)" });
    const a = H.approvals[0];
    expect(a.params.steps).toEqual([{
      tool: "assign_conversation", params: { conversationId: "wa_open", agentId: "matan" }, reason: "asked", riskLevel: "medium",
      target: { conversationId: "wa_open", assigneeId: "matan" }, summary: "לשייך אליך את השיחה של Omer Serruya (וואטסאפ)",
    }]);
    expect(a.summary).toBe("לשייך אליך את השיחה של Omer Serruya (וואטסאפ)");
    expect(a.conversationId).toBe("wa_open");
    // Who asked, and where; no "requiresApproval: false" on a pending plan.
    expect(a.params.requester).toEqual({ userId: "matan", name: "Matan" });
    expect(a.params.source).toBe("home_assistant");
    expect(a.params).not.toHaveProperty("requiresApproval");
    expect(a.requestedBy).toBe("user:matan");
    expect(a.reason).toBe("בקשה של Matan מ-GOTCHA ב-Home");
  });

  it("claim is assign-to-the-requester; another person by name; in English", async () => {
    await propose([{ tool: "claim_conversation", params: { conversationId: "wa_open" }, reason: "" }]);
    expect(H.approvals[0].params.steps[0]).toMatchObject({ tool: "assign_conversation", params: { conversationId: "wa_open", agentId: "matan" } });
    const out = await propose([{ tool: "assign_conversation", params: { assignee: "noa", conversationId: "wa_open" }, reason: "" }], ctx({ locale: "en" }));
    expect(out.summary).toBe("Assign Omer Serruya's WhatsApp conversation to Noa");
    expect((await propose([{ tool: "assign_conversation", params: { assignee: "noa", conversationId: "wa_open" }, reason: "" }])).summary).toBe("לשייך את השיחה של Omer Serruya (וואטסאפ) ל-Noa");
  });

  it("close, return to GOTCHA, a note, an answer: said from the steps", async () => {
    const out = await propose([
      { tool: "return_to_gotcha", params: { conversationId: "wa_open" }, reason: "" },
      { tool: "add_note", params: { contactId: "omer", body: "Prefers evening calls" }, reason: "" },
      { tool: "answer_question", params: { unansweredQuestionId: "q1", answer: "Yes, in 3 days" }, reason: "" },
    ]);
    expect(out.summary).toBe("להחזיר ל-GOTCHA את השיחה של Omer Serruya (וואטסאפ); להוסיף הערה ל-Omer Serruya: “Prefers evening calls”; לענות על השאלה “Do you ship to Eilat?”");
    expect(H.approvals[0].params.steps.map((s: any) => s.target)).toEqual([{ conversationId: "wa_open" }, { customerId: "omer" }, { questionId: "q1" }]);
  });
});

describe("★ refused at proposal", () => {
  it("what the requester cannot see, a closed conversation, a person outside the workspace, nothing named", async () => {
    expect((await propose([{ tool: "close_conversation", params: { conversationId: "support_c" }, reason: "" }], ctx({ viewer: SALES }))).error).toBe("conversation not found");
    expect((await propose([{ tool: "assign_conversation", params: { conversationId: "wa_old", assignee: "me" }, reason: "" }])).error).toBe("that conversation is closed");
    expect((await propose([{ tool: "assign_conversation", params: { conversationId: "wa_open", assignee: "stranger" }, reason: "" }])).error).toMatch(/not in this workspace/);
    expect((await propose([{ tool: "close_conversation", params: {}, reason: "" }])).error).toMatch(/say which conversation/);
    expect((await propose([{ tool: "add_note", params: { contactId: "nobody", body: "x" }, reason: "" }])).error).toBe("customer not found");
    expect(H.approvals).toEqual([]);
  });
});
