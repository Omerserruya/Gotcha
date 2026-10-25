import { describe, it, expect, vi } from "vitest";
import { buildAgentPrompt, type AgentRecord } from "../services/prompt-builder.service";
import { computeBehaviorState } from "../services/behavior-engine.service";

/**
 * Product facts come only from a tool (2026-10-25, Omer's rule).
 *
 * Noa (omer-onb-2) named Black, Navy, Oat and Camel for a coat the store sells
 * only in Beige. No catalogue tool was offered that turn (fixed by d5be69fb),
 * and nothing in the prompt stopped her naming product attributes anyway. The
 * rule: never a size, colour, price or stock without a tool result from this
 * turn or this conversation. It sits in the final self-review, for every mode
 * that reviews, and its Hebrew example does not fix the employee's gender.
 */

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  prisma: {},
  grammaticalAddressPromptBlock: () => null,
}));

const NOA: AgentRecord = {
  name: "Noa",
  role: "customer_support",
  tone: "friendly",
  style: {},
  identity: { company: "Noa's shop", description: "Online clothing store." },
  goals: {},
  toneConfig: {},
  behavioral: {},
  persona: { brand_archetype: "high_energy_coach", grammaticalGender: "feminine" },
  conversationFlow: null,
  customGuardrails: null,
  escalationRules: null,
  behavioralAnchors: null,
} as AgentRecord;

const promptFor = (mode: "agent" | "generator", tools: string[]) => buildAgentPrompt({
  behaviorState: computeBehaviorState({
    mode,
    identity: { hasContact: false, contactLifecycle: null, priorConversationCount: 0 },
    request: { lastMessage: "באילו צבעים יש את המעיל?", messageCount: 1, recentInboundTexts: ["באילו צבעים יש את המעיל?"] },
  }),
  agent: NOA,
  context: { customerBlock: "## Customer\n- Channel: webchat", locale: "he" },
  knowledge: {},
  toolFunctionNames: tools,
} as any);

describe("★ size, colour, price and stock only from a tool result", () => {
  // No product tool: the case that produced the invented colours.
  const prompt = promptFor("agent", ["escalate_to_human"]);

  it("states the rule, with all four facts and both scopes", () => {
    expect(prompt).toMatch(/Product facts come only from a tool/);
    expect(prompt).toMatch(/size, colour, price or stock/);
    expect(prompt).toMatch(/tool result from THIS turn or earlier in THIS conversation/);
  });

  it("says what to do without a tool, or when the result lacks the detail", () => {
    expect(prompt).toMatch(/If you have none, or its result does not show that detail/);
    expect(prompt).toMatch(/never fill the gap with a guess/);
  });

  it("names the wrong move with the colours Noa invented", () => {
    expect(prompt).toContain("יש אותו בשחור, בנייבי ובקאמל");
  });

  it("its Hebrew example does not fix the employee's gender", () => {
    const rule = prompt.slice(prompt.indexOf("Product facts come only from a tool"));
    const line = rule.slice(0, rule.indexOf("\n"));
    expect(line).not.toMatch(/יכולה|יכול\b|בודקת|בודק\b/);
  });

  it("is part of the final self-review", () => {
    const review = prompt.slice(prompt.indexOf("# Response Quality Contract"));
    expect(review).toMatch(/Product facts come only from a tool/);
  });
});
