/**
 * ★ The public web chat routes need the visitor's session token, not just a
 * conversation id (ids show up in URLs and logs):
 *   - /messages/:id without the token, or with another conversation's token → 404, nothing read
 *   - /message without it → 404, nothing queued; ★ never into a non-web-chat
 *     conversation (a WhatsApp conversation's id used to accept a "visitor" message)
 *   - with the right token both work
 *   - /init returns the token and resumes the visitor's conversation with it,
 *     only on this widget's own account
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ conversations: [] as any[], queued: [] as any[], messageReads: 0, created: [] as any[], raw: [] as any[], rows: null as any[] | null, lastWhere: null as any }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    withCrossTenantAccess: (fn: any) => fn(),
    incomingMessageQueue: { add: async (_n: string, data: any) => { H.queued.push(data); } },
    prisma: {
      channelAccount: {
        findFirst: async (a: any) => (a.where.externalId === "widget-1" ? { id: "ca_web", tenantId: "T", connectionStatus: "CONNECTED" } : null),
        update: async () => ({}),
      },
      conversation: {
        findUnique: async (a: any) => H.conversations.find((c) => c.id === a.where.id) ?? null,
        findFirst: async (a: any) => H.conversations.find((c) =>
          c.tenantId === a.where.tenantId && c.channel === a.where.channel && c.customerExternalId === a.where.customerExternalId
          && (a.where.channelAccountId === undefined || c.channelAccountId === a.where.channelAccountId)) ?? null,
        create: async (a: any) => { const c = { id: `conv_${H.created.length + 1}`, ...a.data }; H.created.push(c); H.conversations.push(c); return c; },
      },
      message: { findMany: async (a: any) => { H.lastWhere = a?.where; H.messageReads++; return H.rows ?? [{ id: "m1", direction: "OUTBOUND", body: "hi", senderName: "AI", createdAt: new Date(0) }]; } },
      user: {
        findMany: async (a: any) =>
          a.where.tenantId === "T" && a.where.email.in.includes("tehila@shop.co.il") ? [{ email: "tehila@shop.co.il", name: "תהילה רוזן" }] : [],
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => { H.raw.push({ sql: strings.join("?"), values }); return 1; },
    },
  };
});

import router from "../routes/embedded-chat";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/embedded-chat", router); return a; };

beforeEach(() => {
  H.queued = []; H.messageReads = 0; H.created = []; H.raw = []; H.rows = null;
  H.conversations = [
    { id: "conv_web", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", customerExternalId: "sess_secret_abc", customerName: "Visitor", status: "OPEN" },
    { id: "conv_other", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", customerExternalId: "sess_other_xyz", customerName: "Other", status: "OPEN" },
    { id: "conv_wa", tenantId: "T", channel: "WHATSAPP", channelAccountId: "ca_wa", customerExternalId: "972501234567", customerName: "Dana", status: "OPEN" },
  ];
});

describe("★ reading a conversation needs its visitor token", () => {
  it("no token, a wrong token, another conversation's token, a non-web-chat conversation → 404 and nothing read", async () => {
    for (const url of [
      "/api/embedded-chat/messages/conv_web",
      "/api/embedded-chat/messages/conv_web?token=guess",
      "/api/embedded-chat/messages/conv_web?token=sess_other_xyz",
      "/api/embedded-chat/messages/conv_wa?token=972501234567",
    ]) {
      expect((await request(app()).get(url)).status).toBe(404);
    }
    expect(H.messageReads).toBe(0);
  });

  it("with its own token it reads", async () => {
    const r = await request(app()).get("/api/embedded-chat/messages/conv_web?token=sess_secret_abc");
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });
});

describe("★ who wrote it, as the widget draws it", () => {
  // One Of A Kind, 2026-11-02: the owner's replies were drawn as the
  // assistant's, under a "connecting you" banner only an agent's message closes.
  it("a reply typed in the inbox is a person's, by their first name; the assistant's stays unlabelled", async () => {
    H.rows = [
      { id: "m1", direction: "OUTBOUND", body: "hi", senderName: "AI Bot", createdAt: new Date(0) },
      { id: "m2", direction: "OUTBOUND", body: "זאת תהילה", senderName: "tehila@shop.co.il", createdAt: new Date(1) },
      { id: "m3", direction: "INBOUND", body: "תודה", senderName: "Visitor", createdAt: new Date(2) },
    ];
    const r = await request(app()).get("/api/embedded-chat/messages/conv_web?token=sess_secret_abc");
    expect(r.status).toBe(200);
    expect(r.body.data.map((m: any) => [m.authorKind, m.author])).toEqual([["ai", null], ["agent", "תהילה"], ["visitor", null]]);
    expect(JSON.stringify(r.body)).not.toContain("@");
  });

  // A handoff's system row drew as an EMPTY shopper bubble in the widget (dev walk, 2026-11-03).
  it("the team's system rows are never read for the shopper", async () => {
    await request(app()).get("/api/embedded-chat/messages/conv_web?token=sess_secret_abc");
    expect(H.lastWhere.messageType).toEqual({ not: "system" });
  });
});

describe("★ writing needs it too, and only into a web chat conversation", () => {
  it("no token / wrong token / a WhatsApp conversation → 404, nothing queued", async () => {
    for (const body of [
      { sessionId: "conv_web", body: "hello" },
      { sessionId: "conv_web", sessionToken: "guess", body: "hello" },
      { sessionId: "conv_wa", sessionToken: "972501234567", body: "injected" },
    ]) {
      expect((await request(app()).post("/api/embedded-chat/message").send(body)).status).toBe(404);
    }
    expect(H.queued).toEqual([]);
  });

  it("with the token the message is queued for that conversation", async () => {
    const r = await request(app()).post("/api/embedded-chat/message").send({ sessionId: "conv_web", sessionToken: "sess_secret_abc", body: "hello" });
    expect(r.status).toBe(200);
    expect(H.queued[0]).toMatchObject({ tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", normalizedMessage: { body: "hello", senderId: "sess_secret_abc" } });
  });
});

describe("/init: the token, and resuming with it", () => {
  it("returns the conversation's token; the same token resumes the same conversation", async () => {
    const first = await request(app()).post("/api/embedded-chat/init").send({ widgetId: "widget-1" });
    expect(first.status).toBe(200);
    const { sessionId, sessionToken } = first.body.data;
    expect(sessionToken).toBe(H.conversations.find((c) => c.id === sessionId).customerExternalId);
    const again = await request(app()).post("/api/embedded-chat/init").send({ widgetId: "widget-1", sessionToken });
    expect(again.body.data.sessionId).toBe(sessionId);
    expect(H.created).toHaveLength(1);
  });

  it("another widget's (or channel's) conversation is never resumed", async () => {
    H.conversations.push({ id: "conv_foreign", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_other_widget", customerExternalId: "sess_foreign", status: "OPEN" });
    const r = await request(app()).post("/api/embedded-chat/init").send({ widgetId: "widget-1", sessionToken: "sess_foreign" });
    expect(r.body.data.sessionId).not.toBe("conv_foreign");
  });
});

describe("/bootstrap records where the snippet runs (Install's last seen + host)", () => {
  it("a page load records the page's host from Origin, on this widget's account", async () => {
    const r = await request(app()).post("/api/embedded-chat/bootstrap").set("Origin", "https://Shop.Example.com").send({ widgetId: "widget-1" });
    expect(r.status).toBe(200);
    await new Promise((ok) => setImmediate(ok));
    expect(H.raw).toHaveLength(1);
    expect(H.raw[0].sql).toContain("last_health_check");
    expect(H.raw[0].values).toEqual(expect.arrayContaining(["ca_web", "shop.example.com"]));
  });

  it("an unknown widget records nothing", async () => {
    await request(app()).post("/api/embedded-chat/bootstrap").set("Origin", "https://x.com").send({ widgetId: "nope" });
    await new Promise((ok) => setImmediate(ok));
    expect(H.raw).toEqual([]);
  });
});
