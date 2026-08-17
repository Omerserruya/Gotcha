import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The completion email: once, and only after there is something to look at.
 *
 * Two independent ways this goes wrong in production, both covered here:
 *
 *   * Sent too early. Meta reporting `progress = 100` only means the messages
 *     arrived. An email at that moment sends the owner to a page showing a
 *     spinner, which is worse than sending nothing.
 *   * Sent repeatedly. Every stage is retried by BullMQ and imports can finish
 *     concurrently. A read-then-write latch leaves the usual gap between the
 *     two, and under retries that gap is not theoretical - it is how a sending
 *     domain gets blocked.
 */

const { prisma, queueAdd } = vi.hoisted(() => ({
  prisma: {
    historicalImport: { findFirst: vi.fn(), updateMany: vi.fn() },
    historicalImportEvent: { create: vi.fn() },
    user: { findMany: vi.fn() },
  },
  queueAdd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@chatcenter/shared", () => ({
  prisma,
  NOTIFICATIONS_EMAIL_QUEUE_NAME: "notifications-email",
  renderBrandEmail: (a: any) => `<html><body>${a.headline}</body></html>`,
  emailParagraph: (s: string) => `<p>${s}</p>`,
  emailStatCards: (cards: any[]) => cards.map((c) => `${c.label}:${c.value}`).join("|"),
  emailPills: (caption: string, items: string[]) => `${caption}:${items.join(",")}`,
  escapeHtml: (s: string) => s,
  resolveEffectiveLocale: vi.fn().mockResolvedValue("en"),
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = queueAdd;
  },
}));

import { runFinalizeStage, buildCompletionEmail } from "../services/historical-intelligence/finalize.stage";

