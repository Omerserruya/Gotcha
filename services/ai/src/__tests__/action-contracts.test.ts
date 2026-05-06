import { describe, it, expect } from "vitest";
import {
  computeBehaviorState,
  deriveTriggeredActions,
  deriveActionContractState,
} from "../services/behavior-engine.service";
import {
  isFulfilled,
  computeNextStepIndex,
  pendingToolsFor,
  type ActionContract,
  type ActionContractProgress,
} from "../services/action-contracts.repo";

const baseIdentity = {
  newLead: { hasContact: true, contactLifecycle: "lead" as const, priorConversationCount: 0 },
};

const REFUND_CONTRACT: ActionContract = {
  id: "ctr_refund",
  tenantId: "tnt_1",
  trigger: "refund",
  requiredTools: [{ name: "refund_payment" }, { name: "create_ticket" }],
  executionMode: "SEQUENCE",
  order: ["refund_payment", "create_ticket"],
  blocking: true,
  isActive: true,
};

const BOOKING_CONTRACT: ActionContract = {
  id: "ctr_booking",
  tenantId: "tnt_1",
  trigger: "booking",
  requiredTools: [{ name: "schedule_meeting" }, { name: "integration_update_lead" }],
  executionMode: "ALL_REQUIRED",
  order: null,
  blocking: true,
  isActive: true,
};

const FOLLOWUP_CONTRACT: ActionContract = {
  id: "ctr_followup",
  tenantId: "tnt_1",
  trigger: "follow_up",
  requiredTools: [{ name: "schedule_followup" }, { name: "integration_add_lead_note" }],
  executionMode: "AT_LEAST_ONE",
  order: null,
  blocking: false,
  isActive: true,
};

describe("ActionContracts — pure helpers", () => {
  it("isFulfilled — ALL_REQUIRED needs every tool", () => {
    expect(isFulfilled(BOOKING_CONTRACT, ["schedule_meeting"])).toBe(false);
    expect(isFulfilled(BOOKING_CONTRACT, ["schedule_meeting", "integration_update_lead"])).toBe(true);
  });
  it("isFulfilled — AT_LEAST_ONE needs any tool", () => {
    expect(isFulfilled(FOLLOWUP_CONTRACT, [])).toBe(false);
    expect(isFulfilled(FOLLOWUP_CONTRACT, ["schedule_followup"])).toBe(true);
  });
  it("isFulfilled — SEQUENCE needs every tool (order checked elsewhere)", () => {
    expect(isFulfilled(REFUND_CONTRACT, ["refund_payment"])).toBe(false);
    expect(isFulfilled(REFUND_CONTRACT, ["refund_payment", "create_ticket"])).toBe(true);
  });
  it("computeNextStepIndex — SEQUENCE advances per completed step", () => {
    expect(computeNextStepIndex(REFUND_CONTRACT, [])).toBe(0);
    expect(computeNextStepIndex(REFUND_CONTRACT, ["refund_payment"])).toBe(1);
    expect(computeNextStepIndex(REFUND_CONTRACT, ["refund_payment", "create_ticket"])).toBe(2);
  });
  it("pendingToolsFor — SEQUENCE returns only the next step", () => {
    expect(pendingToolsFor(REFUND_CONTRACT, [])).toEqual(["refund_payment"]);
    expect(pendingToolsFor(REFUND_CONTRACT, ["refund_payment"])).toEqual(["create_ticket"]);
    expect(pendingToolsFor(REFUND_CONTRACT, ["refund_payment", "create_ticket"])).toEqual([]);
  });
  it("pendingToolsFor — ALL_REQUIRED returns every unfulfilled tool", () => {
    expect(pendingToolsFor(BOOKING_CONTRACT, [])).toEqual(["schedule_meeting", "integration_update_lead"]);
    expect(pendingToolsFor(BOOKING_CONTRACT, ["schedule_meeting"])).toEqual(["integration_update_lead"]);
  });
});

describe("ActionContracts — deriveTriggeredActions", () => {
  it("detects refund from English markers", () => {
    expect(deriveTriggeredActions({ lastMessage: "i want a refund please" })).toContain("refund");
  });
  it("detects refund from Hebrew markers", () => {
    expect(deriveTriggeredActions({ lastMessage: "אני רוצה החזר כספי" })).toContain("refund");
  });
  it("detects booking from booking markers", () => {
    expect(deriveTriggeredActions({ lastMessage: "let's book a discovery call" })).toContain("booking");
  });
  it("detects booking from transactional intent even without keyword", () => {
    expect(deriveTriggeredActions({ lastMessage: "i'd like to start", intent: "transactional" })).toContain("booking");
  });
  it("close_conversation derived from BEL closure posture", () => {
    expect(deriveTriggeredActions({ lastMessage: "thanks", closurePosture: "ready_to_close" })).toContain("close_conversation");
  });
  it("follow_up derived from defer markers OR closure posture", () => {
    expect(deriveTriggeredActions({ lastMessage: "let me think about it" })).toContain("follow_up");
    expect(deriveTriggeredActions({ lastMessage: "ok", closurePosture: "needs_followup" })).toContain("follow_up");
  });
});

