/**
 * "Says it's AI when asked" (A3b, Omer 2026-10-13): persona.disclosesAi, on
 * unless set to false. Either way the employee never claims to be a person;
 * off only means it does not bring it up itself.
 */
import { describe, it, expect } from "vitest";
import { buildAgentPrompt, type AgentRecord } from "../services/prompt-builder.service";
import { computeBehaviorState } from "../services/behavior-engine.service";

const agent = (persona: Record<string, unknown>): AgentRecord => ({
  name: "Maya", role: "customer_support", tone: "friendly", style: {}, identity: { company: "Urban Supply" }, goals: {},
  toneConfig: {}, behavioral: {}, persona, conversationFlow: null, customGuardrails: null, escalationRules: null, behavioralAnchors: null,
} as AgentRecord);

const prompt = (persona: Record<string, unknown>) => buildAgentPrompt({
  behaviorState: computeBehaviorState({
    mode: "agent",
    identity: { hasContact: true, contactLifecycle: null, priorConversationCount: 0 },
    request: { lastMessage: "אתה בוט?", messageCount: 2, recentInboundTexts: ["אתה בוט?"] },
  }),
  agent: agent(persona),
  context: { customerBlock: "## Customer\n- Channel: whatsapp" },
  knowledge: {},
  toolFunctionNames: ["escalate_to_human"],
});

describe("Being an AI", () => {
  it("★ by default the employee says plainly that it is an AI when asked", () => {
    const p = prompt({});
    expect(p).toContain("## Being an AI");
    expect(p).toContain("say plainly that you are an AI assistant");
  });

  it("★ set off: it does not bring it up, and still never claims to be human", () => {
    const p = prompt({ disclosesAi: false });
    expect(p).toContain("Do not bring up that you are an AI on your own");
    expect(p).toContain("never claim to be human");
    expect(p).not.toContain("say plainly that you are an AI assistant");
  });

  it("the absolute rule never allows claiming to be a person", () => {
    const p = prompt({ disclosesAi: false });
    expect(p).toContain("**Never** claim to be a human");
    expect(p).not.toContain("unless configured otherwise");
  });
});
