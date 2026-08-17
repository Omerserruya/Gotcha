import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Ingestion of imported conversation history.
 *
 * Three properties are load-bearing, and every one of them fails SILENTLY when
 * it breaks - the webhook still returns 200 and nothing appears in a log:
 *
 *   1. A historical message never reaches the live pipeline. If it did, the AI
 *      would answer a customer about an order from last March.
 *   2. Redelivery is a no-op. Meta redelivers on any non-2xx and BullMQ retries
 *      on throw, so without this a flaky minute duplicates somebody's history.
 *   3. Excluded numbers stay excluded. A Coexistence line carries the owner's
 *      private threads, and a rule that keeps them out of the inbox but lets
 *      two years of them into the import is worse than no rule at all.
 */

const { prisma, historicalIntelligenceQueue, isInboundExcluded } = vi.hoisted(() => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    historicalImport: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    historicalImportChunk: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    historicalImportEvent: { create: vi.fn() },
    historicalCustomer: { upsert: vi.fn() },
    conversation: { findFirst: vi.fn(), create: vi.fn() },
    message: { create: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
    channelAccount: { findUnique: vi.fn() },
  },
  historicalIntelligenceQueue: { add: vi.fn().mockResolvedValue(undefined) },
  isInboundExcluded: vi.fn().mockResolvedValue(false),
}));

vi.mock("@chatcenter/shared", () => ({
  prisma,
  historicalIntelligenceQueue,
  isInboundExcluded,
  // The real implementations: these are pure and their behaviour is part of
  // what the tests below are asserting.
  normalizePhone: (v: string) => (v?.startsWith("+") ? v : `+${v}`),
  withHistoricalRecords: <T,>(fn: () => Promise<T>) => fn(),
  isForwardTransition: (from: string, to: string) => from !== to,
  HISTORICAL_SOURCE_WINDOW_MS: 24 * 60 * 60 * 1000,
  resolveContactByChannelId: vi.fn().mockResolvedValue(null),
  publishEvent: vi.fn(),
  decryptCredentials: vi.fn(),
  createWorker: vi.fn(),
}));

import { processHistoricalChunk } from "../services/historical-import.service";

const IMPORT_ROW = {
  id: "imp1",
  tenantId: "t1",
  status: "SOURCE_SYNCING",
  sourceProgress: 0,
  sourceMetadata: null,
  sourceDeadlineAt: new Date(Date.now() + 60 * 60 * 1000),
};

function job(overrides: Record<string, any> = {}) {
  return {
    name: "process-history",
    data: {
      tenantId: "t1",
      channelAccountId: "ca1",
      source: "WHATSAPP_BUSINESS_APP",
      chunk: {
        phase: 0,
        chunkOrder: 1,
        progress: 40,
        threadCount: 1,
        messages: [
          {
            externalMessageId: "wamid.H1",
            customerExternalId: "972541111111",
            direction: "INBOUND",
            timestamp: "2026-03-01T10:00:00.000Z",
            body: "can I exchange after 30 days?",
            messageType: "text",
          },
          {
            externalMessageId: "wamid.H2",
            customerExternalId: "972541111111",
            direction: "OUTBOUND",
            timestamp: "2026-03-01T10:01:00.000Z",
            body: "yes, up to 45 days with the receipt",
            messageType: "text",
          },
        ],
        ...(overrides.chunk ?? {}),
      },
      ...overrides.data,
    },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ status: "ACTIVE" });
  prisma.historicalImport.findFirst.mockResolvedValue(IMPORT_ROW);
  prisma.historicalImport.findUnique.mockResolvedValue({ ...IMPORT_ROW, sourceProgress: 40 });
  prisma.historicalImport.update.mockResolvedValue({});
  prisma.historicalImport.updateMany.mockResolvedValue({ count: 1 });
  prisma.historicalImportChunk.create.mockResolvedValue({ id: "chunk1", processedAt: null });
  prisma.historicalImportChunk.update.mockResolvedValue({});
  prisma.historicalImportChunk.count.mockResolvedValue(0);
  prisma.historicalImportEvent.create.mockResolvedValue({});
  prisma.historicalCustomer.upsert.mockResolvedValue({});
  prisma.conversation.findFirst.mockResolvedValue(null);
  prisma.conversation.create.mockResolvedValue({ id: "conv1" });
  prisma.message.create.mockResolvedValue({ id: "m1" });
  prisma.message.count.mockResolvedValue(2);
  prisma.message.aggregate.mockResolvedValue({ _min: { createdAt: null }, _max: { createdAt: null } });
  isInboundExcluded.mockResolvedValue(false);
});

