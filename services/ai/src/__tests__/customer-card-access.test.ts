/**
 * ★ GET /api/customer-card/:approvalId is for someone who may read approvals
 * AND a customer's commerce, and only on a conversation they can see
 * (2026-10-09 review: any workspace member could read order count, lifetime
 * value and refunds, with live store calls).
 *   - approvals:requests:view and customer:commerce:read, both (ADMIN passes)
 *   - another department's conversation, or a private number's: 404, exactly
 *     like a missing approval, and no store call
 *   - an approval with no conversation keeps its answer
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  perms: [] as string[],
  user: { userId: "u1", role: "AGENT", departmentId: "sales" } as any,
  approvals: [] as any[],
  convs: [] as any[],
  rules: [] as any[],
  storeCalls: 0,
}));

function match(row: any, w: any): boolean {
  return Object.entries(w ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return v.some((x: any) => match(row, x));
    if (k === "AND") return v.every((x: any) => match(row, x));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      return true;
    }
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.user, tenantId: "T" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: (perm: string, role: string) => (req: any, res: any, n: any) =>
      H.perms.includes(perm) || req.user.role === role ? n() : res.status(403).json({ error: "Forbidden" }),
    prisma: {
      approvalRequest: { findFirst: async (a: any) => H.approvals.find((r) => match(r, a.where)) ?? null },
      conversation: { findFirst: async (a: any) => H.convs.find((c) => match(c, a.where)) ?? null },
      conversationIntelligence: { findFirst: async () => null },
      inboundExclusion: { findMany: async () => H.rules },
    },
  };
});
vi.mock("../services/memory/customer-context.service", () => ({ loadCustomerContext: async () => ({ customer: { shopifyCustomerId: null } }) }));
vi.mock("../services/customer-commerce-facts.service", () => ({ loadCustomerCommerceFacts: async () => { H.storeCalls++; return null; } }));

import router from "../routes/customer-card";

const app = express();
app.use(express.json());
app.use("/api", router);
const card = (id: string) => request(app).get(`/api/customer-card/${id}`);

beforeEach(() => {
  H.perms = ["approvals:requests:view", "customer:commerce:read"];
  H.user = { userId: "u1", role: "AGENT", departmentId: "sales" };
  H.storeCalls = 0;
  H.rules = [];
  H.approvals = [
    { id: "ap_sales", tenantId: "T", conversationId: "c_sales" },
    { id: "ap_support", tenantId: "T", conversationId: "c_support" },
    { id: "ap_plan", tenantId: "T", conversationId: null },
  ];
  const c = (id: string, departmentId: string, ext: string) => ({ id, tenantId: "T", departmentId, channel: "WHATSAPP", customerExternalId: ext, channelAccountId: "acc", assignedAgentId: null, isTest: false });
  H.convs = [c("c_sales", "sales", "972541111111"), c("c_support", "support", "972542222222")];
});

describe("★ who may read a customer card", () => {
  it("both permissions: the card", async () => {
    const r = await card("ap_sales");
    expect(r.status).toBe(200);
    expect(r.body.data.approvalId).toBe("ap_sales");
  });

  it("either permission missing: 403, and no store call", async () => {
    H.perms = ["approvals:requests:view"];
    expect((await card("ap_sales")).status).toBe(403);
    H.perms = ["customer:commerce:read"];
    expect((await card("ap_sales")).status).toBe(403);
    H.perms = [];
    expect((await card("ap_sales")).status).toBe(403);
    expect(H.storeCalls).toBe(0);
  });

  it("ADMIN passes both", async () => {
    H.perms = [];
    H.user = { userId: "boss", role: "ADMIN" };
    expect((await card("ap_support")).status).toBe(200);
  });
});

describe("★ only on a conversation the reader can see", () => {
  it("another department's conversation: 404 like a missing approval, no store call", async () => {
    const r = await card("ap_support");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "approval not found" });
    expect(H.storeCalls).toBe(0);
  });

  it("a private number's conversation: 404", async () => {
    H.rules = [{ channel: "WHATSAPP", channelAccountId: null, customerExternalId: "972541111111" }];
    expect((await card("ap_sales")).status).toBe(404);
    expect(H.storeCalls).toBe(0);
  });

  it("an approval with no conversation keeps its answer", async () => {
    const r = await card("ap_plan");
    expect(r.status).toBe(200);
    expect(r.body.data.orders).toEqual({ value: null, reason: "approval_has_no_conversation" });
  });
});
