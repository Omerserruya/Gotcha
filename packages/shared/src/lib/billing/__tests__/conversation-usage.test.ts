import { describe, it, expect, beforeEach, vi } from "vitest";

// ── In-memory prisma for the aggregation path ───────────────────────────────
interface Log {
  id: string;
  feature: string | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  unitsConsumed: number;
  metadata: unknown;
  createdAt: Date;
}

const db = {
  conversations: [] as any[],
  logs: [] as Log[],
  aggregates: [] as any[],
  links: [] as any[],
  voiceSessions: [] as any[],
  /**
   * Every read of the TenantGuard-scoped `Conversation` model, and whether it
   * happened inside a cross-tenant scope. A `false` here is the exact
   * production failure this file guards against: the guard refuses the query,
   * the throw takes the whole usage stage with it, and the tick then reports
   * `settled: 0, discovered: 0` - indistinguishable from "nothing was due".
   */
  guardedReads: [] as { op: string; scoped: boolean }[],
  crossTenantDepth: 0,
};

let idSeq = 0;
const nextId = () => `id-${++idSeq}`;

vi.mock("../../prisma", () => ({
  // Mirrors the real helper: adopt the promise INSIDE the scope. The module
  // under test wraps its platform-wide conversation reads in this, so a mock
  // without it makes every one of those call sites throw.
  withCrossTenantAccess: async (fn: () => Promise<unknown>) => {
    db.crossTenantDepth++;
    try {
      return await fn();
    } finally {
      db.crossTenantDepth--;
    }
  },
  prisma: {
    conversation: {
      findUnique: async ({ where }: any) => {
        db.guardedReads.push({ op: "conversation.findUnique", scoped: db.crossTenantDepth > 0 });
        return db.conversations.find((c) => c.id === where.id) ?? null;
      },
      findMany: async ({ where }: any) => {
        db.guardedReads.push({ op: "conversation.findMany", scoped: db.crossTenantDepth > 0 });
        return db.conversations.filter((c) => {
          if (where?.status && c.status !== where.status) return false;
          if (where?.closedAt?.lte && (!c.closedAt || c.closedAt > where.closedAt.lte)) return false;
          if (where?.closedAt?.not === null && !c.closedAt) return false;
          return true;
        });
      },
    },
    voiceCallSession: {
      findUnique: async ({ where }: any) => db.voiceSessions.find((v) => v.conversationId === where.conversationId) ?? null,
    },
    usageLog: {
      findMany: async () => db.logs,
    },
    conversationUsageAggregate: {
      findUnique: async ({ where }: any) => {
        const a = db.aggregates.find((x) => x.conversationId === where.conversationId);
        if (!a) return null;
        return { ...a, links: db.links.filter((l) => l.aggregateId === a.id) };
      },
      findMany: async ({ where, select }: any) =>
        db.aggregates
          .filter((a) => {
            if (where?.status?.in && !where.status.in.includes(a.status)) return false;
            if (where?.status && typeof where.status === "string" && a.status !== where.status) return false;
            if (where?.conversationId?.in && !where.conversationId.in.includes(a.conversationId)) return false;
            if (where?.resolvedAt?.not === null && !a.resolvedAt) return false;
            if (where?.resolvedAt?.lte && (!a.resolvedAt || a.resolvedAt > where.resolvedAt.lte)) return false;
            return true;
          })
          .map((a) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, a[k]])) : a)),
      upsert: async ({ where, create, update }: any) => {
        const existing = db.aggregates.find((a) => a.conversationId === where.conversationId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: nextId(), totalCredits: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, modelCostUsd: 0, eventCount: 0, ...create };
        db.aggregates.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const a = db.aggregates.find((x) => x.conversationId === where.conversationId || x.id === where.id)!;
        for (const [k, v] of Object.entries(data as any)) {
          if (v && typeof v === "object" && "increment" in (v as any)) a[k] = Number(a[k] ?? 0) + Number((v as any).increment);
          else a[k] = v;
        }
        return a;
      },
      updateMany: async ({ where, data }: any) => {
        const rows = db.aggregates.filter((a) => a.conversationId === where.conversationId);
        rows.forEach((a) => Object.assign(a, data));
        return { count: rows.length };
      },
    },
    conversationUsageEventLink: {
      create: async ({ data }: any) => {
        if (db.links.some((l) => l.usageLogId === data.usageLogId)) {
          const err: any = new Error("unique");
          err.code = "P2002";
          throw err;
        }
        const row = { id: nextId(), ...data };
        db.links.push(row);
        return row;
      },
    },
  },
}));

import {
  aggregateConversation,
  settleDueConversations,
  excludeConversation,
  computeStats,
  compareEstimateToActual,
  conversationIdOf,
  SETTLEMENT_WINDOW_MS,
} from "../conversation-usage";