const IMPORT = {
  id: "imp1",
  tenantId: "t1",
  importedMessages: 12482,
  importedCustomers: 1247,
  knowledgeCandidateCount: 43,
  knowledgeConflictCount: 2,
  summary: {
    importedMessages: 12482,
    importedCustomers: 1247,
    knowledgeCandidates: 43,
    knowledgeConflicts: 2,
  },
  topTopics: [
    { topic: "Order status", conversations: 300, share: 0.23 },
    { topic: "Sizing", conversations: 240, share: 0.18 },
    { topic: "Returns", conversations: 180, share: 0.14 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.historicalImport.findFirst.mockResolvedValue(IMPORT);
  prisma.historicalImportEvent.create.mockResolvedValue({});
  prisma.user.findMany.mockResolvedValue([{ id: "u1", email: "owner@example.com" }]);
});

describe("the latch", () => {
  it("sends when it wins the claim", async () => {
    prisma.historicalImport.updateMany.mockResolvedValue({ count: 1 });

    const result = await runFinalizeStage({ tenantId: "t1", importId: "imp1" });

    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(result.detail).toMatchObject({ emailed: true });
  });

  it("sends NOTHING when it loses the claim", async () => {
    // The conditional update matched zero rows: another worker already claimed
    // this import. The loser must be completely silent.
    prisma.historicalImport.updateMany.mockImplementation(async (args: any) => {
      if (args.where?.completionEmailSentAt === null) return { count: 0 };
      return { count: 1 };
    });

    const result = await runFinalizeStage({ tenantId: "t1", importId: "imp1" });

    expect(queueAdd).not.toHaveBeenCalled();
    expect(result.detail).toMatchObject({ emailed: false });
  });

  it("claims the latch BEFORE queueing, not after", async () => {
    // The two failure modes are not equal. Claiming first risks the owner
    // missing one email, which the channel card's link recovers. Queueing first
    // risks sending the same email repeatedly.
    const order: string[] = [];
    prisma.historicalImport.updateMany.mockImplementation(async (args: any) => {
      if (args.where?.completionEmailSentAt === null) order.push("claim");
      return { count: 1 };
    });
    queueAdd.mockImplementation(async () => {
      order.push("queue");
    });

    await runFinalizeStage({ tenantId: "t1", importId: "imp1" });

    expect(order).toEqual(["claim", "queue"]);
  });

  it("still closes the import out when the claim was already taken", async () => {
    // Losing the email race must not leave the import stuck in REVIEW_READY
    // forever - the pipeline is finished either way.
    prisma.historicalImport.updateMany.mockImplementation(async (args: any) => {
      if (args.where?.completionEmailSentAt === null) return { count: 0 };
      return { count: 1 };
    });

    await runFinalizeStage({ tenantId: "t1", importId: "imp1" });

    const completed = prisma.historicalImport.updateMany.mock.calls.find(
      (c: any[]) => c[0].data?.status === "COMPLETED",
    );
    expect(completed).toBeTruthy();
  });
});

describe("who is told", () => {
  it("mails the tenant's admins, not every seat", async () => {
    prisma.historicalImport.updateMany.mockResolvedValue({ count: 1 });
    await runFinalizeStage({ tenantId: "t1", importId: "imp1" });

    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    expect(where.role).toBe("ADMIN");
    expect(where.isActive).toBe(true);
  });

  it("does not fail the stage when there is nobody to tell", async () => {
    prisma.historicalImport.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.findMany.mockResolvedValue([]);

    const result = await runFinalizeStage({ tenantId: "t1", importId: "imp1" });

    expect(result.ok).toBe(true);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("carries a stable event id so a duplicate enqueue is recognisable", async () => {
    prisma.historicalImport.updateMany.mockResolvedValue({ count: 1 });
    await runFinalizeStage({ tenantId: "t1", importId: "imp1" });

    expect(queueAdd.mock.calls[0][1]).toMatchObject({
      eventId: "historical-import:imp1",
      eventType: "historical_import_ready",
      to: "owner@example.com",
    });
  });
});

describe("the email quotes real numbers", () => {
  it("uses the persisted counts rather than recomputing them", () => {
    const mail = buildCompletionEmail({
      locale: "en",
      messages: 12482,
      customers: 1247,
      candidates: 43,
      conflicts: 2,
      topics: ["Order status", "Sizing"],
    });
    expect(mail.text).toContain("12,482");
    expect(mail.text).toContain("1,247");
    expect(mail.text).toContain("43");
  });

  it("says out loud that nothing is added without approval", () => {
    const mail = buildCompletionEmail({
      locale: "en",
      messages: 10,
      customers: 2,
      candidates: 3,
      conflicts: 0,
      topics: [],
    });
    expect(mail.text.toLowerCase()).toContain("approve");
  });

  it("mentions the conflicts when there are any, because they need a decision", () => {
    const mail = buildCompletionEmail({
      locale: "en",
      messages: 10,
      customers: 2,
      candidates: 3,
      conflicts: 7,
      topics: [],
    });
    expect(mail.text).toContain("7");
    expect(mail.text.toLowerCase()).toContain("different answers");
  });

  it("writes Hebrew for a Hebrew recipient", () => {
    const mail = buildCompletionEmail({
      locale: "he",
      messages: 5,
      customers: 1,
      candidates: 1,
      conflicts: 0,
      topics: [],
    });
    expect(mail.subject).toMatch(/[֐-׿]/);
  });

  it("contains no em dash or en dash in either language", () => {
    // Repository rule: those characters read as machine-written, and this is
    // the first email a new customer gets from us.
    for (const locale of ["en", "he"]) {
      const mail = buildCompletionEmail({
        locale,
        messages: 1,
        customers: 1,
        candidates: 1,
        conflicts: 1,
        topics: ["Shipping"],
      });
      expect(mail.subject).not.toMatch(/[–—]/);
      expect(mail.text).not.toMatch(/[–—]/);
      expect(mail.html).not.toMatch(/[–—]/);
    }
  });

  it("links to the review page, not to a generic dashboard", () => {
    const mail = buildCompletionEmail({
      locale: "en",
      messages: 1,
      customers: 1,
      candidates: 1,
      conflicts: 0,
      topics: [],
    });
    expect(mail.text).toContain("/ai-studio/knowledge?tab=discovered");
  });
});
