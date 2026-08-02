/**
 * Onboarding must ADOPT the employee the shared wizard created, never generate
 * a second one.
 *
 * Onboarding now renders the same `AgentBuilder` as AI Studio. That wizard
 * creates the employee up front as a DRAFT carrying `builderStep`. If
 * `/onboarding/complete` still ran the generator, the tenant would finish
 * onboarding with TWO employees - the one the owner configured by hand and a
 * machine-generated twin - and the owner's choices would appear to have been
 * ignored.
 *
 * These assert the decision logic in isolation (the route itself needs a live
 * AI service, so the branch is extracted here as the contract under test).
 */
import { describe, it, expect } from "vitest";

type Agent = { id: string; status: string; builderStep: string | null; updatedAt: Date };

/**
 * Mirror of the adopt-or-generate branch in
 * services/auth/src/routes/onboarding.ts → hireRecommendedEmployee.
 */
function decideHirePath(agents: Agent[]): { action: "adopt"; agentId: string } | { action: "generate" } {
  const draft = agents
    .filter((a) => a.status === "DRAFT" && a.builderStep !== null)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  return draft ? { action: "adopt", agentId: draft.id } : { action: "generate" };
}

const t = (min: number) => new Date(Date.now() - min * 60_000);

describe("adopt-or-generate", () => {
  it("adopts the wizard's draft instead of generating a duplicate", () => {
    const agents: Agent[] = [{ id: "a1", status: "DRAFT", builderStep: "tools", updatedAt: t(1) }];
    expect(decideHirePath(agents)).toEqual({ action: "adopt", agentId: "a1" });
  });

  it("generates only when the owner skipped the wizard entirely", () => {
    expect(decideHirePath([])).toEqual({ action: "generate" });
  });

  it("ignores already-ACTIVE employees - those are not in-progress drafts", () => {
    const agents: Agent[] = [{ id: "old", status: "ACTIVE", builderStep: null, updatedAt: t(5) }];
    expect(decideHirePath(agents)).toEqual({ action: "generate" });
  });

  it("ignores a DRAFT with no builderStep (not created by the wizard)", () => {
    const agents: Agent[] = [{ id: "stray", status: "DRAFT", builderStep: null, updatedAt: t(2) }];
    expect(decideHirePath(agents)).toEqual({ action: "generate" });
  });

  it("adopts the MOST RECENT draft when an abandoned one exists", () => {
    const agents: Agent[] = [
      { id: "abandoned", status: "DRAFT", builderStep: "chat", updatedAt: t(120) },
      { id: "current", status: "DRAFT", builderStep: "tools", updatedAt: t(1) },
    ];
    expect(decideHirePath(agents)).toEqual({ action: "adopt", agentId: "current" });
  });

  it("prefers a live draft over an unrelated ACTIVE employee", () => {
    const agents: Agent[] = [
      { id: "active", status: "ACTIVE", builderStep: null, updatedAt: t(1) },
      { id: "draft", status: "DRAFT", builderStep: "refine", updatedAt: t(3) },
    ];
    expect(decideHirePath(agents)).toEqual({ action: "adopt", agentId: "draft" });
  });
});
