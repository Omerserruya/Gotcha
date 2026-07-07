import { describe, it, expect } from "vitest";
import { boundAgentMemory } from "../services/agent-loop/memory-store";
import { EMPTY_AGENT_MEMORY } from "@chatcenter/shared";

describe("agent memory bounding (pure)", () => {
  it("dedups, trims, and caps every list", () => {
    const m = boundAgentMemory({
      committedGoal: "booking",
      workingHypotheses: Array.from({ length: 30 }, (_, i) => `h${i}`),
      alreadyAsked: [" email ", "email", "", "phone"],
      priorReads: Array.from({ length: 20 }, (_, i) => ({ turn: i, situation: `s${i}` })),
      openCommitments: ["follow up Tuesday"],
    });
    expect(m.workingHypotheses.length).toBe(12); // cap
    expect(m.workingHypotheses[11]).toBe("h29"); // rolling window keeps latest
    expect(m.alreadyAsked).toEqual(["email", "phone"]); // dedup + trim + drop empty
    expect(m.priorReads.length).toBe(8);
    expect(m.priorReads[7].situation).toBe("s19");
    expect(m.committedGoal).toBe("booking");
  });

  it("tolerates partial/malformed input", () => {
    const m = boundAgentMemory({ ...EMPTY_AGENT_MEMORY, priorReads: [null as any, { turn: 1, situation: "ok" }] });
    expect(m.priorReads).toEqual([{ turn: 1, situation: "ok" }]);
  });
});
