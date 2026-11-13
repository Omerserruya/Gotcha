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
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    historicalImportChunk: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
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

import { processHistoricalChunk, sourceTransferReady, sweepQuietSourceTransfers, SOURCE_QUIET_MS, FINAL_QUIET_MS } from "../services/historical-import.service";

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
  // Default: all three Meta phases in, at 100, and quiet for an hour.
  prisma.historicalImportChunk.groupBy.mockResolvedValue([0, 1, 2].map((phase) => ({ phase, _max: { progress: 100, receivedAt: new Date(Date.now() - 3600_000) } })));
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

/**
 * When is the source transfer over? Driven through the real sweep over a
 * timeline of chunks, so the quiet window, the phase rules and the latch are
 * exercised together. Times are seconds after the first chunk.
 */
type Chunk = { phase: number; progress: number; at: number };
const T0 = Date.UTC(2026, 10, 13, 8, 59, 8, 872);

function simulate(chunks: Chunk[], opts: { until: number; step?: number; deadline?: number; unprocessed?: number }) {
  const state = { status: "SOURCE_SYNCING" };
  let clock = T0;
  const arrived = () => chunks.filter((c) => T0 + c.at * 1000 <= clock);
  const deadlineAt = new Date(T0 + (opts.deadline ?? 24 * 3600) * 1000);
  prisma.historicalImport.findMany.mockImplementation(async () => (state.status === "SOURCE_SYNCING" ? [{ id: "imp1" }] : []));
  prisma.historicalImport.findUnique.mockImplementation(async () => ({
    id: "imp1", tenantId: "t1", status: state.status, sourceDeadlineAt: deadlineAt,
    sourceProgress: Math.max(0, ...arrived().map((c) => c.progress)),
  }));
  prisma.historicalImportChunk.count.mockResolvedValue(opts.unprocessed ?? 0);
  prisma.historicalImportChunk.groupBy.mockImplementation(async () => {
    const by = new Map<number, { phase: number; _max: { progress: number; receivedAt: Date } }>();
    for (const c of arrived()) {
      const at = new Date(T0 + c.at * 1000);
      const g = by.get(c.phase);
      if (!g) by.set(c.phase, { phase: c.phase, _max: { progress: c.progress, receivedAt: at } });
      else { g._max.progress = Math.max(g._max.progress, c.progress); if (at > g._max.receivedAt) g._max.receivedAt = at; }
    }
    return [...by.values()];
  });
  prisma.historicalImport.updateMany.mockImplementation(async ({ data }: any) => {
    if (data?.status !== "SOURCE_COMPLETE" || state.status !== "SOURCE_SYNCING") return { count: 0 };
    state.status = "SOURCE_COMPLETE";
    return { count: 1 };
  });
  return (async () => {
    let handedAt: number | null = null;
    const step = opts.step ?? 5;
    for (let t = 0; t <= opts.until; t += step) {
      clock = T0 + t * 1000;
      await sweepQuietSourceTransfers(clock);
      if (handedAt === null && historicalIntelligenceQueue.add.mock.calls.length > 0) handedAt = t;
    }
    const done = prisma.historicalImportEvent.create.mock.calls.map((c: any) => c[0].data).find((d: any) => d.message === "source transfer complete");
    return { handedAt, enqueued: historicalIntelligenceQueue.add.mock.calls.length, why: done?.detail?.why };
  })();
}

// Prod Smoovee 2026-11-13, as received (import cmweqwb6y00ipkdj30mmzm9rt).
const SMOOVEE: Chunk[] = [
  { phase: 0, progress: 0, at: 0 },
  ...[[7, 25.9], [15, 37.5], [22, 43.8], [30, 50.8], [38, 61.6], [45, 71.4], [53, 77.3], [61, 84.0], [68, 87.2], [76, 96.3], [84, 100.1], [91, 105.5], [100, 107.6]]
    .map(([progress, at]) => ({ phase: 1, progress, at })),
  { phase: 2, progress: 100, at: 109.4 },
  { phase: 1, progress: 99, at: 115.2 }, // chunk 13, after the end marker
];