describe("ActionContracts — deriveActionContractState", () => {
  it("inactive when no contracts match", () => {
    const s = deriveActionContractState({
      triggeredActions: ["booking"],
      contracts: [],
      progressByContract: new Map(),
    });
    expect(s.active).toBe(false);
    expect(s.contracts).toEqual([]);
  });

  it("active + blocking when one matching contract has pending tools", () => {
    const s = deriveActionContractState({
      triggeredActions: ["booking"],
      contracts: [BOOKING_CONTRACT],
      progressByContract: new Map(),
    });
    expect(s.active).toBe(true);
    expect(s.blocking).toBe(true);
    expect(s.pendingTools).toEqual(["schedule_meeting", "integration_update_lead"]);
  });

  it("SEQUENCE — pendingTools is just the next step (not the full list)", () => {
    const s = deriveActionContractState({
      triggeredActions: ["refund"],
      contracts: [REFUND_CONTRACT],
      progressByContract: new Map(),
    });
    expect(s.pendingTools).toEqual(["refund_payment"]);
    expect(s.currentStep).toBe("refund_payment");
  });

  it("SEQUENCE — partial completion advances to step 2", () => {
    const progress = new Map<string, ActionContractProgress>([
      [REFUND_CONTRACT.id, {
        id: "p1", contractId: REFUND_CONTRACT.id, conversationId: "c1",
        completedTools: ["refund_payment"], nextStepIndex: 1, pausedReason: null, fulfilledAt: null,
      }],
    ]);
    const s = deriveActionContractState({
      triggeredActions: ["refund"],
      contracts: [REFUND_CONTRACT],
      progressByContract: progress,
    });
    expect(s.completedTools).toEqual(["refund_payment"]);
    expect(s.pendingTools).toEqual(["create_ticket"]);
    expect(s.currentStep).toBe("create_ticket");
  });

  it("SEQUENCE — out-of-order proposed tool calls flag a violation", () => {
    const s = deriveActionContractState({
      triggeredActions: ["refund"],
      contracts: [REFUND_CONTRACT],
      progressByContract: new Map(),
      proposedToolCalls: ["create_ticket"], // step 2 attempted before step 1
    });
    expect(s.violatedThisTurn?.contractTrigger).toBe("refund");
    expect(s.violatedThisTurn?.reason).toContain("expected_refund_payment");
    expect(s.violatedThisTurn?.reason).toContain("got_create_ticket");
  });

  it("inactive once contract is fulfilled (per progress.fulfilledAt)", () => {
    const progress = new Map<string, ActionContractProgress>([
      [BOOKING_CONTRACT.id, {
        id: "p2", contractId: BOOKING_CONTRACT.id, conversationId: "c1",
        completedTools: ["schedule_meeting", "integration_update_lead"],
        nextStepIndex: 2, pausedReason: null, fulfilledAt: new Date(),
      }],
    ]);
    const s = deriveActionContractState({
      triggeredActions: ["booking"],
      contracts: [BOOKING_CONTRACT],
      progressByContract: progress,
    });
    expect(s.active).toBe(false);
    expect(s.pendingTools).toEqual([]);
  });

  it("AT_LEAST_ONE non-blocking — not blocking even with pending tools", () => {
    const s = deriveActionContractState({
      triggeredActions: ["follow_up"],
      contracts: [FOLLOWUP_CONTRACT],
      progressByContract: new Map(),
    });
    expect(s.active).toBe(true);
    expect(s.blocking).toBe(false);
    expect(s.pendingTools.sort()).toEqual(["integration_add_lead_note", "schedule_followup"].sort());
  });
});

describe("BEL — computeBehaviorState integration", () => {
  it("threads actionContractState into BehaviorState when booking matches", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "i want to book a discovery call", messageCount: 3 },
      actionContracts: [BOOKING_CONTRACT],
      actionContractProgress: new Map(),
    });
    expect(s.actionContractState.active).toBe(true);
    expect(s.actionContractState.blocking).toBe(true);
    expect(s.actionContractState.pendingTools).toContain("schedule_meeting");
    expect(s.provenance.overrides.some((o) => o.includes("action_contract.active"))).toBe(true);
  });

  it("inert when no matching trigger", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "tell me about your product", messageCount: 3 },
      actionContracts: [BOOKING_CONTRACT, REFUND_CONTRACT],
      actionContractProgress: new Map(),
    });
    expect(s.actionContractState.active).toBe(false);
  });

  it("multi-turn — partial progress is honored", () => {
    const progress = new Map<string, ActionContractProgress>([
      [REFUND_CONTRACT.id, {
        id: "p3", contractId: REFUND_CONTRACT.id, conversationId: "c1",
        completedTools: ["refund_payment"], nextStepIndex: 1, pausedReason: null, fulfilledAt: null,
      }],
    ]);
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "i still need that refund processed", messageCount: 5 },
      actionContracts: [REFUND_CONTRACT],
      actionContractProgress: progress,
    });
    expect(s.actionContractState.active).toBe(true);
    expect(s.actionContractState.completedTools).toContain("refund_payment");
    expect(s.actionContractState.pendingTools).toEqual(["create_ticket"]);
  });

  it("LLM-tries-to-skip — proposedToolCalls=create_ticket BEFORE refund_payment → violation flagged", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "i want a refund", messageCount: 3 },
      actionContracts: [REFUND_CONTRACT],
      actionContractProgress: new Map(),
      proposedToolCalls: ["create_ticket"],
    });
    expect(s.actionContractState.violatedThisTurn).toBeTruthy();
    expect(s.actionContractState.violatedThisTurn?.reason).toContain("expected_refund_payment");
  });
});
