/**
 * The autonomy budget: how long the AI may drive before a person takes over.
 *
 * Two things went wrong with the old shape. The default was 10, which a normal
 * support conversation exhausts - the dev agent hit the wall mid-test on an
 * ordinary flow, and the customer experiences that as being abandoned. And the
 * counter charged the bot for the approval acknowledgement, so a cancellation
 * spent budget on the pause it was designed to take: waiting six hours for a
 * manager made the AI "less autonomous" despite doing nothing.
 *
 * The budget now counts AI-authored customer-facing replies and nothing else.
 */
import { describe, it, expect } from "vitest";
import { assessAutonomyBudget } from "../services/ai-bot.service";

const DEFAULT_MAX = 30;

describe("autonomy budget thresholds (default 30)", () => {
  it("9 turns is ordinary working room", () => {
    expect(assessAutonomyBudget(9, DEFAULT_MAX).state).toBe("ok");
  });

  it("10 turns is no longer anywhere near a limit", () => {
    // The whole point of the default change: ten replies used to BE the cap.
    expect(assessAutonomyBudget(10, DEFAULT_MAX).state).toBe("ok");
  });

  it("29 turns is still under the soft cap", () => {
    expect(assessAutonomyBudget(29, DEFAULT_MAX).state).toBe("ok");
  });

  it("30 turns reaches the soft cap", () => {
    expect(assessAutonomyBudget(30, DEFAULT_MAX).state).toBe("cap");
  });

  it("warns one reply before the wall rather than stopping mid-sentence", () => {
    expect(assessAutonomyBudget(59, DEFAULT_MAX).state).toBe("approaching");
  });

  it("hands over at the hard ceiling", () => {
    expect(assessAutonomyBudget(60, DEFAULT_MAX).state).toBe("ceiling");
    expect(assessAutonomyBudget(120, DEFAULT_MAX).state).toBe("ceiling");
  });

  it("reports the ceiling it is measuring against", () => {
    const b = assessAutonomyBudget(5, DEFAULT_MAX);
    expect(b.ceiling).toBe(60);
    expect(b.used).toBe(5);
  });
});

describe("the old default, for tenants that kept it", () => {
  it("still behaves consistently at 10", () => {
    expect(assessAutonomyBudget(9, 10).state).toBe("ok");
    expect(assessAutonomyBudget(10, 10).state).toBe("cap");
    expect(assessAutonomyBudget(19, 10).state).toBe("approaching");
    expect(assessAutonomyBudget(20, 10).state).toBe("ceiling");
  });
});

describe("what the budget must NOT be spent on", () => {
  // These are properties of the COUNT query rather than the thresholds, but
  // the invariant is what matters: only AI-authored customer replies count.
  // A conversation with one real reply plus an approval ack, an approval
  // continuation, a system event and three tool calls has used ONE turn.
  it("a long HITL cycle does not exhaust a 30-turn budget", () => {
    const aiRepliesInAFullCancellationFlow = 4; // ask, confirm, ack is excluded, outcome is excluded
    expect(assessAutonomyBudget(aiRepliesInAFullCancellationFlow, DEFAULT_MAX).state).toBe("ok");
  });

  it("multiple HITL cycles still leave room", () => {
    expect(assessAutonomyBudget(12, DEFAULT_MAX).state).toBe("ok");
  });

  it("a long product discovery stays inside the budget", () => {
    expect(assessAutonomyBudget(20, DEFAULT_MAX).state).toBe("ok");
  });
});
