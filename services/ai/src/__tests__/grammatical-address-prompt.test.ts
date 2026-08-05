import { describe, it, expect } from "vitest";
import { buildAgentPrompt, type AgentRecord } from "../services/prompt-builder.service";
import { computeBehaviorState } from "../services/behavior-engine.service";
import type { GrammaticalAddress } from "@chatcenter/shared";

const AGENT: AgentRecord = {
  name: "Maya",
  role: "customer_support",
  tone: "friendly",
  style: {},
  identity: { company: "Urban Supply", description: "Online store." },
  goals: {},
  toneConfig: {},
  behavioral: {},
  persona: { brand_archetype: "high_energy_coach", grammaticalGender: "feminine" },
  conversationFlow: null,
  customGuardrails: null,
  escalationRules: null,
  behavioralAnchors: null,
} as AgentRecord;

function prompt(grammaticalAddress?: GrammaticalAddress, locale?: string): string {
  const behaviorState = computeBehaviorState({
    mode: "agent",
    identity: { hasContact: true, contactLifecycle: null, priorConversationCount: 0 },
    request: {
      lastMessage: "אני מחפשת נעליים",
      messageCount: 3,
      recentInboundTexts: ["אני מחפשת נעליים"],
    },
  });
  return buildAgentPrompt({
    behaviorState,
    agent: AGENT,
    context: { customerBlock: "## Customer\n- Channel: whatsapp", locale, grammaticalAddress },
    knowledge: {},
    toolFunctionNames: ["escalate_to_human"],
  });
}

describe("the address block reaches the model", () => {
  it("states an explicit feminine form", () => {
    const p = prompt({ form: "feminine", confidence: "explicit", language: "he" });
    expect(p).toContain("Addressing the customer (grammatical form)");
    expect(p).toContain("feminine");
  });

  it("states an explicit masculine form", () => {
    const p = prompt({ form: "masculine", confidence: "explicit", language: "he" });
    expect(p).toContain("masculine");
  });

  it("asks for restructured neutral phrasing when nothing is known", () => {
    const p = prompt({ form: "unknown", confidence: "unknown", language: "he" });
    expect(p).toContain("Addressing the customer (grammatical form)");
    expect(p).toContain("RESTRUCTURING");
    expect(p).toContain("איזה מוצר מעניין אותך?");
  });

  it("carries no evidence with it", () => {
    const p = prompt({
      form: "feminine",
      confidence: "explicit",
      sourceMessageId: "msg_abc123",
      language: "he",
    });
    expect(p).not.toContain("msg_abc123");
  });

  it("is absent for a language with no evidence table", () => {
    const p = prompt({ form: "unknown", confidence: "unknown", language: "en" }, "en");
    expect(p).not.toContain("Addressing the customer (grammatical form)");
  });

  it("is absent when no address state was supplied at all", () => {
    expect(prompt(undefined, "en")).not.toContain("Addressing the customer (grammatical form)");
  });
});

describe("the Quality Contract no longer licenses guessing", () => {
  const p = prompt({ form: "unknown", confidence: "unknown", language: "he" });

  it("does not tell the model to use contact data as a hint", () => {
    // The exact instruction that used to be here: "then contact data as a
    // WEAK hint only". It is the reason this test exists.
    expect(p).not.toMatch(/contact data as a WEAK hint/i);
  });

  it("forbids every signal the spec forbids", () => {
    expect(p).toMatch(
      /NEVER infer it from a name, a phone number, an email address, an avatar, a voice, an address, a purchased product or a product category/,
    );
  });

  it("names the third-person trap explicitly", () => {
    expect(p).toContain("הבת שלי מחפשת שמלה");
  });

  it("still forbids slash forms", () => {
    expect(p).toContain("Slash forms are FORBIDDEN");
  });

  it("still forbids asking", () => {
    expect(p).toContain("Never ask.");
  });
});