describe("the transfer is over when Meta's history has stopped (prod GOTCHA 2026-11-10, Smoovee 2026-11-13)", () => {
  it("★ Smoovee: phase 0 stuck at 0, the phase 2 marker, then a late phase 1 chunk: handed over ONCE, 2 minutes after the LAST chunk", async () => {
    const r = await simulate(SMOOVEE, { until: 1800 });
    expect(r.enqueued).toBe(1);
    // 115.2s + 120s = 235.2s; the first 5s tick after it.
    expect(r.handedAt).toBe(240);
    expect(r.why).toBe("final phase complete");
  });

  it("★ the late chunk restarts the wait: 2 minutes after the phase 2 marker alone is too early", async () => {
    // 109.4s + 120s = 229.4s would be the moment if the wait ran from the marker.
    const r = await simulate(SMOOVEE, { until: 235, step: 0.5 });
    expect(r.enqueued).toBe(0);
  });

  it("★ GOTCHA: phase 0 at 100 while phase 1 transfers, then phase 2: handed over once, after phase 2 and the quiet", async () => {
    const chunks: Chunk[] = [
      { phase: 0, progress: 50, at: 0 }, { phase: 0, progress: 100, at: 10 },
      ...[7, 20, 40, 53, 70, 90].map((progress, i) => ({ phase: 1, progress, at: 30 + i * 50 })),
      { phase: 1, progress: 100, at: 340 },
      { phase: 2, progress: 100, at: 350 },
    ];
    const r = await simulate(chunks, { until: 1800 });
    expect(r.enqueued).toBe(1);
    expect(r.handedAt).toBe(470);
  });

  it("★ a phase stalled part-way for longer than the quiet window is not over", async () => {
    // Phase 0 done, phase 1 at 53 and silent for 20 minutes, then it resumes.
    const chunks: Chunk[] = [
      { phase: 0, progress: 100, at: 0 },
      { phase: 1, progress: 53, at: 30 },
      { phase: 1, progress: 100, at: 1230 },
    ];
    const r = await simulate(chunks, { until: 3600 });
    expect(r.enqueued).toBe(1);
    expect(r.handedAt).toBe(1230 + 600);
    expect(r.why).toBe("quiet window");
  });

  it("★ no phase 2 ever: handed over after 10 quiet minutes, not after 2", async () => {
    const chunks: Chunk[] = [
      { phase: 0, progress: 100, at: 0 },
      { phase: 1, progress: 40, at: 20 },
      { phase: 1, progress: 100, at: 60 },
    ];
    const r = await simulate(chunks, { until: 3600 });
    expect(r.enqueued).toBe(1);
    expect(r.handedAt).toBe(660);
    expect(r.why).toBe("quiet window");
  });

  it("★ past the 24h deadline what arrived is handed over, even part-way; never before it", async () => {
    const chunks: Chunk[] = [{ phase: 1, progress: 53, at: 0 }];
    const before = await simulate(chunks, { until: 3000, step: 60, deadline: 3600 });
    expect(before.enqueued).toBe(0);
    vi.clearAllMocks();
    const after = await simulate(chunks, { until: 3660, step: 60, deadline: 3600 });
    expect(after.enqueued).toBe(1);
    expect(after.handedAt).toBe(3600);
    expect(after.why).toBe("deadline");
  });

  it("the sweep looks at transfers with a phase at 100 or past their deadline", async () => {
    prisma.historicalImport.findMany.mockResolvedValue([]);
    const now = Date.now();
    await sweepQuietSourceTransfers(now);
    expect(prisma.historicalImport.findMany.mock.calls[0][0].where).toEqual({
      status: "SOURCE_SYNCING",
      OR: [{ sourceProgress: 100 }, { sourceDeadlineAt: { lte: new Date(now) } }],
    });
  });

  it("a chunk still being ingested holds the handover, even past the deadline", async () => {
    const r = await simulate(SMOOVEE, { until: 1800, deadline: 600, unprocessed: 1 });
    expect(r.enqueued).toBe(0);
  });

  it("a chunk on its own never hands over: every rule needs quiet", async () => {
    prisma.historicalImport.findUnique.mockResolvedValue({ id: "imp1", tenantId: "t1", sourceProgress: 100, status: "SOURCE_SYNCING", sourceDeadlineAt: new Date(Date.now() + 3600_000) });
    prisma.historicalImportChunk.groupBy.mockResolvedValue([0, 1, 2].map((phase) => ({ phase, _max: { progress: 100, receivedAt: new Date() } })));
    await processHistoricalChunk(job({ chunk: { phase: 2, progress: 100 } }));
    expect(historicalIntelligenceQueue.add).not.toHaveBeenCalled();
  });

  it("the rule itself", () => {
    const now = Date.now();
    const at = (ago: number) => new Date(now - ago);
    const r = (phases: any[], deadlineAt?: Date) => sourceTransferReady({ phases, now, deadlineAt });
    expect(r([]).ready).toBe(false);
    expect(r([{ phase: 2, progress: 100, lastAt: at(FINAL_QUIET_MS - 1) }]).ready).toBe(false);
    expect(r([{ phase: 2, progress: 100, lastAt: at(FINAL_QUIET_MS) }, { phase: 0, progress: 0, lastAt: at(9e6) }])).toMatchObject({ ready: true, why: "final phase complete", phases: [0, 2] });
    expect(r([{ phase: 0, progress: 100, lastAt: at(SOURCE_QUIET_MS - 1) }]).ready).toBe(false);
    expect(r([{ phase: 0, progress: 100, lastAt: at(SOURCE_QUIET_MS) }])).toMatchObject({ ready: true, why: "quiet window" });
    expect(r([{ phase: 0, progress: 0, lastAt: at(SOURCE_QUIET_MS) }, { phase: 1, progress: 100, lastAt: at(SOURCE_QUIET_MS) }])).toMatchObject({ ready: true, why: "quiet window" });
    expect(r([{ phase: 0, progress: 100, lastAt: at(9e6) }, { phase: 1, progress: 99, lastAt: at(9e6) }]).ready).toBe(false);
    expect(r([{ phase: 1, progress: 99, lastAt: at(0) }], at(0))).toMatchObject({ ready: true, why: "deadline" });
    expect(r([{ phase: 1, progress: 99, lastAt: at(0) }], new Date(now + 1)).ready).toBe(false);
  });
});

