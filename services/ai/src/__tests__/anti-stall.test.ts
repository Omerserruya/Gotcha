import { describe, it, expect, afterEach } from "vitest";
import { EMPTY_AGENT_MEMORY, type ReasonerProviderResult } from "@chatcenter/shared";
import { runAgentLoop } from "../services/agent-loop/agent-loop";
import { setReasonerProvider } from "../services/reasoner";
import { clearCapabilities, registerCapability, ensureCapabilitiesRegistered } from "../services/capability-plane";

/** A capability whose only op ALWAYS returns the SAME NEEDS_INPUT - the dead-loop world. */
function stubbornCapability() {
  return {
    name: "STUB",
    ownsOperation: (op: string) => op === "DO_THING",
    async describeWorld() {
      return {
        capability: "STUB",
        summary: "stub world",
        facts: {},
        operations: [{ name: "DO_THING", meaning: "do the thing", params: [] }],
      };
    },
    async execute() {
      return {
        result: { status: "NEEDS_INPUT" as const, field: "email", reason: "an email is required" },
        trace: { operation: "DO_THING", capability: "STUB", mode: "autonomous" as const, invariants: [], optimizations: [], executed: false, result: "NEEDS_INPUT" as const },
      };
    },
  };
}

const baseInputs = {
  tenantId: "t1", conversationId: "c-stall", turnId: "turn1", aiAgentId: "a1",
  customerExternalId: "cust1", mode: "autonomous" as const,
  customer: { id: "cust1", knownFields: {}, identityResolved: true },
  permissions: { allowedOperations: [] },
  transcript: [{ role: "customer" as const, text: "do the thing" }],
  mission: { businessDescription: "stub" },
  goal: null,
  memory: EMPTY_AGENT_MEMORY,
};

afterEach(() => { clearCapabilities(); setReasonerProvider(null); });

describe("anti-stall guard - identical failing outcomes get ruled out", () => {
  it("after 2 identical NEEDS_INPUT outcomes, the op is ruled out and the ruling reaches the Reasoner", async () => {
    ensureCapabilitiesRegistered();
    clearCapabilities();
    registerCapability(stubbornCapability() as any);

    let sawRuledOutAtIteration: number | null = null;
    setReasonerProvider({
      name: "s", model: "s",
      async reason(input): Promise<ReasonerProviderResult> {
        const ruled = input.context.workingMemory?.ruledOut ?? [];
        const iter = input.context.iteration ?? 0;
        if (ruled.some((r) => r.operation === "DO_THING") && sawRuledOutAtIteration === null) {
          sawRuledOutAtIteration = iter;
        }
        // A stubborn reasoner: re-proposes until it SEES the rule-out, then asks.
        const decision = ruled.some((r) => r.operation === "DO_THING")
          ? { type: "REQUEST_INPUT" as const, needed: "email" }
          : { type: "EXECUTE" as const, operation: "DO_THING", params: {} };
        return {
          output: {
            read: { situation: "s", customerState: "c", goal: null, missingInformation: [], rationale: "r" },
            decision, replyIntent: { purpose: "ask", keyPoints: ["What is your email?"] }, memoryUpdate: EMPTY_AGENT_MEMORY,
          },
        };
      },
    });

    const result = await runAgentLoop({ ...baseInputs });

    // 2 identical failing proposals → ruled out → iteration 3's reasoner saw it → asked.
    expect(sawRuledOutAtIteration).toBe(3);
    expect(result.terminationReason).toBe("need_input");
    expect(result.iterations).toBe(3); // NOT max_iterations - the dead-loop was cut short
    const ruledOut = result.workingMemory.ruledOut.find((r) => r.operation === "DO_THING");
    expect(ruledOut?.why).toContain("identical outcome");
  });
});
