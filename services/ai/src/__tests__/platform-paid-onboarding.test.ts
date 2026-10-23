/**
 * Onboarding AI is paid by the platform (Omer, 2026-10-23).
 *
 * A tenant setting up has no plan or no credits. Its site scan must not hit
 * the credit gate (a 402 failed the scan) and must not be debited from the
 * customer - but every call is still logged. Everything else keeps the gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ gateCalls: 0, metered: 0, logged: [] as any[] }));

vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: async () => ({
          choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      },
    };
    embeddings = { create: async () => ({ data: [] }) };
  },
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    // A 0-credit tenant in hard enforcement: the gate refuses.
    assertAiAllowed: async (tenantId: string) => {
      H.gateCalls++;
      throw Object.assign(new Error("units_exhausted"), { name: "AiUnitsExhaustedError", tenantId });
    },
    meterAiUnits: async () => { H.metered++; return null; },
    trackAIUsage: async (event: any) => { H.logged.push(event); },
  };
});

import { initAIService, generateResponse, PLATFORM_PAID_AI_TYPES } from "../services/ai.service";

beforeEach(() => {
  H.gateCalls = 0; H.metered = 0; H.logged = [];
  initAIService({ apiKey: "test", defaultModel: "gpt-test" });
});

const call = (type: string) =>
  generateResponse({ tenantId: "T0", model: "gpt-test", messages: [{ role: "user", content: "hi" }] as any, metadata: { type } });

describe("a tenant with 0 credits", () => {
  for (const type of PLATFORM_PAID_AI_TYPES) {
    it(`${type}: answered, logged as billedTo platform, never gated or debited`, async () => {
      const r = await call(type);
      expect(r.content).toBe("{}");
      expect(H.gateCalls).toBe(0);
      await new Promise((r) => setTimeout(r, 0));
      expect(H.metered).toBe(0);
      expect(H.logged).toEqual([expect.objectContaining({ tenantId: "T0", feature: type, metadata: expect.objectContaining({ billedTo: "platform" }) })]);
    });
  }

  it("any other call is still gated - the exemption is an exact list, not a prefix", async () => {
    await expect(call("chat")).rejects.toThrow("units_exhausted");
    await expect(call("onboarding_something_new")).rejects.toThrow("units_exhausted");
    expect(H.gateCalls).toBe(2);
  });
});