const T = "tenant-1";
const C = "convo-1";
const NOW = new Date("2026-08-01T12:00:00.000Z");

function seedConversation(opts: { closedAt?: Date | null; status?: string; id?: string } = {}) {
  db.conversations.push({
    id: opts.id ?? C,
    tenantId: T,
    channel: "WHATSAPP",
    assignedAiAgentId: "agent-1",
    createdAt: new Date(NOW.getTime() - 7_200_000),
    closedAt: opts.closedAt ?? null,
    status: opts.status ?? (opts.closedAt ? "CLOSED" : "OPEN"),
  });
}

function seedLog(partial: Partial<Log> & { id: string; conversationId?: string }) {
  db.logs.push({
    feature: "chat",
    model: "gpt-5-mini",
    promptTokens: 1000,
    completionTokens: 200,
    costUsd: 0.001,
    unitsConsumed: 1.5,
    createdAt: NOW,
    metadata: { conversationId: partial.conversationId ?? C },
    ...partial,
  } as Log);
}

beforeEach(() => {
  db.conversations = [];
  db.logs = [];
  db.aggregates = [];
  db.links = [];
  db.voiceSessions = [];
  db.guardedReads = [];
  db.crossTenantDepth = 0;
  idSeq = 0;
});

describe("conversation usage - tenant guard", () => {
  // Regression: the settlement sweep reads `Conversation` platform-wide, with
  // no tenant in hand. Unscoped, the TenantGuard refuses it, and since the
  // sweep is the first statement of the usage stage the throw killed the whole
  // stage - which then reported `settled: 0, discovered: 0` and looked idle.
  it("reads conversations platform-wide only inside a cross-tenant scope", async () => {
    const closedLongAgo = new Date(NOW.getTime() - SETTLEMENT_WINDOW_MS - 60_000);
    seedConversation({ closedAt: closedLongAgo, status: "CLOSED" });
    seedLog({ id: "log-1" });

    await settleDueConversations(NOW, 50);

    const unscoped = db.guardedReads.filter((r) => !r.scoped);
    expect(db.guardedReads.length).toBeGreaterThan(0);
    expect(unscoped).toEqual([]);
  });

  it("scopes the primary-key lookup too - the tenant is what it is there to learn", async () => {
    seedConversation({ closedAt: null });
    seedLog({ id: "log-1" });

    await aggregateConversation(C, { now: NOW });

    const pk = db.guardedReads.filter((r) => r.op === "conversation.findUnique");
    expect(pk.length).toBeGreaterThan(0);
    expect(pk.every((r) => r.scoped)).toBe(true);
  });
});

describe("conversation usage - attribution", () => {
  it("attributes a usage event by its conversationId metadata", () => {
    expect(conversationIdOf({ metadata: { conversationId: "abc" } })).toBe("abc");
    expect(conversationIdOf({ metadata: { conversation_id: "abc" } })).toBe("abc");
    expect(conversationIdOf({ metadata: {} })).toBeNull();
    expect(conversationIdOf({ metadata: null })).toBeNull();
  });

  it("rolls every attributable event into one aggregate", async () => {
    seedConversation();
    seedLog({ id: "l1", unitsConsumed: 2, promptTokens: 1000, completionTokens: 100, costUsd: 0.002 });
    seedLog({ id: "l2", feature: "summary", unitsConsumed: 5, promptTokens: 4000, completionTokens: 500, costUsd: 0.01 });
    seedLog({ id: "l3", feature: "sentiment", unitsConsumed: 0.5, promptTokens: 200, completionTokens: 20, costUsd: 0.0003 });

    const r = await aggregateConversation(C, { now: NOW });
    expect(r?.linkedEvents).toBe(3);
    expect(r?.totalCredits).toBeCloseTo(7.5, 5);
    expect(r?.totalTokens).toBe(5820);

    const agg = db.aggregates[0];
    expect(agg.summaryIncluded).toBe(true);
    expect(agg.totalInputTokens).toBe(5200);
    expect(agg.totalOutputTokens).toBe(620);
  });

  it("ignores usage belonging to a different conversation", async () => {
    seedConversation();
    seedLog({ id: "l1", unitsConsumed: 2 });
    seedLog({ id: "l2", unitsConsumed: 99, conversationId: "some-other-conversation" });
    const r = await aggregateConversation(C, { now: NOW });
    expect(r?.linkedEvents).toBe(1);
    expect(r?.totalCredits).toBe(2);
  });

  it("marks a voice conversation as VOICE", async () => {
    seedConversation();
    db.voiceSessions.push({ conversationId: C, id: "vs-1" });
    seedLog({ id: "l1", feature: "voice_transcription" });
    await aggregateConversation(C, { now: NOW });
    expect(db.aggregates[0].conversationType).toBe("VOICE");
    expect(db.aggregates[0].voiceIncluded).toBe(true);
  });

  it("records the most expensive model as the primary one", async () => {
    seedConversation();
    seedLog({ id: "l1", model: "gpt-5-mini", costUsd: 0.001 });
    seedLog({ id: "l2", model: "gpt-5", costUsd: 0.05 });
    await aggregateConversation(C, { now: NOW });
    expect(db.aggregates[0].primaryModel).toBe("gpt-5");
  });
});

