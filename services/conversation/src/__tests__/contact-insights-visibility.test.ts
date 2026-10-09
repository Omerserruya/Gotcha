/**
 * Customers list insights: the "latest conversation" a row reports is the
 * latest one the VIEWER may see (the inbox rule, visibilityClause), not just
 * the latest. The row carries that conversation's id, summary and counts, so a
 * newer thread in another department used to win and leak its story to a
 * department-restricted agent. Fixed 2026-10-09.
 *
 * Through the real router; the conversation double honours the where it is
 * given (OR / not / tenant), so a dropped visibility filter is caught.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const DB = vi.hoisted(() => ({
  viewer: { userId: "admin1", role: "ADMIN", departmentId: undefined as string | undefined },
  contacts: [] as any[],
  convs: [] as any[],
  intel: [] as any[],
}));

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (k === "AND") return (v as any[]).every((w) => matches(row, w));
    if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
    if (v && typeof v === "object" && "not" in v) return (row[k] ?? null) !== v.not;
    return (row[k] ?? null) === v;
  });
}
const guard = (m: string, w: any) => { if (!w?.tenantId) throw new Error(`tenant guard: ${m}`); };

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      contact: { findMany: async (a: any) => { guard("contact", a.where); return DB.contacts.filter((c) => matches(c, a.where)); } },
      conversation: {
        findFirst: async (a: any) => {
          guard("conversation", a.where);
          return DB.convs.filter((c) => matches(c, a.where)).sort((x, y) => y.lastMessageAt - x.lastMessageAt)[0] ?? null;
        },
      },
      conversationIntelligence: { findFirst: async (a: any) => { guard("intel", a.where); return DB.intel.find((i) => matches(i, a.where)) ?? null; } },
      message: { count: async (a: any) => { guard("message", a.where); return 0; } },
    },
    authenticate: (req: any, _r: any, n: any) => { req.user = { ...DB.viewer }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  };
});

import router from "../routes/contact-insights";

const app = express();
app.use(express.json());
app.use("/api/contacts", router);

beforeEach(() => {
  DB.viewer = { userId: "admin1", role: "ADMIN", departmentId: undefined };
  DB.contacts = [
    { id: "c1", tenantId: "T", externalId: "9721", channel: "WHATSAPP" },
    { id: "c2", tenantId: "T", externalId: "9722", channel: "WHATSAPP" },
  ];
  DB.convs = [
    // c1: the newest thread is Support's; Sales has an older one.
    { id: "v_support", tenantId: "T", channel: "WHATSAPP", customerExternalId: "9721", status: "OPEN", departmentId: "support", assignedAgentId: null, lastMessageAt: 9 },
    { id: "v_sales", tenantId: "T", channel: "WHATSAPP", customerExternalId: "9721", status: "OPEN", departmentId: "sales", assignedAgentId: null, lastMessageAt: 2 },
    // c2: only another department's thread.
    { id: "v_support2", tenantId: "T", channel: "WHATSAPP", customerExternalId: "9722", status: "OPEN", departmentId: "support", assignedAgentId: null, lastMessageAt: 5 },
  ];
  DB.intel = [
    { tenantId: "T", conversationId: "v_support", summary: "Support secret: refund dispute." },
    { tenantId: "T", conversationId: "v_sales", summary: "Asked about sizes." },
  ];
});
const agentOfSales = () => { DB.viewer = { userId: "agent1", role: "AGENT", departmentId: "sales" }; };

describe("GET /insights, the viewer's latest conversation", () => {
  it("★ a Sales agent gets the latest conversation THEY may see, never Support's newer one", async () => {
    agentOfSales();
    const r = await request(app).get("/api/contacts/insights?ids=c1");
    expect(r.status).toBe(200);
    expect(r.body.data.c1).toMatchObject({ conversationId: "v_sales", situation: "Asked about sizes." });
    expect(JSON.stringify(r.body)).not.toContain("v_support");
    expect(JSON.stringify(r.body)).not.toContain("secret");
  });

  it("★ a contact whose only open thread is hidden reads as having none (null)", async () => {
    agentOfSales();
    const r = await request(app).get("/api/contacts/insights?ids=c2");
    expect(r.body.data.c2).toBeNull();
  });

  it("a thread in another department assigned to the viewer is theirs to see", async () => {
    agentOfSales();
    DB.convs[0].assignedAgentId = "agent1";
    const r = await request(app).get("/api/contacts/insights?ids=c1");
    expect(r.body.data.c1.conversationId).toBe("v_support");
  });

  it("an ADMIN still gets the latest conversation, as before", async () => {
    const r = await request(app).get("/api/contacts/insights?ids=c1,c2");
    expect(r.body.data.c1.conversationId).toBe("v_support");
    expect(r.body.data.c2.conversationId).toBe("v_support2");
  });
});
