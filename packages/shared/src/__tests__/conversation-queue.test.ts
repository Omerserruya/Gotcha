/**
 * ★ "Waiting for a person": the one definition Home, the queue, the inbox's
 * queue view and the assistant share. Pinned here so it is changed on purpose.
 */
import { describe, it, expect } from "vitest";
import { waitingForPersonClause, waitingForPersonWhere } from "../lib/conversation-queue";

describe("★ waitingForPersonClause", () => {
  it("open, unassigned, not a rehearsal (isTest AND the sandbox prefix), not AI/flow unless handed over", () => {
    expect(waitingForPersonClause()).toEqual({
      isTest: false,
      NOT: { customerExternalId: { startsWith: "sandbox:" } },
      status: { in: ["OPEN", "WAITING"] },
      assignedAgentId: null,
      AND: [{ OR: [{ handledBy: null }, { handledBy: "human" }, { isHandedOver: true }] }],
    });
  });

  it("its OR is nested, so a caller's own top-level OR (visibility) is never overwritten", () => {
    expect(waitingForPersonClause()).not.toHaveProperty("OR");
    expect(waitingForPersonWhere("T")).toMatchObject({ tenantId: "T", isTest: false });
  });
});