describe("a transfer past its 24h window is never left syncing", () => {
  const PAST = { id: "imp1", tenantId: "t1", status: "SOURCE_SYNCING", sourceProgress: 53, sourceMetadata: null, sourceDeadlineAt: new Date(Date.now() - 60_000) };

  it("a chunk arriving after the deadline hands the old transfer over and joins it, instead of failing it", async () => {
    prisma.historicalImport.findFirst.mockResolvedValue(PAST);
    let status = "SOURCE_SYNCING";
    prisma.historicalImport.findUnique.mockImplementation(async () => ({ ...PAST, status }));
    prisma.historicalImportChunk.groupBy.mockResolvedValue([{ phase: 1, _max: { progress: 53, receivedAt: new Date(Date.now() - 3600_000) } }]);
    prisma.historicalImport.updateMany.mockImplementation(async ({ data }: any) => {
      if (data?.status === "SOURCE_COMPLETE" && status === "SOURCE_SYNCING") { status = "SOURCE_COMPLETE"; return { count: 1 }; }
      return { count: 0 };
    });
    await processHistoricalChunk(job());
    expect(historicalIntelligenceQueue.add).toHaveBeenCalledTimes(1);
    expect(prisma.historicalImport.create).not.toHaveBeenCalled();
    expect(prisma.historicalImport.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });

  it("one that cannot be handed over (a chunk never ingested) is failed and a new import starts", async () => {
    prisma.historicalImport.findFirst.mockResolvedValue(PAST);
    prisma.historicalImport.findUnique.mockResolvedValue(PAST);
    prisma.historicalImportChunk.count.mockResolvedValue(1);
    prisma.historicalImport.create.mockResolvedValue({ ...IMPORT_ROW, id: "imp2" });
    await processHistoricalChunk(job());
    expect(prisma.historicalImport.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "imp1" }, data: expect.objectContaining({ status: "FAILED" }) }));
    expect(prisma.historicalImport.create).toHaveBeenCalledTimes(1);
  });
});
