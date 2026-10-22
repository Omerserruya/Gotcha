/**
 * Every route addressed by a conversation id applies the SAME visibility as
 * the inbox list: a department-restricted agent gets 404 (not 403) for another
 * department's conversation - its detail, its messages, and its actions - and
 * an admin gets it. Through the real routers; the prisma double evaluates the
 * real visibility OR, so dropping the clause or the guard fails here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  viewer: { userId: "admin1", role: "ADMIN", departmentId: undefined as string | undefined },
  convs: [] as any[],
  messagesCalled: 0,
  claimCalled: 0,
}));

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (k === "AND") return (v as any[]).every((w) => matches(row, w));
    if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", () => ({
  authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.viewer }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  validate: () => (_q: any, _s: any, n: any) => n(),
  latestHandover: async () => null,
  getInternalServiceKey: () => "k",
  readDurableSetting: async () => null,
  recordHandover: async () => undefined,
  publishEvent: async () => undefined,
  withHistoricalRecords: (fn: any) => fn(),
  outgoingMessageQueue: { add: async () => undefined },
  notificationsQueue: { add: async () => undefined },
  decryptCredentials: (x: any) => x,
  prisma: {
    conversation: {
      findFirst: async (a: any) => H.convs.find((c) => matches(c, a.where)) ?? null,
      findMany: async (a: any) => H.convs.filter((c) => matches(c, a.where)).map((c) => ({ ...c, messages: [], _count: { messages: 0 }, assignedAgent: null })),
    },
    contact: { findMany: async () => [] },
  },
}));
vi.mock("../services/message.service", () => ({
  listByConversation: async () => { H.messagesCalled++; return { data: [{ id: "m1", body: "secret" }] }; },
}));

import conversationRoutes from "../routes/conversations";
import messageRoutes from "../routes/messages";
import * as conversationService from "../services/conversation.service";

const app = express();
app.use(express.json());
app.use("/api/conversations", conversationRoutes);
app.use("/api/conversations", messageRoutes);

beforeEach(() => {
  H.viewer = { userId: "admin1", role: "ADMIN", departmentId: undefined };
  H.convs = [
    { id: "c_sales", tenantId: "T", departmentId: "sales", assignedAgentId: null, channel: "WHATSAPP", customerExternalId: "9725", messages: [] },
    { id: "c_support", tenantId: "T", departmentId: "support", assignedAgentId: null, channel: "WHATSAPP", customerExternalId: "9725", messages: [] },
  ];
  H.messagesCalled = 0;
  vi.spyOn(conversationService, "claim").mockImplementation(async () => { H.claimCalled++; return { id: "c" } as any; });
});

const agentOfSales = () => { H.viewer = { userId: "agent1", role: "AGENT", departmentId: "sales" }; };

describe("★ a department-restricted agent cannot open another department's conversation by id", () => {
  it("GET /:id → 404 for support, 200 for sales", async () => {
    agentOfSales();
    expect((await request(app).get("/api/conversations/c_support")).status).toBe(404);
    expect((await request(app).get("/api/conversations/c_sales")).status).toBe(200);
  });

  it("GET /:conversationId/messages → 404, and the messages are never read", async () => {
    agentOfSales();
    const r = await request(app).get("/api/conversations/c_support/messages");
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain("secret");
    expect(H.messagesCalled).toBe(0);
  });

  it("an action by id (claim) → 404 before the handler runs", async () => {
    agentOfSales();
    H.claimCalled = 0;
    expect((await request(app).post("/api/conversations/c_support/claim")).status).toBe(404);
    expect(H.claimCalled).toBe(0);
  });

  it("404 is the same answer as a conversation that does not exist (no probing)", async () => {
    agentOfSales();
    const hidden = await request(app).get("/api/conversations/c_support");
    const missing = await request(app).get("/api/conversations/nope");
    expect([hidden.status, hidden.body]).toEqual([missing.status, missing.body]);
  });

  it("the customer's history omits the other department's thread", async () => {
    agentOfSales();
    const r = await request(app).get("/api/conversations/history/9725");
    expect(r.body.data.map((c: any) => c.id)).toEqual(["c_sales"]);
  });
});

describe("admin is unrestricted, as in the list", () => {
  it("GET /:id, messages and history for both departments", async () => {
    expect((await request(app).get("/api/conversations/c_support")).status).toBe(200);
    expect((await request(app).get("/api/conversations/c_support/messages")).status).toBe(200);
    expect((await request(app).get("/api/conversations/history/9725")).body.data).toHaveLength(2);
  });
});
