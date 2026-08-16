import { describe, it, expect } from "vitest";
import { isAiManaged, isFlowManaged } from "../conversation-ownership";

/**
 * One predicate decides two things that must agree: which inbox section a
 * conversation files under, and whether opening it may pop the co-pilot. Every
 * false positive here is an agent skipping a conversation that was theirs;
 * every false negative is a co-pilot drafting over a reply already on its way.
 */

const AI_OWNED = { handledBy: "ai_agent", isHandedOver: false, assignedAgentId: null };

describe("isAiManaged", () => {
  it("is true only when an automation owns it and no human has taken it", () => {
    expect(isAiManaged(AI_OWNED)).toBe(true);
    expect(isAiManaged({ ...AI_OWNED, handledBy: "flow" })).toBe(true);
  });

  it("is false once a human takes over, by either signal", () => {
    // isHandedOver is the latch escalation sets; assignedAgentId catches a
    // claim that never flipped it. Either one alone means hands off.
    expect(isAiManaged({ ...AI_OWNED, isHandedOver: true })).toBe(false);
    expect(isAiManaged({ ...AI_OWNED, assignedAgentId: "u1" })).toBe(false);
  });

  it("is false for a conversation nothing is driving", () => {
    // handledBy null = unrouted. It belongs in the waiting queue, where a
    // human is genuinely expected to pick it up.
    expect(isAiManaged({ handledBy: null, isHandedOver: false, assignedAgentId: null })).toBe(false);
    expect(isAiManaged({ handledBy: "human", isHandedOver: false, assignedAgentId: null })).toBe(false);
  });

  it("is false for awaiting_approval - a human is the blocker there", () => {
    expect(isAiManaged({ ...AI_OWNED, handledBy: "awaiting_approval" })).toBe(false);
  });

  it("survives a missing or partial conversation", () => {
    expect(isAiManaged(null)).toBe(false);
    expect(isAiManaged(undefined)).toBe(false);
    expect(isAiManaged({})).toBe(false);
  });
});

describe("isFlowManaged", () => {
  it("separates an authored flow from an AI employee", () => {
    expect(isFlowManaged({ ...AI_OWNED, handledBy: "flow" })).toBe(true);
    expect(isFlowManaged(AI_OWNED)).toBe(false);
  });

  it("is never true for a conversation a human owns", () => {
    expect(isFlowManaged({ ...AI_OWNED, handledBy: "flow", assignedAgentId: "u1" })).toBe(false);
  });
});
