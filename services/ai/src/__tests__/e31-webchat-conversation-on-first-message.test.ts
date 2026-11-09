/**
 * Prod 2026-11-09: 13 WEBCHAT conversations with no message (two Smoovee's).
 * A returning visitor whose stored conversation was closed made /init create
 * a new, empty one on every open of the widget. Now /init answers a draft and
 * writes nothing; the first message creates the conversation under the
 * draft's own id (the widget's stored id, poll and socket stay valid).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

process.env.CHANNEL_ENCRYPTION_KEY = "test-channel-key-0123456789abcdef";

const H = vi.hoisted(() => ({ conversations: [] as any[], queued: [] as any[], created: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    withCrossTenantAccess: (fn: any) => fn(),
    incomingMessageQueue: { add: async (_n: string, data: any) => { H.queued.push(data); } },
    prisma: {
      channelAccount: {
        findFirst: async (a: any) =>
          a.where.externalId === "widget-1" || a.where.id === "ca_web"
            ? { id: "ca_web", tenantId: "T", connectionStatus: "CONNECTED" }
            : a.where.externalId === "widget-2" || a.where.id === "ca_two"
              ? { id: "ca_two", tenantId: "T2", connectionStatus: "CONNECTED" }
              : null,
        update: async () => ({}),
      },
      conversation: {
        findUnique: async (a: any) => H.conversations.find((c) => c.id === a.where.id) ?? null,
        findFirst: async (a: any) => H.conversations.find((c) =>
          c.tenantId === a.where.tenantId && c.channel === a.where.channel && c.customerExternalId === a.where.customerExternalId
          && (!a.where.status || a.where.status.in.includes(c.status))
          && (a.where.channelAccountId === undefined || c.channelAccountId === a.where.channelAccountId)) ?? null,
        create: async (a: any) => {
          if (a.data.id && H.conversations.some((c) => c.id === a.data.id)) { const e: any = new Error("unique"); e.code = "P2002"; throw e; }
          const c = { id: a.data.id ?? `conv_${H.created.length + 1}`, ...a.data }; H.created.push(c); H.conversations.push(c); return c;
        },
      },
      message: { findMany: async () => [] },
      user: { findMany: async () => [] },
      $executeRaw: async () => 1,
    },
  };
});

import router from "../routes/embedded-chat";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/embedded-chat", router); return a; };
const init = (body: any = {}) => request(app()).post("/api/embedded-chat/init").send({ widgetId: "widget-1", ...body });
const send = (sessionId: string, sessionToken: string, origin = "https://www.smoovee-ltd.com") =>
  request(app()).post("/api/embedded-chat/message").set("Origin", origin).send({ sessionId, sessionToken, body: "שלום" });

beforeEach(() => {
  H.queued = []; H.created = [];
  H.conversations = [
    { id: "conv_closed", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", customerExternalId: "sess_closed_abc", customerName: "Visitor", status: "CLOSED" },
    { id: "conv_open", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", customerExternalId: "sess_open_abc", customerName: "Visitor", status: "OPEN" },
  ];
});

describe("opening the widget writes no conversation", () => {
  it("a new visitor, and a returning one whose conversation was closed: a draft, nothing created", async () => {
    for (const body of [{}, { sessionToken: "sess_closed_abc" }]) {
      const r = await init(body);
      expect(r.status).toBe(200);
      expect(r.body.data.sessionId).toMatch(/^c[0-9a-f]{24}$/);
      expect(r.body.data.sessionToken).toMatch(/^sess_[0-9a-f]{32}_ca_web$/);
    }
    expect(H.created).toHaveLength(0);
  });

  it("an open conversation still resumes as it was", async () => {
    const r = await init({ sessionToken: "sess_open_abc" });
    expect(r.body.data.sessionId).toBe("conv_open");
    expect(H.created).toHaveLength(0);
  });

  it("the draft's poll answers no messages and creates nothing", async () => {
    const d = (await init()).body.data;
    const r = await request(app()).get(`/api/embedded-chat/messages/${d.sessionId}?token=${encodeURIComponent(d.sessionToken)}`);
    expect(r.status).toBe(404);
    expect(H.created).toHaveLength(0);
  });
});

describe("the first message creates it, under the draft's id", () => {
  it("one conversation, the draft's id and token, named from the page's host, and the message queued into it", async () => {
    const d = (await init()).body.data;
    const r = await send(d.sessionId, d.sessionToken);
    expect(r.status).toBe(200);
    expect(H.created).toHaveLength(1);
    expect(H.created[0]).toMatchObject({ id: d.sessionId, tenantId: "T", channelAccountId: "ca_web", channel: "WEBCHAT", customerExternalId: d.sessionToken, customerName: "Visitor from smoovee-ltd.com", status: "OPEN" });
    expect(H.queued).toHaveLength(1);
    expect(H.queued[0].normalizedMessage.senderId).toBe(d.sessionToken);
    // The second message goes into the same conversation.
    await send(d.sessionId, d.sessionToken);
    expect(H.created).toHaveLength(1);
    expect(H.queued).toHaveLength(2);
  });

  it("a forged token, another draft's token, or another widget's draft id never creates", async () => {
    const a = (await init()).body.data;
    const b = (await init()).body.data;
    const flip = a.sessionToken.replace(/^sess_(.)/, (_m: string, ch: string) => `sess_${ch === "0" ? "1" : "0"}`);
    expect((await send(a.sessionId, flip)).status).toBe(404);
    expect((await send(a.sessionId, b.sessionToken)).status).toBe(404);
    // A real draft of widget 1 re-labelled for widget 2.
    expect((await send(a.sessionId, a.sessionToken.replace(/_ca_web$/, "_ca_two"))).status).toBe(404);
    expect((await send("cdeadbeefdeadbeefdeadbeef", "sess_" + "0".repeat(32) + "_ca_web")).status).toBe(404);
    expect(H.created).toHaveLength(0);
    expect(H.queued).toHaveLength(0);
  });
});
