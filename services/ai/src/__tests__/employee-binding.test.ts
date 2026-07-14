import { describe, it, expect } from "vitest";
import { buildEmployeeBinding } from "../services/agent-loop/bot-loop-adapter";

const RICH_AGENT = {
  name: "דניאל",
  role: "sales",
  goal: "Convert leads into booked demos",
  successCriteria: "A demo is booked with a qualified lead",
  tone: "friendly",
  toneConfig: { formalityLevel: "casual", empathyLevel: "high" },
  salesContext: {
    whatWeSell: "AI employees for SMBs",
    idealCustomerProfile: "SMBs with inbound WhatsApp traffic",
    disqualifiers: ["students", "no business"],
  },
  behavioral: {
    forbiddenActions: ["never promise discounts", "never share internal pricing"],
    safetyBoundaries: ["no medical advice"],
  },
  customGuardrails: ["always answer in the customer's language"],
  behavioralAnchors: [{ condition: "customer is angry", guidance: "acknowledge before solving" }],
};

describe("employee binding - AIAgent row → kernel mission/guidance/persona", () => {
  it("maps a rich agent row into all three slots", () => {
    const b = buildEmployeeBinding(RICH_AGENT);
    // mission: who + goal + product + ICP + disqualifiers
    expect(b.mission.businessDescription).toContain("דניאל");
    expect(b.mission.businessDescription).toContain("sales");
    expect(b.mission.businessDescription).toContain("Convert leads");
    expect(b.mission.businessDescription).toContain("AI employees for SMBs");
    expect(b.mission.disqualifiers).toEqual(["students", "no business"]);
    // guidance: policies as playbook text
    expect(b.guidance).toContain("Never do: never promise discounts");
    expect(b.guidance).toContain("Safety boundary: no medical advice");
    expect(b.guidance).toContain("Guardrail: always answer in the customer's language");
    expect(b.guidance).toContain("When customer is angry: acknowledge before solving");
    expect(b.guidance).toContain("Success looks like: A demo is booked");
    // persona: voice only
    expect(b.persona?.displayName).toBe("דניאל");
    expect(b.persona?.voice).toContain("friendly");
    expect(b.persona?.doNots).toContain("never promise discounts");
  });

  it("is fail-soft: bare/absent agent yields a minimal binding", () => {
    expect(buildEmployeeBinding(null)).toEqual({ mission: {} });
    const b = buildEmployeeBinding({ name: "Bot" });
    expect(b.mission.businessDescription).toContain("Bot");
    expect(b.guidance).toBeUndefined();
  });

  it("ignores malformed JSON blobs instead of throwing", () => {
    const b = buildEmployeeBinding({
      name: "X",
      salesContext: "not-an-object",
      behavioral: 42,
      behavioralAnchors: "nope",
      customGuardrails: [null, 7, "  real one  "],
    });
    expect(b.guidance).toBe("Guardrail: real one");
  });

  it("is deterministic (byte-stable) for the same agent row - cache-safe", () => {
    const a = buildEmployeeBinding(RICH_AGENT);
    const b = buildEmployeeBinding(RICH_AGENT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
