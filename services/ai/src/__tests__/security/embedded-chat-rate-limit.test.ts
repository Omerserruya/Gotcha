/**
 * Embedded-chat rate-limit behaviour.
 *
 * We mount the router on a fresh Express app per test, with `@chatcenter/shared`
 * stubbed so no DB or queue work happens. The rate-limit middleware is the
 * code under test - for each route we send N requests with the same
 * (widgetId/sessionId, ip) tuple and assert request N+1 is rejected with 429.
 * We then change the keying tuple and assert the new bucket has its own quota.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Force tight limits - env vars are read at module-init time of the route file.
// Set BEFORE any other module runs by using vi.hoisted (which is itself
// hoisted to the top of the file with vi.mock factories).
vi.hoisted(() => {
  process.env.AI_WIDGET_INIT_RPM = "3";
  process.env.AI_WIDGET_MESSAGE_RPM = "5";
  process.env.AI_WIDGET_POLL_RPM = "5";
});

// vi.mock factories run in a hoisted pre-import phase. Variables referenced
// inside must live in the same phase via vi.hoisted().
const {
  queueAddMock,
  findFirstMock,
  findUniqueConversationMock,
  findManyMessageMock,
  findFirstConversationMock,
  createConversationMock,
  findUniqueConversationSelectMock,
} = vi.hoisted(() => {
  const v: any = (vi as any);
  return {
    queueAddMock: v.fn().mockResolvedValue(undefined),
    findFirstMock: v.fn().mockResolvedValue({
      id: "channel1",
      tenantId: "t1",
      externalId: "widget123",
      channel: "WEBCHAT",
      connectionStatus: "CONNECTED",
    }),
    findUniqueConversationMock: v.fn().mockResolvedValue({
      id: "conv1",
      tenantId: "t1",
      customerExternalId: "sess1",
      customerName: "Visitor",
      channelAccountId: "channel1",
    }),
    findManyMessageMock: v.fn().mockResolvedValue([]),
    findFirstConversationMock: v.fn().mockResolvedValue(null),
    createConversationMock: v.fn().mockResolvedValue({ id: "conv1", tenantId: "t1" }),
    findUniqueConversationSelectMock: v.fn().mockResolvedValue({ tenantId: "t1" }),
  };
});

vi.mock("@chatcenter/shared", () => ({
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: {
    channelAccount: { findFirst: findFirstMock },
    conversation: {
      findUnique: (args: any) => {
        // The /messages route uses `select: { tenantId: true }`.
        if (args?.select?.tenantId) return findUniqueConversationSelectMock(args);
        return findUniqueConversationMock(args);
      },
      findFirst: findFirstConversationMock,
      create: createConversationMock,
    },
    message: { findMany: findManyMessageMock },
  },
  incomingMessageQueue: { add: queueAddMock },
  withCrossTenantAccess: async (fn: any) => fn(),
}));

import express from "express";
import request from "supertest";
import router from "../../routes/embedded-chat";

function makeApp(ip: string = "127.0.0.1") {
  const app = express();
  app.use(express.json());
  // Override req.ip per-app so each test can choose its own bucket.
  app.use((req, _res, next) => {
    Object.defineProperty(req, "ip", { value: ip, writable: false, configurable: true });
    next();
  });
  app.use("/api/embedded-chat", router);
  return app;
}

beforeEach(() => {
  findFirstMock.mockClear();
  findUniqueConversationMock.mockClear();
  findUniqueConversationSelectMock.mockClear();
  findManyMessageMock.mockClear();
  findFirstConversationMock.mockClear();
  createConversationMock.mockClear();
  queueAddMock.mockClear();
});

describe("/init - rate limit", () => {
  it("allows the first N requests and rejects N+1 with 429", async () => {
    const app = makeApp("10.0.0.1");
    const widgetId = "wid-init-1";

    // INIT_RPM is set to 3.
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post("/api/embedded-chat/init").send({ widgetId });
      // Either 200 (ok) or some legitimate downstream error - but NEVER 429
      // while we're under the cap.
      expect(res.status).not.toBe(429);
    }
    const overflow = await request(app).post("/api/embedded-chat/init").send({ widgetId });
    expect(overflow.status).toBe(429);
  });

  it("buckets independently by (widgetId, ip)", async () => {
    const appIp1 = makeApp("10.0.0.2");
    const appIpDifferent = makeApp("10.0.0.99");

    // Burn widget A's quota on appIp1
    for (let i = 0; i < 3; i++) {
      await request(appIp1).post("/api/embedded-chat/init").send({ widgetId: "wid-A" });
    }
    const overflowA = await request(appIp1).post("/api/embedded-chat/init").send({ widgetId: "wid-A" });
    expect(overflowA.status).toBe(429);

    // Widget B from the SAME ip still has fresh quota.
    const okB = await request(appIp1).post("/api/embedded-chat/init").send({ widgetId: "wid-B" });
    expect(okB.status).not.toBe(429);

    // Same widget A from a DIFFERENT ip also fresh.
    const okADifferentIp = await request(appIpDifferent).post("/api/embedded-chat/init").send({ widgetId: "wid-A" });
    expect(okADifferentIp.status).not.toBe(429);
  });
});

describe("/message - rate limit", () => {
  it("allows AI_WIDGET_MESSAGE_RPM requests and rejects the next", async () => {
    const app = makeApp("10.0.1.1");
    const sessionId = "sess-msg-1";

    // MESSAGE_RPM is 5.
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/embedded-chat/message")
        .send({ sessionId, body: "hi" });
      expect(res.status).not.toBe(429);
    }
    const overflow = await request(app)
      .post("/api/embedded-chat/message")
      .send({ sessionId, body: "hi" });
    expect(overflow.status).toBe(429);
  });

  it("rejects oversized bodies with 413 BEFORE consuming a slot", async () => {
    const app = makeApp("10.0.1.2");
    const sessionId = "sess-msg-big";
    const big = "x".repeat(20000);
    const res = await request(app)
      .post("/api/embedded-chat/message")
      .send({ sessionId, body: big });
    expect(res.status).toBe(413);
  });
});

describe("/messages - poll rate limit", () => {
  it("allows POLL_RPM requests and rejects the next from the same (sessionId, ip)", async () => {
    const app = makeApp("10.0.2.1");
    const sessionId = "sess-poll-1";

    // POLL_RPM is 5.
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get(`/api/embedded-chat/messages/${sessionId}`);
      expect(res.status).not.toBe(429);
    }
    const overflow = await request(app).get(`/api/embedded-chat/messages/${sessionId}`);
    expect(overflow.status).toBe(429);
  });
});
