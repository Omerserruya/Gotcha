import { describe, it, expect } from "vitest";
import { mapResult } from "../services/agent-loop/bot-loop-adapter";
import type { AgentLoopResult } from "../services/agent-loop/agent-loop";

const base = (over: Partial<AgentLoopResult>): AgentLoopResult => ({
  loopId: "loop-1",
  terminationReason: "finish",
  iterations: 1,
  reply: "ok",
  finalDecision: { type: "FINISH", reason: "done" },
  goal: null,
  spentUnits: 100,
  wallMs: 1000,
  workingMemory: { goal: null, establishedFacts: [], ruledOut: [], openQuestions: [], hypotheses: [], iterations: [] },
  memoryUpdate: null,
  ...over,
});

describe("loop result → bot reply mapping (escalation honesty contract)", () => {
  it("stuck terminations raise a REAL escalation (what the customer is told must happen)", () => {
    for (const term of ["failed", "blocked", "max_iterations", "timeout", "budget_exceeded"] as const) {
      const out = mapResult(base({ terminationReason: term }));
      expect(out.escalation, term).not.toBeNull();
      expect(out.escalation!.reason).toContain("kernel");
    }
  });

  it("escalation carries the last observation as diagnostic summary", () => {
    const out = mapResult(
      base({
        terminationReason: "failed",
        workingMemory: {
          goal: null, establishedFacts: [], ruledOut: [], openQuestions: [], hypotheses: [],
          iterations: [
            { iteration: 1, decision: { type: "EXECUTE", operation: "BOOK_MEETING", params: {} }, observation: "BOOK_MEETING → FAILED: no_calendar_available", runtimeResult: "FAILED" },
          ],
        },
      }),
    );
    expect(out.escalation?.summary).toContain("no_calendar_available");
  });

  it("healthy terminations do NOT escalate", () => {
    for (const term of ["finish", "need_input", "converse"] as const) {
      expect(mapResult(base({ terminationReason: term })).escalation, term).toBeNull();
    }
  });

  it("awaiting_approval maps to the approval object with the REAL request id", () => {
    const out = mapResult(
      base({
        terminationReason: "awaiting_approval",
        finalDecision: { type: "EXECUTE", operation: "BOOK_MEETING", params: {} },
        workingMemory: {
          goal: null, establishedFacts: [], ruledOut: [], openQuestions: [], hypotheses: [],
          iterations: [
            { iteration: 1, decision: { type: "EXECUTE", operation: "BOOK_MEETING", params: {} }, observation: "BOOK_MEETING → AWAITING_APPROVAL: awaiting_approval:apr_42", runtimeResult: "AWAITING_APPROVAL" },
          ],
        },
      }),
    );
    expect(out.awaitingApproval).toEqual({ approvalRequestId: "apr_42", tool: "BOOK_MEETING", reason: "awaiting_approval" });
    expect(out.escalation).toBeNull();
  });
});