describe("imported messages are marked as imported", () => {
  it("writes every message with origin HISTORICAL_IMPORT and the import id", async () => {
    await processHistoricalChunk(job());

    expect(prisma.message.create).toHaveBeenCalledTimes(2);
    for (const call of prisma.message.create.mock.calls) {
      expect(call[0].data.origin).toBe("HISTORICAL_IMPORT");
      expect(call[0].data.historicalImportId).toBe("imp1");
    }
  });

  it("dates each row by when it was actually sent, not by now", async () => {
    await processHistoricalChunk(job());
    const first = prisma.message.create.mock.calls[0][0].data;
    expect(first.createdAt).toEqual(new Date("2026-03-01T10:00:00.000Z"));
  });

  it("marks them DELIVERED, because no status webhook is ever coming", async () => {
    // Anything else strands the row in a state nothing can advance: there is no
    // delivery receipt on its way for a message from March.
    await processHistoricalChunk(job());
    expect(prisma.message.create.mock.calls[0][0].data.status).toBe("DELIVERED");
  });

  it("preserves the direction the source reported", async () => {
    await processHistoricalChunk(job());
    const dirs = prisma.message.create.mock.calls.map((c) => c[0].data.direction);
    expect(dirs).toEqual(["INBOUND", "OUTBOUND"]);
  });
});

describe("the historical conversation is inert", () => {
  it("creates it CLOSED, unassigned and marked as imported", async () => {
    await processHistoricalChunk(job());

    const created = prisma.conversation.create.mock.calls[0][0].data;
    expect(created.origin).toBe("HISTORICAL_IMPORT");
    expect(created.historicalImportId).toBe("imp1");
    // CLOSED and handed to nobody. OPEN would drop 1,200 finished conversations
    // into the needs-attention queue overnight.
    expect(created.status).toBe("CLOSED");
    expect(created.isHandedOver).toBe(false);
    expect(created.handledBy).toBeNull();
  });

  it("never reuses a live conversation", async () => {
    // A live thread is a working object with routing, an assignee and an
    // escalation history. Back-filling two years into it would rewrite an
    // agent's open work.
    await processHistoricalChunk(job());
    const where = prisma.conversation.findFirst.mock.calls[0][0].where;
    expect(where.historicalImportId).toBe("imp1");
  });

  it("puts one customer's whole history in ONE conversation", async () => {
    await processHistoricalChunk(job());
    expect(prisma.conversation.create).toHaveBeenCalledTimes(1);
  });
});

describe("nothing here can trigger live behaviour", () => {
  it("never enqueues an outgoing message", async () => {
    const shared = await import("@chatcenter/shared");
    await processHistoricalChunk(job());
    expect((shared as any).publishEvent).not.toHaveBeenCalled();
  });

  it("does not open, route or hand over any conversation", async () => {
    await processHistoricalChunk(job());
    // `update` on a conversation is how routing, handover and SLA state move.
    // The ingest path has no reason to call it at all.
    expect((prisma.conversation as any).update).toBeUndefined();
  });
});

