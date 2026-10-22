/**
 * GET /api/identity/:id/conversations - a person's conversations across
 * channels, with a cleaned one-line summary, through the REAL router.
 *
 * The double evaluates the real `where` (AND / OR / in / null equality), so
 * the person scope and the viewer's visibility are both actually applied -
 * dropping either fails here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  viewer: { userId: "admin1", role: "ADMIN", departmentId: undefined as string | undefined },
  contacts: [] as any[],
  convs: [] as any[],
  msgs: [] as any[],
  intel: [] as any[],
}));

function matches(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "AND") return (v as any[]).every((w) => matches(row, w));
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("not" in v) return row[k] !== v.not;
    }
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", () => ({
  authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.viewer }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  isFrustrated: () => false,
  normalizeConversationIntent: (x: any) => x,
  findSiblingContacts: async (_t: string, c: any) => H.contacts.filter((x) => x.personId && x.personId === c.personId),
  prisma: {
    contact: { findFirst: async (a: any) => H.contacts.find((c) => matches(c, a.where)) ?? null },
    conversation: {
      count: async (a: any) => { if (!a.where.tenantId) throw new Error("tenant guard"); return H.convs.filter((c) => matches(c, a.where)).length; },
      findMany: async (a: any) => {
        if (!a.where.tenantId) throw new Error("tenant guard");
        return H.convs.filter((c) => matches(c, a.where))
          .sort((x, y) => y.lastMessageAt - x.lastMessageAt).slice(0, a.take);
      },
    },
    message: {
      groupBy: async (a: any) => {
        const rows = H.msgs.filter((m) => matches(m, a.where));
        const by = new Map<string, number>();
        for (const m of rows) by.set(m.conversationId, (by.get(m.conversationId) ?? 0) + 1);
        return [...by].map(([conversationId, n]) => ({ conversationId, _count: { _all: n } }));
      },
    },
    conversationIntelligence: { findMany: async (a: any) => H.intel.filter((i) => matches(i, a.where)) },
  },
}));

import identityRouter from "../routes/identity";

const app = express();
app.use(express.json());
app.use("/api/identity", identityRouter);

const at = (d: number) => new Date(Date.UTC(2026, 9, d));
const conv = (id: string, o: any) => ({ id, tenantId: "T", origin: "LIVE", departmentId: null, assignedAgentId: null, status: "OPEN", createdAt: at(1), ...o });

beforeEach(() => {
  H.viewer = { userId: "admin1", role: "ADMIN", departmentId: undefined };
  // One person, two handles (WhatsApp + Instagram), and an unrelated contact.
  H.contacts = [
    { id: "k_wa", tenantId: "T", channel: "WHATSAPP", externalId: "9725", personId: "p1", mergedIntoId: null, metadata: {} },
    { id: "k_ig", tenantId: "T", channel: "INSTAGRAM", externalId: "ig_dana", personId: "p1", mergedIntoId: null, metadata: {} },
    { id: "k_other", tenantId: "T", channel: "WHATSAPP", externalId: "9999", personId: "p2", mergedIntoId: null, metadata: {} },
  ];
  H.convs = [
    conv("c_wa", { channel: "WHATSAPP", customerExternalId: "9725", lastMessageAt: at(5), departmentId: "sales" }),
    conv("c_ig", { channel: "INSTAGRAM", customerExternalId: "ig_dana", lastMessageAt: at(3), departmentId: "support", status: "CLOSED" }),
    conv("c_other", { channel: "WHATSAPP", customerExternalId: "9999", lastMessageAt: at(9) }),
    conv("c_other_tenant", { tenantId: "X", channel: "WHATSAPP", customerExternalId: "9725", lastMessageAt: at(9) }),
  ];
  H.msgs = [
    { tenantId: "T", conversationId: "c_wa", messageType: "text" },
    { tenantId: "T", conversationId: "c_wa", messageType: "text" },
    { tenantId: "T", conversationId: "c_wa", messageType: "system" },
    { tenantId: "T", conversationId: "c_ig", messageType: "text" },
  ];
  H.intel = [
    { tenantId: "T", conversationId: "c_wa", summary: "- **Summary:** Asked about the blue dress in size M.\n- Next: send link" },
    { tenantId: "T", conversationId: "c_ig", summary: "**Summary:** -" },
  ];
});

const get = (q = "") => request(app).get(`/api/identity/k_wa/conversations${q}`);

describe("GET /api/identity/:id/conversations", () => {
  it("★ every channel of the person, newest first, with counts and a cleaned summary", async () => {
    const r = await get("?current=c_wa");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.data.map((c: any) => c.conversationId)).toEqual(["c_wa", "c_ig"]);
    expect(r.body.data[0]).toMatchObject({
      channel: "WHATSAPP", status: "OPEN", messageCount: 2, isCurrent: true,
      summary: "Asked about the blue dress in size M.",
    });
    // A placeholder summary is null, not "-".
    expect(r.body.data[1]).toMatchObject({ channel: "INSTAGRAM", status: "CLOSED", summary: null, isCurrent: false, messageCount: 1 });
  });

  it("★ a department-restricted agent does not see another department's conversation", async () => {
    H.viewer = { userId: "agent1", role: "AGENT", departmentId: "sales" };
    const r = await get();
    expect(r.body.data.map((c: any) => c.conversationId)).toEqual(["c_wa"]);
    expect(r.body.total).toBe(1);
  });

  it("limit and hasMore", async () => {
    const r = await get("?limit=1");
    expect(r.body.data).toHaveLength(1);
    expect(r.body).toMatchObject({ total: 2, hasMore: true });
  });

  it("another tenant's contact is a 404, not an empty history", async () => {
    expect((await request(app).get("/api/identity/k_missing/conversations")).status).toBe(404);
  });
});
