import { describe, it, expect } from "vitest";
import { buildAgentPrompt, stablePrefixOf, type AgentRecord } from "../services/prompt-builder.service";
import { computeBehaviorState } from "../services/behavior-engine.service";

// A fixed agent + fixed conversation context. The ONLY thing that varies between
// the two prompts below is the BehaviorState (strategy / intent / stage / urgency),
// which must affect ONLY the per-turn block - never the cacheable stable prefix.
const AGENT: AgentRecord = {
  name: "Aria",
  role: "sales",
  tone: "friendly",
  style: { concise: true },
  identity: { company: "Acme", description: "We sell widgets." },
  goals: { primary: "qualify and book demos" },
  toneConfig: {},
  behavioral: {},
  persona: { brand_archetype: "sage" },
  conversationFlow: null,
  customGuardrails: null,
  escalationRules: null,
  behavioralAnchors: null,
};

const CONTEXT = {
  customerBlock: "## Customer\n- Name: Dana\n- Channel: whatsapp",
  locale: "en",
};

function promptFor(lastMessage: string, messageCount: number): string {
  const behaviorState = computeBehaviorState({
    mode: "agent",
    identity: { hasContact: true, contactLifecycle: null, priorConversationCount: 0 },
    request: { lastMessage, messageCount, recentInboundTexts: [lastMessage] },
  });
  return buildAgentPrompt({
    behaviorState,
    agent: AGENT,
    context: CONTEXT,
    knowledge: {},
    toolFunctionNames: ["escalate_to_human"],
  } as any);
}

describe("prompt cache prefix stability", () => {
  // Two very different turns: early support gripe vs late buying signal. These
  // drive different strategy / intent / stage / urgency in the per-turn block.
  const a = promptFor("my login is broken, i can't get in", 4);
  const b = promptFor("ok this looks great, let's book a demo and sign up", 6);

  it("produces DIFFERENT full prompts (the per-turn block reacts to behavior)", () => {
    expect(a).not.toEqual(b);
  });

  it("produces a BYTE-IDENTICAL stable prefix (cache is not broken by behavior)", () => {
    expect(stablePrefixOf(a)).toEqual(stablePrefixOf(b));
  });

  it("the stable prefix is a real prefix of the full prompt", () => {
    expect(a.startsWith(stablePrefixOf(a))).toBe(true);
  });

  it("re-rendering the same turn is deterministic", () => {
    expect(promptFor("my login is broken, i can't get in", 4)).toEqual(a);
  });
});
