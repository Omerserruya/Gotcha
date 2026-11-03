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
  emits: [] as Array<{ room: string; event: string; data: any }>,
  published: [] as any[],
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
    publishEvent: async (e: any) => { H.published.push(e); },
  };
});
vi.mock("../lib/socket", () => ({
  getIO: () => ({ to: (room: string) => ({ emit: (event: string, data: any) => { H.emits.push({ room, event, data }); } }) }),
}));
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
  H.user = { userId: "u_agent", email: "agent@acme.test" }; H.lastInbound = new Date(); H.order = []; H.emits = []; H.published = [];
  prisma.conversation.update.mockImplementation(async (a: any) => { if (a.data.status === "OPEN") H.order.push("reopen"); return { id: a.where.id, ...a.data, assignedAgent: { id: "u_agent", name: "Agent", email: "agent@acme.test" } }; });
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

  it("every inbox hears it: conversation:updated with the open row and its assignee, to the tenant room and the bus", async () => {
    prisma.conversation.findFirst.mockResolvedValue(closed("WHATSAPP"));
    await send();
    const upd = H.emits.filter((e) => e.event === "conversation:updated");
    expect(upd).toHaveLength(1);
    expect(upd[0].room).toBe("tenant:t1");
    expect(upd[0].data).toMatchObject({ id: "c1", status: "OPEN", assignedAgentId: "u_agent", assignedAgent: { id: "u_agent" } });
    expect(H.published).toEqual([expect.objectContaining({ event: "conversation:updated", tenantId: "t1", data: expect.objectContaining({ status: "OPEN" }) })]);
    const upd2 = prisma.conversation.update.mock.calls.find((c: any[]) => c[0].data.status === "OPEN")![0];
    expect(upd2.include).toEqual({ assignedAgent: { select: { id: true, name: true, email: true } } });
  });

  it("an open conversation sends no status event", async () => {
    prisma.conversation.findFirst.mockResolvedValue(closed("WEBCHAT", { status: "OPEN" }));
    await send();
    expect(H.emits.filter((e) => e.event === "conversation:updated")).toHaveLength(0);
    expect(H.published).toHaveLength(0);
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