describe("conversation usage - idempotency", () => {
  it("re-aggregating the same events does not double-count", async () => {
    seedConversation();
    seedLog({ id: "l1", unitsConsumed: 3 });
    seedLog({ id: "l2", unitsConsumed: 4 });

    const first = await aggregateConversation(C, { now: NOW });
    expect(first?.totalCredits).toBe(7);

    const second = await aggregateConversation(C, { now: NOW });
    expect(second?.linkedEvents).toBe(0);
    expect(second?.skippedDuplicates).toBe(2);
    // The total is unchanged - this is the guarantee the unique link provides.
    expect(second?.totalCredits).toBe(7);
  });

  it("adds only genuinely new late events on a second pass", async () => {
    seedConversation();
    seedLog({ id: "l1", unitsConsumed: 3 });
    await aggregateConversation(C, { now: NOW });

    // A post-close summary lands after the first aggregation.
    seedLog({ id: "l2", feature: "crm_summary", unitsConsumed: 6 });
    const r = await aggregateConversation(C, { now: NOW });
    expect(r?.linkedEvents).toBe(1);
    expect(r?.totalCredits).toBe(9);
    expect(db.aggregates[0].summaryIncluded).toBe(true);
  });

  it("survives a concurrent link on the same usage event", async () => {
    seedConversation();
    seedLog({ id: "l1", unitsConsumed: 3 });
    // Simulate another worker having linked it already.
    await aggregateConversation(C, { now: NOW });
    db.aggregates[0].totalCredits = 3;
    const again = await aggregateConversation(C, { now: NOW });
    expect(again?.totalCredits).toBe(3);
  });
});

describe("conversation usage - lifecycle", () => {
  it("stays OPEN while the conversation is open", async () => {
    seedConversation({ closedAt: null });
    seedLog({ id: "l1" });
    await aggregateConversation(C, { now: NOW });
    expect(db.aggregates[0].status).toBe("OPEN");
    expect(db.aggregates[0].finalizedAt).toBeNull();
  });

  it("SETTLES rather than finalizing inside the settlement window", async () => {
    // Closed one minute ago: post-close jobs may still be running.
    seedConversation({ closedAt: new Date(NOW.getTime() - 60_000) });
    seedLog({ id: "l1" });
    await aggregateConversation(C, { now: NOW });
    expect(db.aggregates[0].status).toBe("SETTLING");
    expect(db.aggregates[0].finalizedAt).toBeNull();
  });

  it("FINALIZES once the settlement window has elapsed", async () => {
    seedConversation({ closedAt: new Date(NOW.getTime() - SETTLEMENT_WINDOW_MS - 1000) });
    seedLog({ id: "l1" });
    await aggregateConversation(C, { now: NOW });
    expect(db.aggregates[0].status).toBe("FINALIZED");
    expect(db.aggregates[0].finalizedAt).toBeTruthy();
  });

  it("drops a reopened conversation back out of the averages", async () => {
    seedConversation({ closedAt: new Date(NOW.getTime() - SETTLEMENT_WINDOW_MS - 1000) });
    seedLog({ id: "l1" });
    await aggregateConversation(C, { now: NOW });
    expect(db.aggregates[0].status).toBe("FINALIZED");

    // The customer replies: the conversation reopens.
    db.conversations[0].status = "OPEN";
    db.conversations[0].closedAt = null;
    seedLog({ id: "l2", unitsConsumed: 2 });
    await aggregateConversation(C, { now: NOW });
    expect(db.aggregates[0].status).toBe("OPEN");
    expect(db.aggregates[0].finalizedAt).toBeNull();
  });

  it("excludes a conversation with a stated reason", async () => {
    seedConversation();
    seedLog({ id: "l1" });
    await aggregateConversation(C, { now: NOW });
    await excludeConversation(C, "test", "convo-2");
    expect(db.aggregates[0].status).toBe("EXCLUDED");
    expect(db.aggregates[0].excludedReason).toBe("test");
    expect(db.aggregates[0].mergedIntoId).toBe("convo-2");
  });

  it("discovers closed conversations that have no aggregate yet", async () => {
    seedConversation({ id: "c-a", closedAt: new Date(NOW.getTime() - SETTLEMENT_WINDOW_MS - 5000) });
    seedConversation({ id: "c-b", closedAt: new Date(NOW.getTime() - SETTLEMENT_WINDOW_MS - 5000) });
    seedLog({ id: "l1", conversationId: "c-a" });
    seedLog({ id: "l2", conversationId: "c-b" });

    const r = await settleDueConversations(NOW, 50);
    expect(r.discovered).toBe(2);
    expect(db.aggregates).toHaveLength(2);
    expect(db.aggregates.every((a) => a.status === "FINALIZED")).toBe(true);
  });
});

