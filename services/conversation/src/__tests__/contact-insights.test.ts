/**
 * Customers list (04): the per-row situation / mood / message counts, and bulk
 * tags. Tenant-guarded in-memory doubles; the REAL isFrustrated and
 * normalizeConversationIntent decide the mood, so the list and the queue
 * ranker cannot disagree about who is upset.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const DB = vi.hoisted(() => ({ contacts: [] as any[], convs: [] as any[], intel: [] as any[], messages: [] as any[] }));
const guard = (m: string, w: any) => { if (!w?.tenantId) throw new Error(`tenant guard: ${m}`); };

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const prisma: any = {
    contact: {
      findMany: async (a: any) => { guard("contact", a.where); return DB.contacts.filter((c) => c.tenantId === a.where.tenantId && a.where.id.in.includes(c.id)); },
      updateMany: (a: any) => ({ __op: () => { guard("contact", a.where); const c = DB.contacts.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId); if (c) c.tags = a.data.tags; return { count: c ? 1 : 0 }; } }),
    },
    conversation: {
      findFirst: async (a: any) => {
        guard("conversation", a.where);
        return DB.convs
          .filter((c) => c.tenantId === a.where.tenantId && c.channel === a.where.channel && c.customerExternalId === a.where.customerExternalId && c.status !== "CLOSED")
          .sort((x, y) => y.lastMessageAt - x.lastMessageAt)[0] ?? null;
      },
    },
    conversationIntelligence: { findFirst: async (a: any) => { guard("intel", a.where); return DB.intel.find((i) => i.conversationId === a.where.conversationId) ?? null; } },
    message: {
      count: async (a: any) => {
        guard("message", a.where);
        return DB.messages.filter((m) => m.conversationId === a.where.conversationId && m.messageType !== "system" && (!a.where.direction || m.direction === a.where.direction)).length;
      },
    },
  };
  prisma.$transaction = async (ops: any[]) => ops.map((o) => o.__op());
  return {
    ...actual,
    prisma,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  };
});

import router, { moodOf, situationOf, normalizeTag } from "../routes/contact-insights";

const app = express();
app.use(express.json());
app.use("/api/contacts", router);

beforeEach(() => {
  DB.contacts = [
    { id: "c1", tenantId: "T", externalId: "972501", channel: "WHATSAPP", tags: ["VIP"] },
    { id: "c2", tenantId: "T", externalId: "972502", channel: "WHATSAPP", tags: [] },
    { id: "cX", tenantId: "OTHER", externalId: "972503", channel: "WHATSAPP", tags: [] },
  ];
  DB.convs = [
    { id: "v1", tenantId: "T", channel: "WHATSAPP", customerExternalId: "972501", status: "OPEN", lastMessageAt: 2 },
    { id: "v0", tenantId: "T", channel: "WHATSAPP", customerExternalId: "972501", status: "CLOSED", lastMessageAt: 9 },
  ];
  DB.intel = [{ conversationId: "v1", summary: "Waiting on order #1842 and asked three times. Wants an update.", detectedIntent: "unknown", sentiment: "negative", sentimentScore: -0.8 }];
  DB.messages = [
    { conversationId: "v1", direction: "INBOUND", messageType: "text" },
    { conversationId: "v1", direction: "INBOUND", messageType: "text" },
    { conversationId: "v1", direction: "INBOUND", messageType: "text" },
    { conversationId: "v1", direction: "OUTBOUND", messageType: "text" },
    { conversationId: "v1", direction: "INBOUND", messageType: "system" },
  ];
});

describe("GET /insights", () => {
  it("★ the latest OPEN conversation's first summary sentence, counts, and mood", async () => {
    const r = await request(app).get("/api/contacts/insights?ids=c1,c2");
    expect(r.body.data.c1).toEqual({
      conversationId: "v1",
      situation: "Waiting on order #1842 and asked three times.",
      messageCount: 4,
      inboundCount: 3,
      mood: "frustrated",
    });
    // No open conversation: null, not an empty story.
    expect(r.body.data.c2).toBeNull();
  });

  it("★ another tenant's contact is not returned", async () => {
    const r = await request(app).get("/api/contacts/insights?ids=cX");
    expect(r.body.data).toEqual({});
  });

  it("an unanalysed conversation has no situation and no mood - nothing invented", async () => {
    DB.intel = [];
    const r = await request(app).get("/api/contacts/insights?ids=c1");
    expect(r.body.data.c1).toMatchObject({ situation: null, mood: null, inboundCount: 3 });
  });
});

describe("moodOf / situationOf", () => {
  it("HIGH_INTENT is about_to_buy; neutral is nothing", () => {
    expect(moodOf({ detectedIntent: "HIGH_INTENT", sentiment: "positive" })).toBe("about_to_buy");
    expect(moodOf({ detectedIntent: "unknown", sentiment: "neutral" })).toBeNull();
    expect(moodOf(null)).toBeNull();
  });
  it("★ a structured summary becomes one plain line; placeholders are null", () => {
    expect(situationOf("• **למה פנה**: בקשה להחזר חלקי בסכום 50$ עבור הזמנה מס׳ 1011.  \n• **מה ביקש/ה**: \n  - האם ניתן")).toBe("בקשה להחזר חלקי בסכום 50$ עבור הזמנה מס׳ 1011.");
    expect(situationOf("• **Why they reached out**: asked about #1842. Then more.")).toBe("asked about #1842.");
    expect(situationOf("Failed to generate summary.")).toBeNull();
    expect(situationOf("No messages to summarize.")).toBeNull();
  });

  it("caps a long sentence", () => {
    expect(situationOf("x".repeat(300))!.length).toBeLessThanOrEqual(140);
    expect(situationOf("  ")).toBeNull();
  });
});

describe("POST /tags", () => {
  it("★ adds and removes across several contacts, exact match, all at once", async () => {
    const r = await request(app).post("/api/contacts/tags").send({ contactIds: ["c1", "c2"], add: ["  uitest  "], remove: ["VIP"] });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ c1: ["uitest"], c2: ["uitest"] });
    expect(DB.contacts.find((c) => c.id === "c1").tags).toEqual(["uitest"]);
  });

  it("★ 'vip' is not 'VIP' - removing the wrong case removes nothing", async () => {
    await request(app).post("/api/contacts/tags").send({ contactIds: ["c1"], remove: ["vip"] });
    expect(DB.contacts.find((c) => c.id === "c1").tags).toEqual(["VIP"]);
  });

  it("★ a contact of another tenant in the list → 404 and nothing written", async () => {
    const r = await request(app).post("/api/contacts/tags").send({ contactIds: ["c1", "cX"], add: ["x"] });
    expect(r.status).toBe(404);
    expect(DB.contacts.find((c) => c.id === "c1").tags).toEqual(["VIP"]);
  });

  it("invalid tags and empty requests are refused", async () => {
    expect((await request(app).post("/api/contacts/tags").send({ contactIds: ["c1"], add: ["x".repeat(41)] })).body.error).toBe("invalid_tag");
    expect((await request(app).post("/api/contacts/tags").send({ contactIds: ["c1"], add: [""] })).body.error).toBe("invalid_tag");
    expect((await request(app).post("/api/contacts/tags").send({ contactIds: ["c1"] })).body.error).toBe("nothing_to_change");
    expect(normalizeTag(" a  b ")).toBe("a b");
  });
});
