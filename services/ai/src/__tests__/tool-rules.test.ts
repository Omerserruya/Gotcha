import { describe, it, expect } from "vitest";
import { buildToolRulesBlock } from "../services/tool-rules";

describe("buildToolRulesBlock — capability-conditional tool rules", () => {
  it("bookable calendar → injects the hard 'verify before you claim' rule", () => {
    const block = buildToolRulesBlock({ calendarBookable: true })!;
    expect(block).toContain("Tool Rules");
    expect(block).toContain("schedule_meeting");
    // The omer guardrails — never invent/agree/check without the tool.
    expect(block).toMatch(/NEVER say a time is free/i);
    expect(block).toMatch(/NEVER agree to or confirm a time/i);
    expect(block).toMatch(/I'?ll check/i);
    expect(block).toMatch(/pass it to the team/i);
  });

  it("not bookable / unknown → no calendar tool rule (boundary block covers that)", () => {
    expect(buildToolRulesBlock({ calendarBookable: false })).toBeNull();
    expect(buildToolRulesBlock({})).toBeNull();
  });
});
