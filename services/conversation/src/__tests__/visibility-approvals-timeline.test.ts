/**
 * The same conversation visibility on the two remaining doors: an approval by
 * id (its card carries the conversation and its recent messages) and the
 * customer timeline. A department-restricted agent: 404 on another
 * department's approval (identical to a missing one) and no other-department
 * threads in the timeline. Admin unchanged. Through the real routers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  viewer: { userId: "admin1", role: "ADMIN", departmentId: undefined as string | undefined },
  convs: [] as any[],
  approvals: [] as any[],
  seenConvWhere: null as any,
}));

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (k === "AND") return (v as any[]).every((w) => matches(row, w));
    if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.viewer }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    withHistoricalRecords: (fn: any) => fn(),
    findSiblingContacts: async () => [{ id: "k1", channel: "WHATSAPP", externalId: "9725", displayName: null }],
    prisma: {
      approvalRequest: {
        findFirst: async (a: any) => H.approvals.find((r) => matches(r, a.where)) ?? null,
        findMany: async () => H.approvals.map((r) => ({ ...r })),
      },
      user: { findMany: async () => [] },
      conversation: {
        // Faithful to Prisma: null for a REQUIRED field is a validation error,
        // not "matches nothing" (that belief hid a 500 on every approval with
        // no conversation).
        findFirst: async (a: any) => {
          if (a.where?.id === null) throw new Error("PrismaClientValidationError: Argument `id` must not be null");
          return H.convs.find((c) => matches(c, a.where)) ?? null;
        },
        findMany: async (a: any) => { H.seenConvWhere = a.where; return H.convs.filter((c) => matches(c, a.where)).slice(0, a.take ?? 1e9); },
        count: async (a: any) => H.convs.filter((c) => matches(c, a.where)).length,
      },
      contact: { findFirst: async (a: any) => (a.where.id === "k1" ? { id: "k1", tenantId: "T", channel: "WHATSAPP", externalId: "9725", personId: "p1", mergedIntoId: null, metadata: {} } : null) },
      message: {
        findMany: async (a: any) => {
          if (a.where?.conversationId === null) throw new Error("PrismaClientValidationError: Argument `conversationId` must not be null");
          return [{ id: "m1", body: "secret", direction: "INBOUND", createdAt: new Date(), conversationId: "c_support" }];
        },
        count: async () => 1,
      },
      conversationHandover: { findMany: async () => [], count: async () => 0 },
      toolExecution: { findMany: async () => [], count: async () => 0 },
    },
  };
});

import approvalsRouter from "../routes/approvals";
import identityRouter from "../routes/identity";

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);
app.use("/api/identity", identityRouter);

beforeEach(() => {
  H.viewer = { userId: "admin1", role: "ADMIN", departmentId: undefined };
  H.convs = [
    { id: "c_sales", tenantId: "T", departmentId: "sales", assignedAgentId: null, channel: "WHATSAPP", customerExternalId: "9725", origin: "LIVE" },
    { id: "c_support", tenantId: "T", departmentId: "support", assignedAgentId: null, channel: "WHATSAPP", customerExternalId: "9725", origin: "LIVE" },
  ];
  H.approvals = [
    { id: "a_support", tenantId: "T", conversationId: "c_support", contactId: null, tool: "shopify.process_refund" },
    { id: "a_system", tenantId: "T", conversationId: null, contactId: null, tool: "create_broadcast" },
  ];
});
const agentOfSales = () => { H.viewer = { userId: "agent1", role: "AGENT", departmentId: "sales" }; };

describe("approval by id", () => {
  it("★ another department's approval is 404 - identical to a missing one - and its messages are not served", async () => {
    agentOfSales();
    const hidden = await request(app).get("/api/approvals/a_support");
    const missing = await request(app).get("/api/approvals/nope");
    expect(hidden.status).toBe(404);
    expect([hidden.status, hidden.body]).toEqual([missing.status, missing.body]);
    expect(JSON.stringify(hidden.body)).not.toContain("secret");
  });

  it("★ an approval with no conversation (a System Copilot plan) opens - it used to 500", async () => {
    agentOfSales();
    const r = await request(app).get("/api/approvals/a_system");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ conversation: null, recentMessages: [], approval: { id: "a_system", labelKey: "working" } });
  });

  it("admin sees it, with its context", async () => {
    const r = await request(app).get("/api/approvals/a_support");
    expect(r.status).toBe(200);
    expect(r.body.approval.id).toBe("a_support");
    // The same key as the inbox's live line, from the shared map.
    expect(r.body.approval.labelKey).toBe("processing_refund");
  });

  it("★ the approvals list carries labelKey per row", async () => {
    const r = await request(app).get("/api/approvals");
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.data.map((a: any) => [a.id, a.labelKey]));
    expect(by).toMatchObject({ a_support: "processing_refund", a_system: "working" });
  });
});

describe("customer timeline", () => {
  it("★ a restricted agent's timeline scans only conversations they may see", async () => {
    agentOfSales();
    await request(app).get("/api/identity/k1/timeline");
    const visible = H.convs.filter((c) => matches(c, H.seenConvWhere)).map((c) => c.id);
    expect(visible).toEqual(["c_sales"]);
  });

  it("an admin's where is exactly what it was", async () => {
    await request(app).get("/api/identity/k1/timeline");
    expect(H.seenConvWhere).toMatchObject({ tenantId: "T", OR: [{ channel: "WHATSAPP", customerExternalId: "9725" }] });
    expect(H.seenConvWhere).not.toHaveProperty("AND");
  });
});
