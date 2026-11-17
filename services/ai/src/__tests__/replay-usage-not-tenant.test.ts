/**
 * Prod 2026-11-17: replay-v2 re-ran past conversations under the real tenant, its
 * usage rows (30.5M tokens on Smoovee) filled the 24h cost cap, and live replies were
 * refused (budget_exceeded:tenant_day, 11 conversations escalated). Replay usage is
 * never the tenant's: not in the conversation cap, the tenant cap or its usage figures.
 */
import { describe, it, expect, vi } from "vitest";

const rows: any[] = [];
// A small evaluator of the Prisma where the budget sends (AND / OR / NOT, null, endsWith, gte, a JSON path).
function matches(r: any, w: any): boolean {
  if (!w) return true;
  for (const [k, v] of Object.entries<any>(w)) {
    if (k === "AND") { if (!(v as any[]).every((x) => matches(r, x))) return false; continue; }
    if (k === "OR") { if (!(v as any[]).some((x) => matches(r, x))) return false; continue; }
    if (k === "NOT") { const inner = matches(r, v); if (inner) return false; if (Object.entries(v).some(([f]) => r[f] == null)) return false; continue; }
    if (k === "metadata") { if (r.metadata?.[v.path[0]] !== v.equals) return false; continue; }
    if (v === null) { if (r[k] != null) return false; continue; }
    if (typeof v === "object" && v && "endsWith" in v) { if (r[k] == null || !String(r[k]).endsWith(v.endsWith)) return false; continue; }
    if (typeof v === "object" && v && "gte" in v) { if (!(r[k] >= v.gte)) return false; continue; }
    if (r[k] !== v) return false;
  }
  return true;
}
vi.mock("@chatcenter/shared", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    prisma: {
      usageLog: {
        aggregate: async ({ where }: any) => ({ _sum: { tokensEquivalent: rows.filter((r) => matches(r, where)).reduce((n, r) => n + r.tokensEquivalent, 0) } }),
      },
    },
  };
});

import { createTurnBudget, NOT_REPLAY } from "../services/cost-budget.service";

const now = new Date();
const row = (feature: string | null, tokens: number, conv = "c1", tenantId = "t1") => ({ tenantId, feature, tokensEquivalent: tokens, createdAt: now, metadata: { conversationId: conv } });

describe("replay usage is never the tenant's", () => {
  it("★ 30M replay tokens do not stop a live turn; live usage over the cap still does", async () => {
    rows.length = 0;
    rows.push(row("ai_bot_replay", 30_000_000, "c9"), row("embedding_replay", 500_000, "c9"), row("ai_bot", 1_000_000, "c2"), row(null, 1_000, "c2"));
    const b = createTurnBudget({ tenantId: "t1", conversationId: "c1", capsOverride: { perTenantDaily: 5_000_000, perConversation: 400_000, perTurn: 100_000 } } as any);
    await expect(b.preflight()).resolves.toBeUndefined();
    rows.push(row("ai_bot", 4_500_000, "c3"));
    await expect(b.preflight()).rejects.toMatchObject({ scope: "tenant_day" });
  });

  it("★ the conversation cap: a replay of THIS conversation is not its usage", async () => {
    rows.length = 0;
    rows.push(row("ai_bot_replay", 2_000_000, "c1"));
    const b = createTurnBudget({ tenantId: "t1", conversationId: "c1", capsOverride: { perTenantDaily: 50_000_000, perConversation: 400_000, perTurn: 100_000 } } as any);
    await expect(b.preflight()).resolves.toBeUndefined();
    rows.push(row("ai_bot", 500_000, "c1"));
    await expect(b.preflight()).rejects.toMatchObject({ scope: "conversation" });
  });

  it("★ a row with no feature counts (the null branch is explicit)", () => {
    expect(matches(row(null, 1), NOT_REPLAY)).toBe(true);
    expect(matches(row("ai_bot", 1), NOT_REPLAY)).toBe(true);
    expect(matches(row("catalog_semantic_replay", 1), NOT_REPLAY)).toBe(false);
  });

  it("★ inside the replay lane every usage feature is marked; outside it, nothing changes", async () => {
    const { platformPaidScope, laneFeature, inReplayLane } = await import("../services/ai.service");
    expect(laneFeature("embedding")).toBe("embedding");
    platformPaidScope.run({ reason: "reply_engine_replay" }, () => {
      expect(inReplayLane()).toBe(true);
      expect(laneFeature("embedding")).toBe("embedding_replay");
      expect(laneFeature("catalog_semantic")).toBe("catalog_semantic_replay");
      expect(laneFeature("ai_bot_replay")).toBe("ai_bot_replay");
    });
    platformPaidScope.run({ reason: "reply_engine_shadow" }, () => {
      expect(laneFeature("ai_bot_shadow")).toBe("ai_bot_shadow");
    });
  });
});
