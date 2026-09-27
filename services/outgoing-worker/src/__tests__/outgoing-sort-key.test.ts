/**
 * The conversation's sort key, on the one branch where a send became real.
 *
 * ★ No queued outbound advanced `lastMessageAt`. The word did not appear
 * anywhere in this service, and every producer - scheduled sends, contacts,
 * approvals, the idle nudges, voice-callback - creates its Message row as
 * PENDING and hands off. So a scheduled message really delivered to a real
 * customer left the conversation sitting wherever it already was in the inbox.
 *
 * ★★ It is deliberately NOT fixed at the sites that create the row: advancing
 * the key there would claim a delivery that has not happened, which is the same
 * defect as advancing it on a FAILED send, only earlier. The rule belongs where
 * the fact becomes true.
 *
 * These cases pin the two properties that make the write safe: it happens only
 * on success, and it is a max() rather than an assignment - because the row is
 * created at T0 and sent at T1, so a customer inbound arriving between them must
 * not be dragged backwards.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma, adapter, getOutboundAdapter } = vi.hoisted(() => {
  const adapter = {
    channel: "GMAIL",
    sendTextMessage: vi.fn(async (..._args: any[]) => "sent_1" as string | null),
    sendInteractiveMessage: vi.fn(async (..._args: any[]) => null as string | null),
  };
  return {
    adapter,
    getOutboundAdapter: vi.fn(() => adapter),
    prisma: {
      channelAccount: { findUnique: vi.fn() },
      message: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
      conversation: { update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
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

/** Far from now on purpose: a write taken from the clock would not equal this. */
const ROW_AT = new Date("2026-03-04T05:06:07.000Z");

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

/** The sort-key writes only. Nothing else in this worker calls updateMany. */
function sortKeyWrites() {
  return prisma.conversation.updateMany.mock.calls.map((c: any[]) => c[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.channelAccount.findUnique.mockResolvedValue({
    id: "ca1", externalId: "support@acme.test", credentials: { accessToken: "at_1" },
  });
  prisma.message.findMany.mockResolvedValue([]);
  prisma.message.findUnique.mockResolvedValue({ metadata: {} });
  prisma.message.update.mockResolvedValue({ id: "m_new", conversationId: "c1", createdAt: ROW_AT });
  prisma.conversation.update.mockResolvedValue({});
  prisma.conversation.updateMany.mockResolvedValue({ count: 1 });
  adapter.sendTextMessage.mockResolvedValue("sent_1");
});

describe("outgoing worker - the conversation sort key", () => {
  it("advances it when the send succeeded, from the ROW's timestamp", async () => {
    await processOutgoingMessage(job());

    const writes = sortKeyWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].data).toEqual({ lastMessageAt: ROW_AT });
  });

  it("never moves the key backwards - the write is a max(), not an assignment", async () => {
    // T0 create, T1 send. An inbound that arrived in between is NEWER than this
    // row, and overwriting it would bury a customer who has just written in.
    await processOutgoingMessage(job());

    expect(sortKeyWrites()[0].where.OR).toEqual([
      { lastMessageAt: null },
      { lastMessageAt: { lt: ROW_AT } },
    ]);
  });

  it("scopes the write to the conversation AND the tenant", async () => {
    // The tenant guard blocks any bulk write whose where clause omits tenantId,
    // so this is load-bearing rather than belt-and-braces.
    await processOutgoingMessage(job());

    const where = sortKeyWrites()[0].where;
    expect(where.id).toBe("c1");
    expect(where.tenantId).toBe("t1");
  });

  it("does NOT touch the key when the send failed", async () => {
    // A failed send THROWS here so BullMQ retries it, which means the success
    // branch is never reached at all. Asserting the throw as well as the absent
    // write, because "no sort-key write" for the wrong reason would still pass:
    // if the throw were ever removed, this case must not quietly start
    // exercising a different path than the one it claims to cover.
    adapter.sendTextMessage.mockResolvedValue(null);

    await expect(processOutgoingMessage(job())).rejects.toThrow(/send failed/);
    expect(sortKeyWrites()).toHaveLength(0);
  });

  it("does NOT touch the key for a message that belongs to no conversation", async () => {
    // Broadcast rows carry `conversationId: null` by design. There is no
    // conversation whose order could be claimed.
    prisma.message.update.mockResolvedValue({ id: "m_new", conversationId: null, createdAt: ROW_AT });
    await processOutgoingMessage(job());

    expect(sortKeyWrites()).toHaveLength(0);
  });

  it("does not fail the job when the sort-key write blows up", async () => {
    // The message is already on the wire. Throwing here would retry the SEND and
    // deliver the customer a second copy - much worse than a stale sort key.
    prisma.conversation.updateMany.mockRejectedValue(new Error("deadlock"));
    await expect(processOutgoingMessage(job())).resolves.not.toThrow();
  });
});
