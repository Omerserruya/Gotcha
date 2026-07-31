import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The post-chat pipeline must run ONCE per conversation, even when
 * `conversation:closed` is delivered twice.
 *
 * The old guard read CallAnalysis, concluded "not summarised yet", and then
 * spent seconds in the summariser before writing anything. Two concurrent
 * deliveries both passed that read. The duplicated CallAnalysis row collapses
 * under `upsert` and hides the problem; what the merchant actually saw was a
 * second note and a second task on the customer's record in their CRM, because
 * those go to a vendor that cannot know we already wrote them.
 *
 * These tests drive the claim through a fake `call_analyses` table so the
 * conditional UPDATE is exercised as a real race, not asserted about.
 */

// ── a minimal stand-in for the one row the claim touches ────────────────────
// Hoisted: vi.mock factories are lifted above this file's top-level consts, so
// anything they close over has to be created inside vi.hoisted.
const H = vi.hoisted(() => {
  interface Row { conversationId: string; meta: Record<string, unknown> | null; finalSummary: string | null }
  const table = new Map<string, Row>();

  /** Applies the same predicate the SQL claim uses. */
  const runClaimSql = (conversationId: string, nowIso: string, cutoffIso: string): number => {
    const row = table.get(conversationId);
    if (!row) return 0;
    const held = (row.meta ?? {})["postChatClaimAt"] as string | undefined;
    const free = held == null || held < cutoffIso;
    if (!free) return 0;
    row.meta = { ...(row.meta ?? {}), postChatClaimAt: nowIso };
    return 1;
  };

  const runReleaseSql = (conversationId: string): number => {
    const row = table.get(conversationId);
    if (!row) return 0;
    const { postChatClaimAt, ...rest } = (row.meta ?? {}) as any;
    row.meta = rest;
    return 1;
  };

  return { table, runClaimSql, runReleaseSql, summarize: vi.fn() };
});

const { table, summarize } = H;

vi.mock("@chatcenter/shared", () => ({
  // Durable tenant settings (business hours, auto-greeting, SLA). Exhaustive
  // mocks of this barrel must supply them or the read path throws instead of
  // returning "not configured". Default: nothing configured.
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  prisma: {
    callAnalysis: {
      findUnique: async ({ where }: any) => H.table.get(where.conversationId) ?? null,
      upsert: async ({ where, create }: any) => {
        if (!H.table.get(where.conversationId)) {
          H.table.set(where.conversationId, {
            conversationId: where.conversationId, meta: create.meta ?? null, finalSummary: null,
          });
        }
      },
    },
    conversation: { findUnique: async () => null, update: async () => undefined },
    contact: { findFirst: async () => null },
    $executeRaw: async (strings: TemplateStringsArray, ...vals: any[]) => {
      const sql = strings.join(" ");
      if (sql.includes("- 'postChatClaimAt'")) return H.runReleaseSql(vals[0]);
      // vals: [nowIso, conversationId, cutoffIso] per the template's order
      const [nowIso, conversationId, cutoffIso] = vals;
      return H.runClaimSql(conversationId, nowIso, cutoffIso);
    },
  },
  isEntitled: async () => true,
  resolveEffectiveLocale: async () => ({ effective: "en" }),
}));

vi.mock("../services/post-conversation-summarizer.service", () => ({
  summarizePostConversation: H.summarize,
}));
vi.mock("../services/post-conversation-config.service", () => ({
  getSummarizerAllowedFields: async () => [],
  getPostConversationConfig: async () => ({}),
}));
vi.mock("../services/post-conversation-rule-engine.service", () => ({
  applyPostConversationRules: (raw: any) => raw,
}));
vi.mock("../services/post-conversation-crm.service", () => ({
  applyCrmPatchKindAware: async () => ({ ok: false, outcome: "skipped" }),
  createCrmTaskKindAware: async () => ({ ok: false, outcome: "skipped" }),
  getCrmIdentity: async () => ({ crmContactId: null, crmObjectKind: null }),
}));
vi.mock("../services/existing-action-items.service", () => ({ loadExistingActionItems: async () => [] }));
vi.mock("../services/intelligence-ingest.service", () => ({ ingestConversationFacts: async () => ({}) }));
vi.mock("../services/action-executor.service", () => ({ executeAction: async () => ({ ok: true }) }));

