import { describe, it, expect, beforeEach } from "vitest";
import { GoalStateMachine } from "../services/intelligence/goal-state-machine";

describe("GoalStateMachine", () => {
  let sm: GoalStateMachine;
  const cid = "conv-1";

  beforeEach(() => {
    sm = new GoalStateMachine();
  });

  it("starts at lookup_lead", () => {
    expect(sm.current(cid)).toBe("lookup_lead");
  });

  it("does not advance when required fields are missing", () => {
    expect(sm.advance(cid, {})).toBe("lookup_lead");
    expect(sm.advance(cid, { fullName: "Alice" })).toBe("lookup_lead");
  });

  it("advances to qualify when lookup_lead fields filled", () => {
    expect(sm.advance(cid, { fullName: "Alice", email: "a@x.com" })).toBe("qualify");
  });

  it("advances multiple stages in one call when fields allow", () => {
    expect(
      sm.advance(cid, {
        fullName: "A",
        email: "a@x.com",
        company: "X",
        companySize: "50",
        painPoint: "slow",
        budget: "10k",
      }),
    ).toBe("propose");
  });

  it("never regresses", () => {
    sm.advance(cid, { fullName: "A", email: "a@x.com" });
    expect(sm.current(cid)).toBe("qualify");
    // Lead state "loses" name (e.g. CRM glitch) — must not drop back.
    expect(sm.advance(cid, {})).toBe("qualify");
  });

  it("reset returns to lookup_lead", () => {
    sm.advance(cid, { fullName: "A", email: "a@x.com" });
    sm.reset(cid);
    expect(sm.current(cid)).toBe("lookup_lead");
  });

  it("isolates state per conversation", () => {
    sm.advance("conv-a", { fullName: "A", email: "a@x.com" });
    expect(sm.current("conv-b")).toBe("lookup_lead");
  });
});
