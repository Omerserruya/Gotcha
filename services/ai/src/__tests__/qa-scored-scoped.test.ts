/**
 * qa.scored is one agent's performance - it goes to that agent's room, never
 * the tenant. No assigned agent: not published live at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ events: [] as any[], assigned: "agent7" as string | null }));

vi.mock("@chatcenter/shared", () => ({
  publishEvent: async (e: any) => { H.events.push(e); },
  prisma: {
    callAnalysis: { findUnique: async () => ({ id: "ca1", tenantId: "T", mode: "live", frames: [{ version: 1, risks: [] }] }) },
    conversation: { findFirst: async (a: any) => (a.where.tenantId === "T" ? { assignedAgentId: H.assigned } : null) },
  },
}));
vi.mock("../services/intelligence/analyzers/playbook-compliance", () => ({
  PlaybookCompliance: class { async analyze() { return { score: 0.8, findings: [] }; } },
}));
vi.mock("../services/intelligence/analyzers/coaching-analyzer", () => ({
  CoachingAnalyzer: class { async analyze() { return { score: 0.6, findings: [] }; } },
}));
vi.mock("../services/intelligence/persistence/qa-score-store", () => ({
  QAScoreStore: { create: async () => ({ id: "qa1" }) },
}));

import { runQA } from "../workers/post-call/qa-runner";

beforeEach(() => { H.events.length = 0; H.assigned = "agent7"; });

describe("qa.scored", () => {
  it("★ goes to the assigned agent's room only", async () => {
    expect(await runQA({ tenantId: "T", conversationId: "c1" } as any)).toMatchObject({ ok: true });
    const e = H.events.find((x) => x.event === "qa.scored");
    expect(e.data.channel).toBe("agent:agent7");
  });

  it("no assigned agent: the score is saved, nothing is broadcast", async () => {
    H.assigned = null;
    expect(await runQA({ tenantId: "T", conversationId: "c1" } as any)).toMatchObject({ ok: true, qaScoreId: "qa1" });
    expect(H.events.filter((x) => x.event === "qa.scored")).toHaveLength(0);
  });
});