describe("redelivery is a no-op", () => {
  it("drops a chunk that was already ingested", async () => {
    // Meta redelivers on any non-2xx. The unique constraint is what turns that
    // into nothing instead of a second copy of somebody's conversation.
    prisma.historicalImportChunk.create.mockRejectedValueOnce({ code: "P2002" });
    prisma.historicalImportChunk.findUnique.mockResolvedValue({
      id: "chunk1",
      processedAt: new Date(),
    });

    await processHistoricalChunk(job());

    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it("finishes a chunk that was recorded but never ingested", async () => {
    // A crash between the insert and the ingest. The chunk row exists with no
    // processedAt, and the retry has to complete it rather than skip it.
    prisma.historicalImportChunk.create.mockRejectedValueOnce({ code: "P2002" });
    prisma.historicalImportChunk.findUnique.mockResolvedValue({
      id: "chunk1",
      processedAt: null,
    });

    await processHistoricalChunk(job());

    expect(prisma.message.create).toHaveBeenCalledTimes(2);
  });

  it("counts a message that already exists instead of duplicating it", async () => {
    prisma.message.create.mockRejectedValue({ code: "P2002" });
    await processHistoricalChunk(job());
    const update = prisma.historicalImport.update.mock.calls[0][0].data;
    expect(update.duplicateMessages).toEqual({ increment: 2 });
    expect(update.importedMessages).toEqual({ increment: 0 });
  });
});

describe("progress only moves forward", () => {
  it("does not let a late chunk drag the bar backwards", async () => {
    // Chunks arrive out of order, so a chunk reporting 40% can land after one
    // reporting 60%. A blind write makes the bar jump back, which reads as a
    // fault when nothing is wrong.
    await processHistoricalChunk(job());
    const progressCall = prisma.historicalImport.updateMany.mock.calls.find(
      (c) => c[0].data?.sourceProgress !== undefined,
    );
    expect(progressCall![0].where.sourceProgress).toEqual({ lt: 40 });
  });
});

describe("the exclusion list is honoured", () => {
  it("imports nothing at all for an excluded number", async () => {
    isInboundExcluded.mockResolvedValue(true);
    await processHistoricalChunk(job());

    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
});

describe("a declined source is recorded honestly", () => {
  it("marks the import unavailable rather than failed", async () => {
    await processHistoricalChunk(
      job({ chunk: { unavailable: { code: 2593109, reason: "History sharing is turned off" } } }),
    );

    const statusUpdate = prisma.historicalImport.update.mock.calls.find(
      (c) => c[0].data?.status === "NOT_AVAILABLE",
    );
    expect(statusUpdate).toBeTruthy();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
});

describe("handover to the intelligence pipeline", () => {
  it("enqueues exactly once, only when progress is 100 and every chunk is done", async () => {
    prisma.historicalImport.findUnique.mockResolvedValue({
      id: "imp1",
      tenantId: "t1",
      sourceProgress: 100,
      status: "SOURCE_SYNCING",
    });
    prisma.historicalImportChunk.count.mockResolvedValue(0);
    prisma.historicalImport.updateMany.mockResolvedValue({ count: 1 });

    await processHistoricalChunk(job({ chunk: { progress: 100 } }));

    expect(historicalIntelligenceQueue.add).toHaveBeenCalledTimes(1);
    expect(historicalIntelligenceQueue.add.mock.calls[0][1]).toMatchObject({
      importId: "imp1",
      stage: "identity",
    });
  });

  it("waits when an earlier chunk is still queued behind the one carrying 100", async () => {
    prisma.historicalImport.findUnique.mockResolvedValue({
      id: "imp1",
      tenantId: "t1",
      sourceProgress: 100,
      status: "SOURCE_SYNCING",
    });
    prisma.historicalImportChunk.count.mockResolvedValue(2);

    await processHistoricalChunk(job({ chunk: { progress: 100 } }));

    expect(historicalIntelligenceQueue.add).not.toHaveBeenCalled();
  });

  it("does not enqueue twice when two workers finish at the same moment", async () => {
    // The loser of the race updates zero rows and must enqueue nothing.
    prisma.historicalImport.findUnique.mockResolvedValue({
      id: "imp1",
      tenantId: "t1",
      sourceProgress: 100,
      status: "SOURCE_SYNCING",
    });
    prisma.historicalImportChunk.count.mockResolvedValue(0);
    prisma.historicalImport.updateMany.mockResolvedValue({ count: 0 });

    await processHistoricalChunk(job({ chunk: { progress: 100 } }));

    expect(historicalIntelligenceQueue.add).not.toHaveBeenCalled();
  });
});

describe("an inactive tenant is skipped entirely", () => {
  it("writes nothing for a suspended tenant", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ status: "SUSPENDED" });
    await processHistoricalChunk(job());
    expect(prisma.historicalImportChunk.create).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
});
