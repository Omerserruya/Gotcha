/**
 * Where email threading is actually decided.
 *
 * The resolution lives in the outgoing worker rather than in each producer,
 * because this is the one point every outbound message passes through: the
 * inbox, the AI bot, flow steps, approval continuations, scheduled sends and
 * broadcasts. Putting it in the producers instead would guarantee that the next
 * producer added forgets, and forgetting is silent - the mail still sends, it
 * just arrives detached from the thread it answers.
 *
 * So these cases are about the decision, not about headers: when history is
 * read, when it is not, and what reaches the adapter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma, adapter, getOutboundAdapter } = vi.hoisted(() => {
  const adapter = {
    channel: "GMAIL",
    // Variadic on purpose: the assertions read positional arguments (the quoted
    // id at 4, the email thread at 5), and an inferred zero-arg signature makes
    // those indexes a type error rather than a test.
    sendTextMessage: vi.fn(async (..._args: any[]) => "sent_1" as string | null),
    sendInteractiveMessage: vi.fn(async (..._args: any[]) => null as string | null),
  };
  return {
    adapter,
    getOutboundAdapter: vi.fn(() => adapter),
    // Every model the worker touches. The ones beyond message/channelAccount
    // are downstream bookkeeping (usage, audit, scheduled-send linkage) that
    // must not throw and is not what these cases are about.
    prisma: {
      channelAccount: { findUnique: vi.fn() },
      message: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
      conversation: { update: vi.fn() },
      usageLog: { create: vi.fn(async () => ({})) },
      auditLog: { create: vi.fn(async () => ({})) },
      scheduledMessage: { update: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) },
    },
  };
});

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma,
    getOutboundAdapter,
    createWorker: vi.fn(),
    analyticsQueue: { add: vi.fn() },
    publishEvent: vi.fn(async () => undefined),
    decryptCredentials: (v: any) => v,
  };
});
vi.mock("../workers/broadcast.worker", () => ({ recordBroadcastResult: vi.fn(async () => undefined) }));

import { processOutgoingMessage } from "../workers/outgoing.worker";

const inboundEmail = {
  direction: "INBOUND",
  metadata: {
    email: {
      messageIdHeader: "<customer@mail.test>",
      references: ["<first@mail.test>"],
      subject: "Order 1234",
      threadId: "t_99",
      providerMessageId: "m1",
    },
  },
};

function job(data: Record<string, unknown> = {}) {
  return {
    data: {
      tenantId: "t1",
      conversationId: "c1",
      channel: "GMAIL",
      channelAccountId: "ca1",
      recipientExternalId: "buyer@x.test",
      body: "On its way.",
      messageType: "text",
      senderName: "agent@acme.test",
      messageId: "m_new",
      ...data,
    },
  } as any;
}

/** The thread context handed to the adapter, which is the whole point. */
function threadSentToAdapter() {
  return adapter.sendTextMessage.mock.calls[0]?.[5];
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.channelAccount.findUnique.mockResolvedValue({
    id: "ca1", externalId: "support@acme.test", credentials: { accessToken: "at_1" },
  });
  prisma.message.findMany.mockResolvedValue([inboundEmail]);
  prisma.message.findUnique.mockResolvedValue({ metadata: {} });
  prisma.message.update.mockResolvedValue({ id: "m_new", conversationId: "c1" });
  prisma.conversation.update.mockResolvedValue({});
  adapter.sendTextMessage.mockResolvedValue("sent_1");
});

// ─── Replying ───────────────────────────────────────────────

describe("an email send with no explicit mode", () => {
  it("reads the conversation and threads the reply", async () => {
    // This is the bot / flow / scheduled-send path: nothing upstream knows
    // about threading, and it still has to come out right.
    await processOutgoingMessage(job());

    expect(threadSentToAdapter()).toEqual({
      subject: "Re: Order 1234",
      inReplyTo: "<customer@mail.test>",
      references: ["<first@mail.test>", "<customer@mail.test>"],
      threadId: "t_99",
      providerMessageId: "m1",
    });
  });

  it("scopes the history read to the tenant and the conversation", async () => {
    await processOutgoingMessage(job());

    const where = prisma.message.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ tenantId: "t1", conversationId: "c1" });
  });

  it("reads newest first, because the newest inbound email is the one being answered", async () => {
    await processOutgoingMessage(job());
    expect(prisma.message.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
  });

  it("bounds the lookback so one enormous thread cannot make every send expensive", async () => {
    await processOutgoingMessage(job());
    expect(prisma.message.findMany.mock.calls[0][0].take).toBe(50);
  });

  it("sends without a thread when the conversation holds no email to answer", async () => {
    prisma.message.findMany.mockResolvedValue([]);
    await processOutgoingMessage(job());

    expect(threadSentToAdapter()).toBeUndefined();
    expect(adapter.sendTextMessage).toHaveBeenCalled();
  });

  it("records the thread on our own row, so a second reply chains onto it", async () => {
    // Two agent replies in a row, with no customer message in between: the
    // second has to find something to thread onto.
    await processOutgoingMessage(job());

    const written = prisma.message.update.mock.calls[0][0].data.metadata;
    expect(written.email).toMatchObject({ subject: "Re: Order 1234", threadId: "t_99" });
  });

  it("does not clobber metadata the producer already wrote", async () => {
    prisma.message.findUnique.mockResolvedValue({ metadata: { flowRunId: "f1" } });
    await processOutgoingMessage(job());

    expect(prisma.message.update.mock.calls[0][0].data.metadata.flowRunId).toBe("f1");
  });
});

// ─── The opt-out ────────────────────────────────────────────

describe("a deliberately new email", () => {
  it("does not read the conversation at all", async () => {
    await processOutgoingMessage(job({ emailReplyMode: "new", emailThread: { subject: "Your renewal" } }));
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it("sends the agent's subject with nothing that could rethread it", async () => {
    await processOutgoingMessage(job({ emailReplyMode: "new", emailThread: { subject: "Your renewal" } }));
    expect(threadSentToAdapter()).toEqual({ subject: "Your renewal" });
  });

  it("sends no thread at all when the agent gave no subject", async () => {
    await processOutgoingMessage(job({ emailReplyMode: "new" }));

    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(threadSentToAdapter()).toBeUndefined();
  });
});

// ─── Everything else ────────────────────────────────────────

describe("channels that are not email", () => {
  it("never reads a conversation's history on WhatsApp", async () => {
    // Threading is meaningless there; reading history on every send would be a
    // query per message for nothing.
    await processOutgoingMessage(job({ channel: "WHATSAPP" }));

    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(threadSentToAdapter()).toBeUndefined();
  });

  it("still passes the quoted-message id through", async () => {
    await processOutgoingMessage(job({ channel: "WHATSAPP", replyToExternalId: "wamid.1" }));
    expect(adapter.sendTextMessage.mock.calls[0][4]).toBe("wamid.1");
  });
});

describe("a job that already carries its own thread", () => {
  it("is trusted rather than re-resolved", async () => {
    const supplied = { subject: "Re: Something else", threadId: "t_supplied" };
    await processOutgoingMessage(job({ emailThread: supplied }));

    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(threadSentToAdapter()).toEqual(supplied);
  });
});
