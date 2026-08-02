/**
 * OTP verification to the STORED trusted destination only. Pins the
 * prohibited pattern from the incident review: a destination supplied in
 * chat must never receive the code, and codes are conversation-scoped,
 * attempt-limited and short-lived.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  conversation: { findFirst: vi.fn() },
  customerVerification: {
    updateMany: vi.fn(async () => ({ count: 0 })),
    create: vi.fn(async (a: any) => ({ id: "cv1", ...a.data })),
    findFirst: vi.fn(),
    update: vi.fn(async (a: any) => ({ id: "cv1", attempts: (a.data.attempts?.increment ? 1 : 0) })),
  },
  message: { create: vi.fn(async () => ({ id: "msg1" })) },
}));
const queueMock = vi.hoisted(() => ({ add: vi.fn(async () => ({})) }));

vi.mock("../lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("../lib/queue", () => ({ outgoingMessageQueue: queueMock }));

import { issueCustomerVerification, confirmCustomerVerification } from "../lib/customer-verification";
import { createHash } from "node:crypto";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.conversation.findFirst.mockResolvedValue({
    id: "conv1", channel: "WHATSAPP", channelAccountId: "ch1", customerExternalId: "972525401686",
  });
});

describe("issueCustomerVerification (8: untrusted destinations can never receive the code)", () => {
  it("sends the code ONLY to the stored phone - not the conversation sender, and no override exists", async () => {
    const r = await issueCustomerVerification({
      tenantId: "t1", conversationId: "conv1",
      target: { customerId: "8888888", phone: "+972545680665", email: "matanam0012@gmail.com" },
    });
    expect(r.ok).toBe(true);
    const job = queueMock.add.mock.calls[0][1];
    expect(job.recipientExternalId).toBe("972545680665"); // Matan's STORED phone
    expect(job.recipientExternalId).not.toBe("972525401686"); // never the requester
    expect(job.body).toMatch(/\d{6}/);
    // masked echo only - full destination never returned to the caller/model
    expect(r.sentToMasked).toBe("***0665");
  });

  it("refuses when the target has no stored phone", async () => {
    const r = await issueCustomerVerification({
      tenantId: "t1", conversationId: "conv1", target: { customerId: "1", phone: null },
    });
    expect(r.ok).toBe(false);
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it("invalidates previous pending codes for the conversation (no stale-code race)", async () => {
    await issueCustomerVerification({
      tenantId: "t1", conversationId: "conv1", target: { phone: "+972545680665" },
    });
    const inv = prismaMock.customerVerification.updateMany.mock.calls[0][0];
    expect(inv.where).toMatchObject({ tenantId: "t1", conversationId: "conv1", verifiedAt: null });
  });

  it("the conversation-visible message row is MASKED - the code is not persisted there", async () => {
    await issueCustomerVerification({
      tenantId: "t1", conversationId: "conv1", target: { phone: "+972545680665" },
    });
    const row = prismaMock.message.create.mock.calls[0][0].data;
    expect(row.body).toContain("***0665");
    expect(row.body).not.toMatch(/\d{6}/);
  });
});

describe("confirmCustomerVerification (9: expiry, attempts, single grant)", () => {
  const hash = (code: string) => createHash("sha256").update(`t1:${code}`).digest("hex");

  it("a correct code flips the row into a short-lived grant", async () => {
    prismaMock.customerVerification.findFirst.mockResolvedValue({
      id: "cv1", attempts: 0, maxAttempts: 5, codeHash: hash("123456"),
    });
    const r = await confirmCustomerVerification({ tenantId: "t1", conversationId: "conv1", code: "123456" });
    expect(r.verified).toBe(true);
    const upd = prismaMock.customerVerification.update.mock.calls[0][0].data;
    expect(upd.verifiedAt).toBeInstanceOf(Date);
    expect(upd.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("a wrong code burns an attempt; the final failure kills the code", async () => {
    prismaMock.customerVerification.findFirst.mockResolvedValue({
      id: "cv1", attempts: 4, maxAttempts: 5, codeHash: hash("123456"),
    });
    const r = await confirmCustomerVerification({ tenantId: "t1", conversationId: "conv1", code: "000000" });
    expect(r.verified).toBe(false);
    const upd = prismaMock.customerVerification.update.mock.calls[0][0].data;
    expect(upd.expiresAt).toBeInstanceOf(Date); // burned
  });

  it("expired/absent codes cannot verify (query excludes them)", async () => {
    prismaMock.customerVerification.findFirst.mockResolvedValue(null);
    const r = await confirmCustomerVerification({ tenantId: "t1", conversationId: "conv1", code: "123456" });
    expect(r.ok).toBe(false);
    const where = prismaMock.customerVerification.findFirst.mock.calls[0][0].where;
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
    expect(where).toMatchObject({ tenantId: "t1", conversationId: "conv1" });
  });
});
