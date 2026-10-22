/**
 * Per-customer composition, handler and behaviour - counted, or declared absent.
 *
 * 04c asks what each conversation contained and who handled it, plus the
 * customer's preferred channel and responsive hours. Analytics has `/hourly`
 * and `/channel-performance` but TENANT-WIDE only, and the customer brief's
 * `signals` are LLM prose. Prose that resembles a distribution is not one, so
 * `topics` reports `available: false` rather than borrowing it.
 *
 * ★ The hour histogram is bucketed in the TENANT'S timezone and the response
 * names it. UTC would move an Israeli customer's 20:00 into the afternoon of
 * the same day and nobody reading the number could tell.
 *
 * ★ Only INBOUND messages count toward responsiveness. Outbound is us: a
 * tenant that broadcasts at 09:00 would otherwise read as a customer active at
 * 09:00, which measures our behaviour and labels it theirs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  contact: { id: "c1", tenantId: "t1", channel: "WHATSAPP", externalId: "+972500000000", mergedIntoId: null as string | null, metadata: {} as any, displayName: "Dana" },
  conversations: [] as any[],
  conversationCount: 0,
  messages: [] as any[],
  businessHours: null as string | null,
  seen: { convWhere: null as any, msgWhere: null as any },
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    contact: { findFirst: async ({ where }: any) => (where.id === state.contact.id ? state.contact : null) },
    conversation: {
      count: async () => state.conversationCount,
      findMany: async (args: any) => { state.seen.convWhere = args.where; return state.conversations.slice(0, args.take); },
    },
    message: {
      count: async () => state.messages.length,
      findMany: async (args: any) => { state.seen.msgWhere = args.where; return state.messages; },
    },
  },
  findSiblingContacts: async () => [state.contact],
  readDurableSetting: async (_t: string, key: string) => (key === "businessHours" ? state.businessHours : null),
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  requirePermission: () => (_q: any, _s: any, n: any) => n(),
  requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  normalizePhone: (p: string) => p,
  withHistoricalRecords: (fn: any) => fn(),
  writeAudit: async () => undefined,
  AuditAction: {},
}));

import identityRouter from "../routes/identity";

const app = express();
app.use(express.json());
app.use("/api/identity", identityRouter);

const msg = (o: Partial<any>) => ({
  conversationId: "cv1", direction: "INBOUND", messageType: "text",
  createdAt: new Date("2026-09-01T12:00:00.000Z"), senderName: null, ...o,
});

beforeEach(() => {
  state.contact.mergedIntoId = null;
  state.conversations = [
    { id: "cv1", channel: "WHATSAPP", origin: "LIVE", status: "OPEN", createdAt: new Date("2026-08-01T00:00:00Z"), updatedAt: new Date("2026-09-01T00:00:00Z"), assignedAgentId: null, assignedAiAgentId: "ai1" },
  ];
  state.conversationCount = 1;
  state.messages = [];
  state.businessHours = null;
  state.seen = { convWhere: null, msgWhere: null };
});

const get = (q = "") => request(app).get(`/api/identity/c1/insights${q}`);

describe("what a conversation was made of", () => {
  it("★ counts composition by message type", async () => {
    state.messages = [
      msg({}), msg({}), msg({ messageType: "image" }),
      msg({ messageType: "audio", direction: "OUTBOUND" }),
    ];

    const res = await get();

    expect(res.status).toBe(200);
    // "40 messages, 3 photos and a voice note" is the card 04c asks for.
    expect(res.body.conversations[0].composition).toEqual({ text: 2, image: 1, audio: 1 });
    expect(res.body.conversations[0].messages).toBe(4);
    expect(res.body.conversations[0].inbound).toBe(3);
    expect(res.body.conversations[0].outbound).toBe(1);
  });

  it("dates the conversation from its messages, not its row", async () => {
    state.messages = [
      msg({ createdAt: new Date("2026-08-10T09:00:00Z") }),
      msg({ createdAt: new Date("2026-08-12T11:00:00Z") }),
    ];

    const res = await get();

    expect(res.body.conversations[0].startedAt).toBe("2026-08-10T09:00:00.000Z");
    expect(res.body.conversations[0].lastAt).toBe("2026-08-12T11:00:00.000Z");
  });

  it("treats a missing messageType as text rather than dropping it", async () => {
    state.messages = [msg({ messageType: "" })];

    const res = await get();

    expect(res.body.conversations[0].composition).toEqual({ text: 1 });
  });
});

describe("who handled it, derived from what happened", () => {
  it("★ says AI when every outbound came from the bot", async () => {
    state.messages = [msg({}), msg({ direction: "OUTBOUND", senderName: "AI Bot" })];

    const res = await get();

    // senderName is the only author field, and live outbound is almost all
    // "AI Bot" - so the bot names are excluded rather than read as people.
    expect(res.body.conversations[0].handler.handledBy).toBe("AI");
    expect(res.body.conversations[0].handler.humanSenders).toEqual([]);
  });

  it("★ names the person when one actually replied", async () => {
    state.messages = [msg({}), msg({ direction: "OUTBOUND", senderName: "Yael" })];

    const res = await get();

    expect(res.body.conversations[0].handler.handledBy).toBe("HUMAN");
    expect(res.body.conversations[0].handler.humanSenders).toEqual(["Yael"]);
  });

  it("★ says UNANSWERED when nothing went out, even though an agent is assigned", async () => {
    state.messages = [msg({}), msg({})];

    const res = await get();

    // The assignment is still reported; the VERDICT comes from the messages.
    // A conversation can be assigned to a human who never replied, and saying
    // "handled by AI" there would be a claim nothing supports.
    expect(res.body.conversations[0].handler.handledBy).toBe("UNANSWERED");
    expect(res.body.conversations[0].handler.assignedAiAgentId).toBe("ai1");
  });
});

describe("the customer's own behaviour", () => {
  it("★ buckets hours in the TENANT's timezone and names it", async () => {
    state.businessHours = JSON.stringify({ timezone: "Asia/Jerusalem" });
    // 17:30 UTC is 20:30 in Jerusalem. Bucketed in UTC it would read as 17.
    state.messages = [msg({ createdAt: new Date("2026-09-01T17:30:00.000Z") })];

    const res = await get();

    expect(res.body.timezone).toBe("Asia/Jerusalem");
    expect(res.body.hours[20].inbound).toBe(1);
    expect(res.body.hours[17].inbound).toBe(0);
  });

  it("falls back to UTC and SAYS so when the tenant has no timezone", async () => {
    state.messages = [msg({ createdAt: new Date("2026-09-01T17:30:00.000Z") })];

    const res = await get();

    expect(res.body.timezone).toBe("UTC");
    expect(res.body.hours[17].inbound).toBe(1);
  });

  it("falls back to UTC rather than throwing on a nonsense timezone", async () => {
    state.businessHours = JSON.stringify({ timezone: "Mars/Olympus" });
    state.messages = [msg({ createdAt: new Date("2026-09-01T17:30:00.000Z") })];

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("UTC");
  });

  it("★ counts only INBOUND toward responsive hours", async () => {
    state.messages = [
      msg({ direction: "OUTBOUND", createdAt: new Date("2026-09-01T09:00:00.000Z") }),
      msg({ direction: "OUTBOUND", createdAt: new Date("2026-09-01T09:05:00.000Z") }),
      msg({ direction: "INBOUND", createdAt: new Date("2026-09-01T21:00:00.000Z") }),
    ];

    const res = await get();

    // A tenant broadcasting at 09:00 must not appear as a customer active then.
    expect(res.body.hours[9].inbound).toBe(0);
    expect(res.body.hours[21].inbound).toBe(1);
  });

  it("returns all 24 hours, including the empty ones", async () => {
    state.messages = [msg({})];

    const res = await get();

    // A sparse array would let a chart infer a shape from missing buckets.
    expect(res.body.hours).toHaveLength(24);
    expect(res.body.hours.map((h: any) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it("★ states the BASIS of the preferred channel", async () => {
    state.conversations.push({ id: "cv2", channel: "EMAIL", origin: "LIVE", status: "OPEN", createdAt: new Date(), updatedAt: new Date(), assignedAgentId: null, assignedAiAgentId: null });
    state.conversationCount = 2;
    state.messages = [msg({}), msg({}), msg({ conversationId: "cv2" })];

    const res = await get();

    // "where they write most", not a preference they stated.
    expect(res.body.preferredChannel).toMatchObject({ channel: "WHATSAPP", basis: "most_inbound_messages", inbound: 2 });
    expect(res.body.channels[0].channel).toBe("WHATSAPP");
  });

  it("has no preferred channel when the customer has never written", async () => {
    state.messages = [msg({ direction: "OUTBOUND", senderName: "AI Bot" })];

    const res = await get();

    // Null, not the only channel we happened to message them on.
    expect(res.body.preferredChannel).toBeNull();
  });
});

describe("what it refuses to make up", () => {
  it("★ declares topics ABSENT rather than borrowing the brief's prose", async () => {
    state.messages = [msg({})];

    const res = await get();

    // HistoricalImport.topTopics is per import; the brief's `signals` are LLM
    // prose. Neither is a per-customer distribution.
    expect(res.body.topics).toEqual({ available: false, reason: "no_topic_store" });
  });

  it("★ names origin in the query, in both directions", async () => {
    await get();
    expect(state.seen.convWhere.origin).toEqual({ in: ["LIVE", "HISTORICAL_IMPORT"] });
    expect(state.seen.msgWhere.origin).toEqual({ in: ["LIVE", "HISTORICAL_IMPORT"] });

    await get("?includeImported=false");
    // Named even here: omitting it would let the guard inject the same value,
    // and a row-level assertion could not tell the difference.
    expect(state.seen.convWhere.origin).toBe("LIVE");
    expect(state.seen.msgWhere.origin).toBe("LIVE");
  });

  it("answers an empty shape, not an error, for a contact with no conversations", async () => {
    state.conversations = [];
    state.conversationCount = 0;

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([]);
    expect(res.body.preferredChannel).toBeNull();
    expect(res.body.topics.available).toBe(false);
  });

  it("discloses a truncated conversation scan", async () => {
    state.conversationCount = 900;
    state.messages = [msg({})];

    const res = await get();

    expect(res.body.totals.conversations).toBe(900);
    expect(res.body.totals.conversationScanTruncated).toBe(true);
  });

  it("404s an unknown contact", async () => {
    const res = await request(app).get("/api/identity/nope/insights");

    expect(res.status).toBe(404);
  });
});
