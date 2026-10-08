/**
 * ★ Asking about one request (design 03): the assistant reads it and can
 * only explain it.
 *   - what, the action and its parameters (no secrets), why it needs
 *     approval, who asked, the customer and conversation, the state and the
 *     expiry (as words and as data)
 *   - the workspace's requests; one tied to a conversation only when the
 *     caller can see it; a private number's, another workspace's, or no
 *     viewer: not found
 *   - in a thread about one request, the tool reads that one by default
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ approvals: [] as any[], convs: [] as any[], rules: [] as any[] }));
function test(row: any, w: any): boolean {
  return Object.entries(w ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return v.some((x: any) => test(row, x));
    return (row[k] ?? null) === v;
  });
}
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readDurableSetting: async () => JSON.stringify({ timezone: "Asia/Jerusalem", schedule: {} }),
    prisma: {
      approvalRequest: { findFirst: async (a: any) => H.approvals.find((r) => test(r, a.where)) ?? null },
      conversation: { findFirst: async (a: any) => H.convs.find((c) => test(c, a.where)) ?? null },
      inboundExclusion: { findMany: async () => H.rules },
      tenantTool: { findMany: async () => [] },
    },
  };
});

import { dispatchSystemToolCall } from "../services/system-tools.service";

const ADMIN = { userId: "boss", role: "ADMIN" };
const SALES = { userId: "agent1", role: "AGENT", departmentId: "sales" };
const ctx = (o: any = {}) => ({ tenantId: "T", userId: "boss", locale: "he", viewer: ADMIN, ...o });
const read = async (args: any, c: any = ctx()) => {
  const r = await dispatchSystemToolCall({ id: "t", function: { name: "system_read_approval", arguments: JSON.stringify(args) } }, c);
  return { out: JSON.parse(r.content), artifacts: r.artifacts as any };
};

beforeEach(() => {
  H.rules = [];
  H.convs = [
    { id: "c_sales", tenantId: "T", channel: "WHATSAPP", customerExternalId: "972541111111", customerName: "Dana Cohen", channelAccountId: "acc", status: "OPEN", departmentId: "sales", assignedAgentId: null },
    { id: "c_support", tenantId: "T", channel: "WEBCHAT", customerExternalId: "wc", customerName: "Avi", channelAccountId: "acc", status: "OPEN", departmentId: "support", assignedAgentId: null },
  ];
  const base = { tenantId: "T", status: "PENDING", riskLevel: "high", riskTags: ["FINANCIAL", "IRREVERSIBLE"], policyRuleName: "Refunds over ₪200", reason: "Customer asked for a refund", requestedBy: "bot", createdAt: new Date("2026-10-08T09:00:00Z"), expiresAt: new Date("2026-10-08T09:30:00Z"), decidedAt: null, modifiedParams: null };
  H.approvals = [
    { ...base, id: "refund", conversationId: "c_sales", tool: "issue_refund", summary: "Refund order #1016 (₪250)", params: { orderId: "1016", amount: 250, apiKey: "sk_live_x" } },
    { ...base, id: "support_one", conversationId: "c_support", tool: "send_message", summary: "Send Avi a message", params: {} },
    { ...base, id: "plan", conversationId: null, tool: "propose_plan", summary: "לשייך אליך את השיחה של Dana Cohen (וואטסאפ)", riskLevel: "medium", riskTags: ["ASSISTANT", "PLAN"], policyRuleName: null, requestedBy: "user:matan", params: { steps: [{ tool: "assign_conversation", summary: "לשייך אליך את השיחה של Dana Cohen (וואטסאפ)" }], requester: { userId: "matan", name: "Matan" }, source: "home_assistant" } },
    { ...base, id: "other_ws", tenantId: "OTHER", conversationId: null, tool: "x", summary: "Not yours", params: {} },
  ];
});

describe("★ one request, explained", () => {
  it("what, why, who asked, the customer, the state; parameters without secrets; a card linking to it", async () => {
    const { out, artifacts } = await read({ approvalId: "refund" });
    expect(out).toMatchObject({
      ok: true, approvalId: "refund", what: "Refund order #1016 (₪250)", action: "issue_refund",
      whyItNeedsApproval: "כלל: Refunds over ₪200 · סיכון: גבוה · FINANCIAL, IRREVERSIBLE",
      askedBy: "GOTCHA", customer: "Dana Cohen", conversationLink: "/inbox?c=c_sales", state: "ממתינה להחלטה",
    });
    expect(out.parameters).toEqual({ orderId: "1016", amount: 250, apiKey: "[hidden]" });
    expect(out.readOnly).toMatch(/לאשר או לדחות אותה עושים במסך האישורים/);
    const card = artifacts.blocks[0];
    expect(card).toMatchObject({ type: "record", kind: "approval", deepLink: "/approvals?id=refund", state: "pending", expiresAt: "2026-10-08T09:30:00.000Z" });
    expect(card.fields.map((f: any) => f.key)).toEqual(["what", "action", "why", "asked_by", "customer", "state", "expires"]);
  });

  it("a plan: its steps, and the person who asked", async () => {
    const { out, artifacts } = await read({ approvalId: "plan" });
    expect(out.askedBy).toBe("Matan");
    expect(artifacts.blocks[0].fields.find((f: any) => f.key === "steps").value).toBe("לשייך אליך את השיחה של Dana Cohen (וואטסאפ)");
  });

  it("in a thread about one request, it reads that one when nothing is named", async () => {
    expect((await read({}, ctx({ contextApprovalId: "refund" }))).out.approvalId).toBe("refund");
    expect((await read({})).out).toMatchObject({ ok: false });
  });
});

describe("★ only a request the caller may read", () => {
  it("another department's conversation, another workspace, a private number, no viewer: not found", async () => {
    const nf = { ok: false, error: "approval request not found" };
    expect((await read({ approvalId: "support_one" }, ctx({ viewer: SALES }))).out).toEqual(nf);
    expect((await read({ approvalId: "refund" }, ctx({ viewer: SALES }))).out.ok).toBe(true);
    expect((await read({ approvalId: "other_ws" })).out).toEqual(nf);
    expect((await read({ approvalId: "refund" }, ctx({ viewer: undefined }))).out).toEqual(nf);
    H.rules = [{ channel: "WHATSAPP", channelAccountId: null, customerExternalId: "972541111111" }];
    expect((await read({ approvalId: "refund" })).out).toEqual(nf);
  });
});
