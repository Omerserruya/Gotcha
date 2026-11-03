/**
 * A person writing into a CLOSED conversation reopens it (Omer, 2026-11-03).
 *
 * Found on dev (Urban Supply): an agent's "היי" into a closed conversation
 * left it closed; the customer's reply opened a new one the bot took, and the
 * agent never saw it. The worker finds the conversation for an inbound by
 * `status: { not: "CLOSED" }` (incoming.worker), so a reopened one is where
 * the reply lands, and `isHandedOver` + an assignee keep the bot out of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  user: { userId: "u_agent", email: "agent@acme.test" } as any,
  lastInbound: new Date() as Date | null,
  order: [] as string[],
}));
const { prisma, outgoingMessageQueue, messageCreate } = vi.hoisted(() => ({
  prisma: {
    conversation: { findFirst: vi.fn(), update: vi.fn() },
    message: { findFirst: vi.fn(), findMany: vi.fn() },
  },
  outgoingMessageQueue: { add: vi.fn() },
  messageCreate: vi.fn(),
}));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma,
    outgoingMessageQueue,
    authenticate: (req: any, _res: any, next: any) => { req.user = { ...H.user }; next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "t1"; next(); },
    requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    validate: (schema: any) => (req: any, res: any, next: any) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid" });
      req.body = parsed.data;
      next();
    },
    decryptCredentials: (v: any) => v,
    lastInboundAtForRecipient: async () => H.lastInbound,
  };
});
vi.mock("../lib/socket", () => ({ getIO: () => null }));
vi.mock("../services/message.service", () => ({ create: messageCreate, listByConversation: vi.fn() }));

import messagesRouter from "../routes/messages";
import { reopenOnSend } from "../services/reopen-on-send";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/conversations", messagesRouter); return a; };
const closed = (channel: string, o: any = {}) => ({
  id: "c1", tenantId: "t1", channel, status: "CLOSED", assignedAgentId: null, visibility: null, departmentId: null,
  customerExternalId: "972500000001", channelAccountId: "ca1", channelAccount: { id: "ca1", credentials: { accessToken: "at" } }, ...o,
});
const send = () => request(app()).post("/api/conversations/c1/messages").send({ body: "היי" });
const reopened = () => prisma.conversation.update.mock.calls.map((c: any[]) => c[0].data).find((d: any) => d.status === "OPEN");

beforeEach(() => {
  vi.clearAllMocks();
  H.user = { userId: "u_agent", email: "agent@acme.test" }; H.lastInbound = new Date(); H.order = [];
  prisma.conversation.update.mockImplementation(async (a: any) => { if (a.data.status === "OPEN") H.order.push("reopen"); return {}; });
  prisma.message.findMany.mockResolvedValue([]);
  messageCreate.mockImplementation(async (d: any) => { H.order.push("message"); return { id: "m1", ...d }; });
});

describe("a person sends into a CLOSED conversation", () => {
  it("website chat: reopened before the message is written, taken by the sender, the bot's state cleared", async () => {
    prisma.conversation.findFirst.mockResolvedValue(closed("WEBCHAT"));
    expect((await send()).status).toBe(201);
    expect(reopened()).toEqual({
      status: "OPEN", closedAt: null, archivedAt: null, handledBy: "human", isHandedOver: true,
      chatbotNodeId: null, chatbotFlowId: null, automationRunId: null, assignedAgentId: "u_agent",
    });
    expect(H.order).toEqual(["reopen", "message"]);
  });

  it("WhatsApp inside the 24h window: reopened, then sent", async () => {
    prisma.conversation.findFirst.mockResolvedValue(closed("WHATSAPP"));
    expect((await send()).status).toBe(201);
    expect(reopened()).toMatchObject({ status: "OPEN", assignedAgentId: "u_agent" });
    expect(outgoingMessageQueue.add).toHaveBeenCalled();
  });

  it("WhatsApp outside the 24h window: refused as before, and nothing changes (still closed)", async () => {
    H.lastInbound = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    prisma.conversation.findFirst.mockResolvedValue(closed("WHATSAPP"));
    const r = await send();
    expect(r.status).toBe(409);
    expect(reopened()).toBeUndefined();
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("already someone's: reopened, the assignee kept", async () => {
    prisma.conversation.findFirst.mockResolvedValue(closed("WEBCHAT", { assignedAgentId: "u_dana" }));
    await send();
    expect(reopened()).not.toHaveProperty("assignedAgentId");
  });

  it("an open conversation is not touched", async () => {
    prisma.conversation.findFirst.mockResolvedValue(closed("WEBCHAT", { status: "OPEN" }));
    await send();
    expect(reopened()).toBeUndefined();
  });
});

describe("who reopens", () => {
  it("the system (internal key) never reopens; support mode reopens without assigning the support actor", () => {
    const conv = { status: "CLOSED", assignedAgentId: null };
    expect(reopenOnSend(conv, { userId: "system", isInternal: true })).toBeNull();
    expect(reopenOnSend(conv, undefined)).toBeNull();
    const support = reopenOnSend(conv, { userId: "u_support", support: { sessionId: "ss1" } });
    expect(support).toMatchObject({ status: "OPEN", isHandedOver: true });
    expect(support).not.toHaveProperty("assignedAgentId");
  });
  it("the reply then lands in it: the worker's lookup excludes only CLOSED, and a reopened one is OPEN", () => {
    expect(reopenOnSend({ status: "CLOSED", assignedAgentId: null }, { userId: "u_agent" })?.status).not.toBe("CLOSED");
  });
});
