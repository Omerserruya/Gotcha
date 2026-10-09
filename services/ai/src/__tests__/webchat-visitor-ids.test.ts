/**
 * ★ The ids a web chat visitor holds are as strong as a bearer must be
 * (2026-10-09 review): the session token IS the conversation's secret, and it
 * was `sess_<ms>_<8 hex>` (32 random bits); the visitor id was 64 bits; and a
 * visitor id the client chose was trusted to resume a conversation on ANY of
 * the workspace's widgets.
 *   - /init mints a visitor id and a token of 128 bits each (32 hex)
 *   - a client's visitor id is kept only when it is that strong; the widget's
 *     own `v_<time><random>` and anything else is replaced by a minted one
 *   - a new conversation's token is always minted, never the client's choice
 *   - a token the client already holds still resumes its conversation (live
 *     visitors keep their chat), on this widget only
 *   - the visitor-id lookup is on this widget only: another widget's
 *     conversation is never resumed by sending its token as a visitor id
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// This suite calls /init many times from one address; the limiter has its own tests.
const H = vi.hoisted(() => { process.env.AI_WIDGET_INIT_RPM = "1000"; return { conversations: [] as any[], created: [] as any[] }; });

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    withCrossTenantAccess: (fn: any) => fn(),
    incomingMessageQueue: { add: async () => {} },
    prisma: {
      channelAccount: {
        findFirst: async (a: any) => (a.where.externalId === "widget-1" ? { id: "ca_web", tenantId: "T", connectionStatus: "CONNECTED" } : null),
        update: async () => ({}),
      },
      conversation: {
        // Prisma refuses a non-string where a string column is matched; so does this.
        findFirst: async (a: any) => { if (typeof a.where.customerExternalId !== "string") throw new Error("Invalid value provided"); return H.conversations.find((c) =>
          c.tenantId === a.where.tenantId && c.channel === a.where.channel && c.customerExternalId === a.where.customerExternalId
          && (a.where.channelAccountId === undefined || c.channelAccountId === a.where.channelAccountId)) ?? null; },
        create: async (a: any) => { const c = { id: `conv_${H.created.length + 1}`, ...a.data }; H.created.push(c); H.conversations.push(c); return c; },
      },
    },
  };
});

import router from "../routes/embedded-chat";

const app = express();
app.use(express.json());
app.use("/api/embedded-chat", router);
const init = (body: any) => request(app).post("/api/embedded-chat/init").send({ widgetId: "widget-1", ...body });
const STRONG = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
  H.created = [];
  H.conversations = [
    { id: "conv_live", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", customerExternalId: "sess_1728000000000_a1b2c3d4", status: "OPEN" },
    { id: "conv_foreign", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_other_widget", customerExternalId: `sess_${STRONG}`, status: "OPEN" },
  ];
});

describe("★ minted ids are 128 bits", () => {
  it("a first visit: visitor id and token of 32 hex each, and they differ", async () => {
    const r = await init({});
    expect(r.status).toBe(200);
    expect(r.body.data.visitorId).toMatch(/^visitor_[0-9a-f]{32}$/);
    expect(r.body.data.sessionToken).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(H.created[0].customerExternalId).toBe(r.body.data.sessionToken);
    const again = await init({});
    expect(again.body.data.sessionToken).not.toBe(r.body.data.sessionToken);
  });
});

describe("★ what a client may choose", () => {
  it("the widget's own weak visitor id is replaced; a 128-bit one is kept", async () => {
    expect((await init({ visitorId: "v_lq2k3x9abc12def" })).body.data.visitorId).toMatch(/^visitor_[0-9a-f]{32}$/);
    expect((await init({ visitorId: `visitor_${STRONG}` })).body.data.visitorId).toBe(`visitor_${STRONG}`);
    for (const odd of [{ $ne: null }, 12345, "short", "visitor_0123456789abcdef", `visitor_${STRONG.slice(1)}`]) {
      expect((await init({ visitorId: odd })).body.data.visitorId).toMatch(/^visitor_[0-9a-f]{32}$/);
    }
  });

  it("a token that resumes nothing never becomes the new conversation's token", async () => {
    for (const chosen of ["sess_mine", `sess_${STRONG}0`]) {
      H.created = [];
      const r = await init({ sessionToken: chosen });
      expect(r.body.data.sessionToken).not.toBe(chosen);
      expect(H.created[0].customerExternalId).toMatch(/^sess_[0-9a-f]{32}$/);
    }
  });

  it("a token that is not a string is treated as none", async () => {
    const r = await init({ sessionToken: { not: "x" } });
    expect(r.status).toBe(200);
    expect(H.created[0].customerExternalId).toMatch(/^sess_[0-9a-f]{32}$/);
  });
});

describe("★ resuming", () => {
  it("a live visitor's old-style token still resumes their conversation (sessionToken and the old sessionId)", async () => {
    expect((await init({ sessionToken: "sess_1728000000000_a1b2c3d4" })).body.data.sessionId).toBe("conv_live");
    expect((await init({ sessionId: "sess_1728000000000_a1b2c3d4" })).body.data.sessionId).toBe("conv_live");
    expect(H.created).toEqual([]);
  });

  it("another widget's conversation is never resumed, by token or by visitor id", async () => {
    for (const body of [{ sessionToken: `sess_${STRONG}` }, { visitorId: `sess_${STRONG}` }]) {
      const r = await init(body);
      expect(r.body.data.sessionId).not.toBe("conv_foreign");
      expect(r.body.data.sessionToken).not.toBe(`sess_${STRONG}`);
    }
  });

  it("a strong visitor id resumes its conversation on this widget, never on another", async () => {
    H.conversations.push({ id: "conv_foreign_visitor", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_other_widget", customerExternalId: `visitor_${STRONG}`, status: "OPEN" });
    const away = await init({ visitorId: `visitor_${STRONG}` });
    expect(away.body.data.sessionId).not.toBe("conv_foreign_visitor");
    expect(away.body.data.sessionToken).not.toBe(`visitor_${STRONG}`);
    H.conversations.push({ id: "conv_mine_visitor", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", customerExternalId: `visitor_${STRONG}`, status: "OPEN" });
    expect((await init({ visitorId: `visitor_${STRONG}` })).body.data.sessionId).toBe("conv_mine_visitor");
  });
});