import { runPostChatPipeline } from "../services/post-chat-pipeline.service";

// The shape the rule engine hands downstream. Named so a future field the
// pipeline starts reading fails here loudly rather than as "cannot convert
// undefined to object" halfway down.
const SUMMARY = (summary: string) => ({
  empty: false,
  summary,
  crm_patch: {},
  suggested_tasks: [],
  mentioned_fields: [],
  followup: null,
});

const CONV = "conv_1";
const run = () => runPostChatPipeline({ tenantId: "t1", conversationId: CONV, actorId: "test" });

beforeEach(() => {
  table.clear();
  summarize.mockReset();
  // A slow summariser is the whole point: it holds the window open, which is
  // exactly when the old read-then-act guard let a second run through.
  summarize.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 25));
    return SUMMARY("the customer asked about delivery");
  });
});

describe("two deliveries of the same closed conversation", () => {
  it("summarises once when they arrive CONCURRENTLY", async () => {
    const [a, b] = await Promise.all([run(), run()]);

    const summarised = [a, b].filter((r) => r.summarized).length;
    const skipped = [a, b].filter((r) => r.notes.includes("claimed-by-another-run"));
    expect(summarize, "the LLM must run once, not twice").toHaveBeenCalledTimes(1);
    expect(summarised).toBe(1);
    expect(skipped).toHaveLength(1);
  });

  it("reports the skip honestly rather than claiming it summarised", async () => {
    // A caller that logs `summarized=true` for a run that did nothing makes the
    // duplicate invisible in exactly the logs you would use to find it.
    const [a, b] = await Promise.all([run(), run()]);
    const skipped = [a, b].find((r) => r.notes.includes("claimed-by-another-run"))!;
    expect(skipped.summarized).toBe(false);
    expect(skipped.crmWritten).toBe(false);
    expect(skipped.ok).toBe(true); // not an error - the work was done elsewhere
  });

  it("takes the cheap path when they arrive SEQUENTIALLY", async () => {
    await run();
    // Simulate the completed state the real persist step writes.
    const row = table.get(CONV)!;
    row.finalSummary = "the customer asked about delivery";
    row.meta = { ...(row.meta ?? {}), structured: { summary: "x" } };

    summarize.mockClear();
    const second = await run();
    expect(second.notes).toContain("already-processed");
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe("the claim does not strand a conversation", () => {
  it("hands the claim back when there was nothing to summarise", async () => {
    summarize.mockResolvedValue({ ...SUMMARY(""), empty: true, summary: null });
    const first = await run();
    expect(first.notes).toContain("empty-summary");
    expect(table.get(CONV)?.meta).not.toHaveProperty("postChatClaimAt");

    // A retry must start immediately, not wait out the stale window.
    summarize.mockResolvedValue(SUMMARY("now there is something"));
    const second = await run();
    expect(second.notes).not.toContain("claimed-by-another-run");
    expect(second.summarized).toBe(true);
  });

  it("lets a later run take over a claim left behind by a dead worker", async () => {
    table.set(CONV, {
      conversationId: CONV,
      // Older than CLAIM_STALE_MS: a worker that died mid-run must not lock
      // this conversation out of summarisation forever.
      meta: { postChatClaimAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
      finalSummary: null,
    });
    const out = await run();
    expect(out.notes).not.toContain("claimed-by-another-run");
    expect(out.summarized).toBe(true);
  });

  it("does not treat a fresh claim as stale", async () => {
    table.set(CONV, {
      conversationId: CONV,
      meta: { postChatClaimAt: new Date().toISOString() },
      finalSummary: null,
    });
    const out = await run();
    expect(out.notes).toContain("claimed-by-another-run");
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe("the claim is not the intelligence runner's status field", () => {
  it("still summarises a conversation the runner already created a row for", async () => {
    // CallAnalysisStore.ensure() writes status:"running" rows for its own
    // reasons. Keying the claim on status would skip every conversation it had
    // touched - silently, and only for tenants using that runner.
    table.set(CONV, { conversationId: CONV, meta: {}, finalSummary: null });
    const out = await run();
    expect(out.summarized).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});
