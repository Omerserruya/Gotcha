import { describe, it, expect } from "vitest";
import { buildToolRulesBlock } from "../services/tool-rules";

describe("buildToolRulesBlock — capability-conditional tool rules", () => {
  it("bookable calendar → injects the two-tool 'check then book' rules", () => {
    const block = buildToolRulesBlock({ calendarBookable: true })!;
    expect(block).toContain("Tool Rules");
    // Both calendar tools are named, with their read/write split.
    expect(block).toContain("check_availability");
    expect(block).toContain("schedule_meeting");
    expect(block).toMatch(/source of truth/i);
    // The omer guardrails — never invent/state availability without the tool.
    expect(block).toMatch(/never invent a time/i);
    expect(block).toMatch(/needsAvailabilityCheck/);
    expect(block).toMatch(/pass it to the team/i);
  });

  it("not bookable / unknown → no calendar tool rule (boundary block covers that)", () => {
    expect(buildToolRulesBlock({ calendarBookable: false })).toBeNull();
    expect(buildToolRulesBlock({})).toBeNull();
  });
});