describe("conversation usage - statistics", () => {
  const rows = (credits: number[]) =>
    credits.map((c) => ({ credits: c, inputTokens: c * 100, outputTokens: c * 20, costUsd: c * 0.001 }));

  it("returns zeros for an empty set instead of NaN", () => {
    const s = computeStats([]);
    expect(s.conversations).toBe(0);
    expect(s.avgCreditsPerConversation).toBe(0);
    expect(Number.isNaN(s.stdDevCredits)).toBe(false);
  });

  it("computes the weighted average as total / count", () => {
    const s = computeStats(rows([2, 4, 6, 8]));
    expect(s.conversations).toBe(4);
    expect(s.totalCredits).toBe(20);
    expect(s.avgCreditsPerConversation).toBe(5);
  });

  it("computes percentiles and the spread", () => {
    const s = computeStats(rows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(s.medianCredits).toBeCloseTo(5.5, 5);
    expect(s.p75Credits).toBeCloseTo(7.75, 5);
    expect(s.p90Credits).toBeCloseTo(9.1, 5);
    expect(s.p95Credits).toBeCloseTo(9.55, 5);
    expect(s.minCredits).toBe(1);
    expect(s.maxCredits).toBe(10);
    expect(s.stdDevCredits).toBeGreaterThan(0);
  });

  it("handles a single conversation", () => {
    const s = computeStats(rows([7]));
    expect(s.medianCredits).toBe(7);
    expect(s.p95Credits).toBe(7);
    expect(s.stdDevCredits).toBe(0);
  });

  /**
   * The invariant the whole dashboard rests on. A tiny pilot and a huge account
   * must not carry equal weight in the platform figure.
   */
  it("the weighted global average is NOT the mean of per-organization averages", () => {
    // Org A: 1 conversation at 100 credits. Org B: 99 conversations at 1 credit.
    const orgA = rows([100]);
    const orgB = rows(new Array(99).fill(1));

    const weighted = computeStats([...orgA, ...orgB]);
    expect(weighted.conversations).toBe(100);
    expect(weighted.totalCredits).toBe(199);
    expect(weighted.avgCreditsPerConversation).toBeCloseTo(1.99, 5);

    // The naive mean-of-means would be (100 + 1) / 2 = 50.5 - off by 25x.
    const meanOfMeans =
      (computeStats(orgA).avgCreditsPerConversation + computeStats(orgB).avgCreditsPerConversation) / 2;
    expect(meanOfMeans).toBeCloseTo(50.5, 5);
    expect(weighted.avgCreditsPerConversation).not.toBeCloseTo(meanOfMeans, 1);
  });
});

describe("estimate vs actual - advisory only", () => {
  const stats = (avg: number, n: number) =>
    computeStats(new Array(n).fill(0).map(() => ({ credits: avg, inputTokens: 0, outputTokens: 0, costUsd: 0 })));

  it("reports the divergence as a percentage", () => {
    const c = compareEstimateToActual({ configuredPublicEstimate: 8, stats: stats(11.4, 100), channel: "chat" });
    expect(c.actualAverage).toBeCloseTo(11.4, 5);
    expect(c.differencePct).toBeCloseTo(42.5, 1);
    expect(c.warn).toBe(true);
  });

  it("does not warn inside the threshold", () => {
    const c = compareEstimateToActual({ configuredPublicEstimate: 8, stats: stats(8.5, 100), channel: "chat" });
    expect(c.warn).toBe(false);
  });

  it("honours a custom warning threshold", () => {
    const c = compareEstimateToActual({
      configuredPublicEstimate: 8, stats: stats(8.5, 100), channel: "chat", warnThresholdPct: 5,
    });
    expect(c.warn).toBe(true);
  });

  it("reports null rather than a fake number when there is no data", () => {
    const c = compareEstimateToActual({ configuredPublicEstimate: 8, stats: stats(0, 0), channel: "chat" });
    expect(c.differencePct).toBeNull();
    expect(c.warn).toBe(false);
  });

  /** The contract: comparing never publishes. */
  it("never auto-applies, whatever the divergence", () => {
    for (const actual of [0.1, 8, 100, 100_000]) {
      const c = compareEstimateToActual({ configuredPublicEstimate: 8, stats: stats(actual, 500), channel: "chat" });
      expect(c.autoApplied).toBe(false);
    }
  });
});
