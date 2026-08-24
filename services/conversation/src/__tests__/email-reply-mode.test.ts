/**
 * What the inbox sends when an agent answers an email.
 *
 * The behaviour being pinned is the default: an agent typing into an email
 * conversation is answering it, so the send has to reach the queue asking to
 * continue that thread. GOTCHA's old behaviour was the opposite by omission -
 * no threading information travelled at all, and the customer received a
 * detached new email titled "Message".
 *
 * The route deliberately does NOT resolve the thread itself; the outgoing
 * worker does, so that the bot, flows and scheduled sends thread too. So what
 * matters here is that the agent's CHOICE arrives intact, and that a chosen new
 * thread carries nothing that could drag it back into the old one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

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
    authenticate: (req: any, _res: any, next: any) => { req.user = { email: "agent@acme.test" }; next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "t1"; next(); },
    requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    validate: (schema: any) => (req: any, res: any, next: any) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid" });
      req.body = parsed.data;
      next();
    },
    decryptCredentials: (v: any) => v,
  };
});
vi.mock("../lib/socket", () => ({ getIO: () => null }));
vi.mock("../services/message.service", () => ({
  create: messageCreate,
  listByConversation: vi.fn(),
}));

import messagesRouter from "../routes/messages";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/conversations", messagesRouter);
  return a;
}

function conversationOn(channel: string) {
  return {
    id: "c1",
    tenantId: "t1",
    channel,
    customerExternalId: "buyer@x.test",
    channelAccountId: "ca1",
    channelAccount: { id: "ca1", credentials: { accessToken: "at_1" } },
  };
}

/** The job the route put on the outgoing queue. */
function queued() {
  return outgoingMessageQueue.add.mock.calls[0][1];
}

async function send(body: Record<string, unknown>) {
  return request(app()).post("/api/conversations/c1/messages").send({ body: "On its way.", ...body });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.conversation.findFirst.mockResolvedValue(conversationOn("GMAIL"));
  prisma.conversation.update.mockResolvedValue({});
  prisma.message.findMany.mockResolvedValue([]);
  messageCreate.mockImplementation(async (d: any) => ({ id: "m_new", ...d }));
});

// ─── The default ────────────────────────────────────────────

describe("answering an email", () => {
  it("asks for a threaded reply even when the client says nothing", async () => {
    // The old behaviour was silence, and silence produced a new email every
    // time. The default has to be the correct one.
    const res = await send({});

    expect(res.status).toBe(201);
    expect(queued().emailReplyMode).toBe("reply");
  });

  it("passes the explicit reply choice through", async () => {
    await send({ emailReplyMode: "reply" });
    expect(queued().emailReplyMode).toBe("reply");
  });

  it("does not resolve the thread itself, leaving that to the one place every producer passes through", async () => {
    await send({});
    expect(queued().emailThread).toBeUndefined();
  });

  it("works the same on Outlook", async () => {
    prisma.conversation.findFirst.mockResolvedValue(conversationOn("OUTLOOK"));
    await send({});
    expect(queued().emailReplyMode).toBe("reply");
  });
});

// ─── The opt-out ────────────────────────────────────────────

describe("deliberately starting a new email", () => {
  it("carries the new-thread choice", async () => {
    await send({ emailReplyMode: "new", subject: "Your renewal" });
    expect(queued().emailReplyMode).toBe("new");
  });

  it("sends the agent's own subject and nothing that would rethread it", async () => {
    await send({ emailReplyMode: "new", subject: "Your renewal" });

    const thread = queued().emailThread;
    expect(thread).toEqual({ subject: "Your renewal" });
    expect(thread.inReplyTo).toBeUndefined();
    expect(thread.references).toBeUndefined();
    expect(thread.threadId).toBeUndefined();
  });

  it("records the new subject on our own row, so the next reply chains onto it", async () => {
    await send({ emailReplyMode: "new", subject: "Your renewal" });
    expect(messageCreate.mock.calls[0][0].metadata).toEqual({ email: { subject: "Your renewal" } });
  });

  it("still sends when the agent left the subject blank", async () => {
    // The adapter falls back to a readable default rather than refusing.
    await send({ emailReplyMode: "new" });
    expect(queued().emailReplyMode).toBe("new");
    expect(queued().emailThread).toBeUndefined();
  });

  it("rejects a subject long enough to be refused by a mail server", async () => {
    const res = await send({ emailReplyMode: "new", subject: "x".repeat(500) });
    expect(res.status).toBe(400);
    expect(outgoingMessageQueue.add).not.toHaveBeenCalled();
  });
});

// ─── Every other channel ────────────────────────────────────

describe("channels that are not email", () => {
  it("sends no email mode on WhatsApp", async () => {
    // Threading is meaningless there, and a stray mode would make the worker
    // read a conversation's history for nothing on every single send.
    prisma.conversation.findFirst.mockResolvedValue(conversationOn("WHATSAPP"));
    await send({});

    expect(queued().emailReplyMode).toBeUndefined();
    expect(queued().emailThread).toBeUndefined();
  });

  it("ignores a subject posted on a WhatsApp conversation", async () => {
    prisma.conversation.findFirst.mockResolvedValue(conversationOn("WHATSAPP"));
    await send({ emailReplyMode: "new", subject: "Nope" });

    expect(queued().emailThread).toBeUndefined();
    expect(queued().emailReplyMode).toBeUndefined();
  });
});

// ─── Existing behaviour is untouched ────────────────────────

describe("the quoted-reply path still works", () => {
  it("keeps carrying the quoted message's provider id", async () => {
    prisma.message.findFirst.mockResolvedValue({ id: "m_old", externalMessageId: "wamid.1" });
    prisma.conversation.findFirst.mockResolvedValue(conversationOn("WHATSAPP"));

    await send({ replyToMessageId: "m_old" });

    expect(queued().replyToExternalId).toBe("wamid.1");
  });

  it("refuses a quote from another conversation", async () => {
    prisma.message.findFirst.mockResolvedValue(null);
    const res = await send({ replyToMessageId: "m_elsewhere" });

    expect(res.status).toBe(400);
    expect(outgoingMessageQueue.add).not.toHaveBeenCalled();
  });
});
