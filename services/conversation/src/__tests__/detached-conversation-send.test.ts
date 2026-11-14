/**
 * Prod GOTCHA 2026-11-14, conv cmsztwsru0hytz6dblovgaqdd: every inbox send
 * returned 400 "Channel not configured for this tenant". The number had been
 * removed (its channel row deleted, conversations SET NULL) and re-onboarded
 * as a new row; 237 open conversations had no account. A detached
 * conversation is now sent through the tenant's ONE active account on that
 * channel and re-pointed to it. With none or several, the 400 stays.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({
  user: { userId: "u_agent", email: "agent@acme.test" } as any,
  accounts: [] as any[],
  conv: null as any,
}));
const { prisma, outgoingMessageQueue, messageCreate } = vi.hoisted(() => ({
  prisma: {
    conversation: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    channelAccount: { findMany: vi.fn(), findUnique: vi.fn() },
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
    lastInboundAtForRecipient: async () => new Date(),
    publishEvent: async () => undefined,
  };
});
vi.mock("../lib/socket", () => ({ getIO: () => ({ to: () => ({ emit: () => undefined }) }) }));
vi.mock("../services/message.service", () => ({ create: messageCreate, listByConversation: vi.fn() }));

import messagesRouter from "../routes/messages";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/conversations", messagesRouter); return a; };
const send = () => request(app()).post("/api/conversations/cmsztwsru0hytz6dblovgaqdd/messages").send({ body: "היי, עונה לך עכשיו" });
const account = (id: string, o: any = {}) => ({ id, tenantId: "t1", channel: "WHATSAPP", isActive: true, connectionStatus: "CONNECTED", externalId: "1215458558322656", credentials: { accessToken: "at" }, ...o });
const detached = (o: any = {}) => ({
  id: "cmsztwsru0hytz6dblovgaqdd", tenantId: "t1", channel: "WHATSAPP", status: "OPEN", assignedAgentId: "u_agent", visibility: null, departmentId: null,
  customerExternalId: "972525401686", channelAccountId: null, channelAccount: null, isHandedOver: true, handledBy: "human", ...o,
});
const jobAccount = () => outgoingMessageQueue.add.mock.calls[0]?.[1]?.channelAccountId;

beforeEach(() => {
  vi.clearAllMocks();
  H.accounts = [account("cmwardwp0000412qfy9pyah9d")];
  prisma.conversation.findFirst.mockImplementation(async () => H.conv);
  prisma.conversation.update.mockImplementation(async (a: any) => ({ id: a.where.id, ...a.data }));
  prisma.conversation.updateMany.mockImplementation(async (a: any) => {
    const hit = H.conv && H.conv.id === a.where.id && H.conv.tenantId === a.where.tenantId && H.conv.channelAccountId === a.where.channelAccountId;
    if (hit) Object.assign(H.conv, a.data);
    return { count: hit ? 1 : 0 };
  });
  prisma.channelAccount.findMany.mockImplementation(async (a: any) => H.accounts
    .filter((x) => x.tenantId === a.where.tenantId && x.channel === a.where.channel && x.isActive === a.where.isActive && x.connectionStatus === a.where.connectionStatus)
    .slice(0, a.take).map((x) => ({ id: x.id })));
  prisma.channelAccount.findUnique.mockImplementation(async (a: any) => H.accounts.find((x) => x.id === a.where.id) ?? null);
  prisma.message.findMany.mockResolvedValue([]);
  messageCreate.mockImplementation(async (d: any) => ({ id: "m1", ...d }));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("★ an inbox send in a conversation whose account was deleted", () => {
  it("★ the prod case: sent through the tenant's one WhatsApp account, and the conversation re-pointed to it", async () => {
    H.conv = detached();
    const r = await send();
    expect(r.status).toBe(201);
    expect(jobAccount()).toBe("cmwardwp0000412qfy9pyah9d");
    expect(H.conv.channelAccountId).toBe("cmwardwp0000412qfy9pyah9d");
    expect(prisma.conversation.updateMany.mock.calls[0][0].where).toEqual({ id: "cmsztwsru0hytz6dblovgaqdd", tenantId: "t1", channelAccountId: null });
  });

  it("control: two active WhatsApp numbers: still 400, nothing sent, nothing re-pointed", async () => {
    H.accounts.push(account("ca_second", { externalId: "222" }));
    H.conv = detached();
    const r = await send();
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Channel not configured for this tenant");
    expect(outgoingMessageQueue.add).not.toHaveBeenCalled();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("control: no active account (only a disconnected one): still 400", async () => {
    H.accounts = [account("ca_off", { isActive: false, connectionStatus: "DISCONNECTED" })];
    H.conv = detached();
    expect((await send()).status).toBe(400);
    expect(outgoingMessageQueue.add).not.toHaveBeenCalled();
  });

  it("control: another tenant's account is never used", async () => {
    H.accounts = [account("ca_foreign", { tenantId: "t2" })];
    H.conv = detached();
    expect((await send()).status).toBe(400);
    expect(outgoingMessageQueue.add).not.toHaveBeenCalled();
  });

  it("control: an attached conversation sends on its own account and is never looked up again", async () => {
    H.accounts.push(account("ca_own", { externalId: "333" }));
    H.conv = detached({ channelAccountId: "ca_own", channelAccount: account("ca_own") });
    expect((await send()).status).toBe(201);
    expect(jobAccount()).toBe("ca_own");
    expect(prisma.channelAccount.findMany).not.toHaveBeenCalled();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });
});

describe("the template and media sends take the same path", () => {
  const src = readFileSync(join(__dirname, "../routes/messages.ts"), "utf8");
  it("all three send routes resolve the account through ensureChannelAccount", () => {
    expect(src.match(/const conversation = await ensureChannelAccount\(found\);/g)).toHaveLength(3);
    for (const route of ['"/:conversationId/messages"', '"/:conversationId/messages/template"', '"/:conversationId/messages/media"']) {
      const at = src.indexOf(`router.post(${route}`);
      expect(at).toBeGreaterThan(-1);
      const next = src.indexOf("router.", at + 10);
      const body = src.slice(at, next === -1 ? undefined : next);
      expect(body).toContain("ensureChannelAccount(found)");
      expect(body.indexOf("ensureChannelAccount(found)")).toBeLessThan(body.indexOf("if (!conversation.channelAccount)"));
    }
  });
});
