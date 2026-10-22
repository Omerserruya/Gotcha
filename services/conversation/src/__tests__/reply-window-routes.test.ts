/**
 * An agent's reply outside the customer-service window is refused before
 * anything is written (B7, 2026-10-12): 409 TEMPLATE_REQUIRED on WhatsApp,
 * 409 REPLY_WINDOW_CLOSED on Instagram/Messenger, with the window, so the
 * composer can offer a template or say why. No message row, no queued send,
 * no stored upload. The rule is packages/shared lib/reply-window.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  prisma: {
    conversation: { findFirst: vi.fn(), update: vi.fn() },
    message: { findFirst: vi.fn(), findMany: vi.fn() },
    messageTemplate: {
      // Honours what the route asks for: approved, active, WhatsApp, this number or none.
      findMany: vi.fn(async ({ where }: any) => {
        const accounts = where.AND[0].OR.map((o: any) => o.channelAccountId);
        return H.templates.filter((t: any) => t.tenantId === where.tenantId && t.status === where.status && t.isActive === where.isActive
          && (t.channel === "WHATSAPP" || t.channel === null) && accounts.includes(t.channelAccountId));
      }),
    },
  },
  templates: [] as any[],
  queue: { add: vi.fn() },
  messageCreate: vi.fn(async (d: any) => ({ id: "m1", ...d })),
  lastInbound: null as Date | null,
  lookupFails: false,
  lookups: [] as any[],
}));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: H.prisma,
    outgoingMessageQueue: H.queue,
    authenticate: (req: any, _res: any, next: any) => { req.user = { userId: "u_agent", email: "agent@acme.test" }; next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "t1"; next(); },
    requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    validate: (schema: any) => (req: any, res: any, next: any) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid" });
      req.body = parsed.data;
      next();
    },
    decryptCredentials: (v: any) => v,
    lastInboundAtForRecipient: vi.fn(async (a: any) => {
      H.lookups.push(a);
      if (H.lookupFails) throw new Error("db blip");
      return H.lastInbound;
    }),
  };
});
vi.mock("../lib/socket", () => ({ getIO: () => null }));
vi.mock("../lib/require-visible-conversation", () => ({ requireVisibleConversation: (_q: any, _s: any, n: any) => n() }));
vi.mock("../services/message.service", () => ({ create: H.messageCreate, listByConversation: vi.fn() }));

import messagesRouter from "../routes/messages";
const app = express();
app.use(express.json());
app.use("/api/conversations", messagesRouter);

const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);
const on = (channel: string, customerExternalId = "972541111111") => ({
  id: "c1", tenantId: "t1", channel, customerExternalId, channelAccountId: "ca1",
  channelAccount: { id: "ca1", credentials: { accessToken: "at_1" } },
});
const send = (body: any = { body: "Hi again" }) => request(app).post("/api/conversations/c1/messages").send(body);

beforeEach(() => {
  vi.clearAllMocks();
  H.lastInbound = null; H.lookupFails = false; H.lookups = [];
  const t = (id: string, over: any = {}) => ({ id, tenantId: "t1", name: `tpl_${id}`, language: "he", category: "UTILITY", channel: "WHATSAPP", channelAccountId: "ca1", status: "APPROVED", isActive: true,
    body: "Hi {{1}}, we have a reply for you", headerType: null, headerContent: null, footer: null, buttons: [{ type: "QUICK_REPLY", text: "Continue" }], variables: [{ key: "1", sample: "there" }], ...over });
  H.templates = [
    t("ok"),
    t("unbound", { channelAccountId: null }),
    t("other_number", { channelAccountId: "ca2" }),
    t("pending", { status: "PENDING_APPROVAL" }),
    t("inactive", { isActive: false }),
    t("theirs", { tenantId: "t2" }),
  ];
});

describe("★ WhatsApp", () => {
  it("past 24h: 409 TEMPLATE_REQUIRED with the window, nothing written or queued", async () => {
    H.prisma.conversation.findFirst.mockResolvedValue(on("WHATSAPP"));
    H.lastInbound = hoursAgo(30);
    const r = await send();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "TEMPLATE_REQUIRED", replyWindow: { channel: "WHATSAPP", open: false, mode: "template_only", closesAt: null } });
    expect(H.messageCreate).not.toHaveBeenCalled();
    expect(H.queue.add).not.toHaveBeenCalled();
    expect(H.lookups).toEqual([{ tenantId: "t1", channel: "WHATSAPP", channelAccountId: "ca1", customerExternalId: "972541111111" }]);
  });

  it("a client claiming messageType 'template' on this route is still refused", async () => {
    H.prisma.conversation.findFirst.mockResolvedValue(on("WHATSAPP"));
    H.lastInbound = hoursAgo(30);
    expect((await send({ body: "x", messageType: "template" })).status).toBe(409);
  });

  it("inside 24h: sent", async () => {
    H.prisma.conversation.findFirst.mockResolvedValue(on("WHATSAPP"));
    H.lastInbound = hoursAgo(2);
    expect((await send()).status).toBe(201);
    expect(H.queue.add).toHaveBeenCalledTimes(1);
  });
});

describe("★ Instagram past 24h", () => {
  it("409 REPLY_WINDOW_CLOSED", async () => {
    H.prisma.conversation.findFirst.mockResolvedValue(on("INSTAGRAM", "1031990639501705"));
    H.lastInbound = hoursAgo(30);
    const r = await send();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "REPLY_WINDOW_CLOSED", replyWindow: { mode: "closed" } });
  });
});

describe("media", () => {
  it("past 24h on WhatsApp: refused before the upload is read or stored", async () => {
    H.prisma.conversation.findFirst.mockResolvedValue(on("WHATSAPP"));
    H.lastInbound = hoursAgo(30);
    // Not even multipart: the window answers first.
    const r = await request(app).post("/api/conversations/c1/messages/media").send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("TEMPLATE_REQUIRED");
    expect(H.messageCreate).not.toHaveBeenCalled();
  });
});

describe("no window, or unreadable", () => {
  it("email: no lookup, sent", async () => {
    H.prisma.conversation.findFirst.mockResolvedValue(on("GMAIL", "buyer@x.test"));
    expect((await send()).status).toBe(201);
    expect(H.lookups).toHaveLength(0);
  });

  it("an unreadable window lets the reply through (the worker and Meta still decide)", async () => {
    H.prisma.conversation.findFirst.mockResolvedValue(on("WHATSAPP"));
    H.lookupFails = true;
    expect((await send()).status).toBe(201);
  });
});

describe("★ templates in a conversation", () => {
  const sendTpl = (body: any) => request(app).post("/api/conversations/c1/messages/template").send(body);

  it("lists only approved, active templates of this number (or unbound), with their placeholders", async () => {
    H.prisma.conversation.findFirst.mockResolvedValue(on("WHATSAPP"));
    const r = await request(app).get("/api/conversations/c1/reply-templates");
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.id).sort()).toEqual(["ok", "unbound"]);
    expect(r.body.data.find((x: any) => x.id === "ok")).toMatchObject({ name: "tpl_ok", language: "he", placeholders: [{ key: "1", sample: "there" }] });
  });

  it("not WhatsApp: an empty list", async () => {
    H.prisma.conversation.findFirst.mockResolvedValue(on("INSTAGRAM", "1031990639501705"));
    expect((await request(app).get("/api/conversations/c1/reply-templates")).body.data).toEqual([]);
  });

  it("★ past 24h a template is sent: the customer's text stored, the components queued", async () => {
    H.prisma.conversation.findFirst.mockResolvedValue(on("WHATSAPP"));
    H.lastInbound = hoursAgo(30);
    const r = await sendTpl({ templateId: "ok", variables: { "1": "Dana" } });
    expect(r.status).toBe(201);
    expect(H.messageCreate).toHaveBeenCalledWith(expect.objectContaining({ body: "Hi Dana, we have a reply for you", messageType: "template", metadata: { template: { id: "ok", name: "tpl_ok", language: "he" } } }));
    const job = H.queue.add.mock.calls[0][1];
    expect(job).toMatchObject({ messageType: "template", templateName: "tpl_ok", templateLanguage: "he", recipientExternalId: "972541111111", channelAccountId: "ca1",
      templateComponents: [{ type: "body", parameters: [{ type: "text", text: "Dana" }] }] });
  });

  it("refuses a template that is pending, inactive, another number's or another tenant's", async () => {
    H.prisma.conversation.findFirst.mockResolvedValue(on("WHATSAPP"));
    for (const id of ["pending", "inactive", "other_number", "theirs", "nope"]) {
      const r = await sendTpl({ templateId: id });
      expect(r.status, id).toBe(409);
      expect(r.body.code, id).toBe("TEMPLATE_NOT_USABLE");
    }
    expect(H.messageCreate).not.toHaveBeenCalled();
  });

  it("Instagram: 400, templates are WhatsApp only", async () => {
    H.prisma.conversation.findFirst.mockResolvedValue(on("INSTAGRAM", "1031990639501705"));
    expect((await sendTpl({ templateId: "ok" })).body.code).toBe("TEMPLATES_WHATSAPP_ONLY");
  });
});
