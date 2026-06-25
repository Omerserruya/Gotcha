/**
 * Unit tests for the Wizard→Runtime judgment step. The LLM call is mocked; we
 * verify the STRUCTURAL guarantees: skip-when-no-config, normalization, strict
 * whitelisting of the model's output to configured/allowed values, and fail-safe.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/ai.service", () => ({
  getDefaultModel: () => "gpt-5-mini",
  generateResponse: vi.fn(),
}));

import { evaluateWizardBinding } from "../services/wizard-binding.service";
import { generateResponse } from "../services/ai.service";

const agent = {
  tenantId: "t1",
  conversationId: "c1",
  role: "sales",
  goal: "Book product demos with qualified prospects",
  salesContext: {
    qualificationSignals: ["has an online store"],
    disqualifiers: ["offline only, no digital channels"],
    idealCustomerProfile: "online retailers",
  },
  transcript: "Customer: we sell jewelry online and get tons of DMs",
};

beforeEach(() => (generateResponse as any).mockReset());

describe("wizard-binding: single judgment step → structured facts", () => {
  it("skips the LLM call entirely when there is no bindable config", async () => {
    const r = await evaluateWizardBinding({
      tenantId: "t", conversationId: "c", role: "sales", goal: null, salesContext: null, transcript: "hi",
    });
    expect(r.evaluated).toBe(false);
    expect(generateResponse).not.toHaveBeenCalled();
  });

  it("normalizes a valid verdict into typed facts", async () => {
    (generateResponse as any).mockResolvedValueOnce({
      content: JSON.stringify({
        fit: "qualified", disqualifierMatched: null, qualificationMet: true,
        signalsMet: ["has an online store"], goalObjective: "BOOK_MEETING",
      }),
      usage: { total_tokens: 10 },
    });
    const r = await evaluateWizardBinding(agent);
    expect(r).toMatchObject({
      evaluated: true, fit: "qualified", qualificationMet: true,
      signalsMet: ["has an online store"], goalObjective: "BOOK_MEETING",
    });
  });

  it("WHITELISTS the model output: hallucinated objective / unconfigured values are rejected", async () => {
    (generateResponse as any).mockResolvedValueOnce({
      content: JSON.stringify({
        fit: "disqualified", disqualifierMatched: "made-up reason", qualificationMet: true,
        signalsMet: ["invented signal"], goalObjective: "WORLD_DOMINATION",
      }),
      usage: { total_tokens: 10 },
    });
    const r = await evaluateWizardBinding(agent);
    expect(r.goalObjective).toBeNull();        // not in the role's chain → rejected
    expect(r.disqualifierMatched).toBeNull();  // not a configured disqualifier → rejected
    expect(r.fit).toBe("neutral");             // "disqualified" without a real match → downgraded
    expect(r.signalsMet).toEqual([]);          // not a configured signal → dropped
  });

  it("only gates readiness when signals are configured (qualificationMet defaults true otherwise)", async () => {
    (generateResponse as any).mockResolvedValueOnce({
      content: JSON.stringify({ fit: "neutral", qualificationMet: false, goalObjective: null }),
      usage: { total_tokens: 5 },
    });
    const r = await evaluateWizardBinding({
      ...agent,
      salesContext: { idealCustomerProfile: "online retailers" }, // no qualificationSignals
    });
    expect(r.qualificationMet).toBe(true); // no signals configured → never gate
  });

  it("fail-safe: malformed model output → EMPTY facts (evaluated:false), engine unaffected", async () => {
    (generateResponse as any).mockResolvedValueOnce({ content: "this is not json", usage: { total_tokens: 1 } });
    const r = await evaluateWizardBinding(agent);
    expect(r.evaluated).toBe(false);
    expect(r.fit).toBe("neutral");
  });
});
