import { describe, it, expect } from "vitest";
import { buildAgentPrompt, type AgentRecord } from "../services/prompt-builder.service";
import { computeBehaviorState } from "../services/behavior-engine.service";

/**
 * The prompt layer for the 2026-07-31 conversation.
 *
 * The reply guard makes the bad message impossible to SEND; these rules are
 * what make the good message likely in the first place. Both matter, and this
 * asserts the half that is a string in a prompt - that the instructions are
 * actually rendered, for a real agent shape, rather than merely written down
 * somewhere in the file.
 *
 * The specific failure it guards against: `persona.gender` was only emitted
 * `if (persona.gender)`, and Maya's persona was
 * `{"brand_archetype":"high_energy_coach"}`. So the prompt said NOTHING about
 * her gender, in a language where every verb she writes about herself has one.
 */

/** Maya's real persona shape after the fix. */
const MAYA: AgentRecord = {
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

/** Maya as she actually was: no gender at all. */
const MAYA_BEFORE: AgentRecord = {
  ...MAYA,
  persona: { brand_archetype: "high_energy_coach" },
} as AgentRecord;

/** An agent using the ORIGINAL field name, which must keep working. */
const LEGACY_FIELD: AgentRecord = {
  ...MAYA,
  persona: { brand_archetype: "high_energy_coach", gender: "female" },
} as AgentRecord;

function promptFor(agent: AgentRecord): string {
  const behaviorState = computeBehaviorState({
    mode: "agent",
    identity: { hasContact: true, contactLifecycle: null, priorConversationCount: 0 },
    request: { lastMessage: "מתי ההזמנה שלי תגיע?", messageCount: 3, recentInboundTexts: ["מתי ההזמנה שלי תגיע?"] },
  });
  return buildAgentPrompt({
    behaviorState,
    agent,
    context: { customerBlock: "## Customer\n- Channel: whatsapp", locale: "he" },
    knowledge: {},
    toolFunctionNames: ["escalate_to_human", "schedule_followup"],
  } as any);
}

describe("the employee is told what gender she speaks in", () => {
  const prompt = promptFor(MAYA);

  it("renders feminine forms for grammaticalGender: feminine", () => {
    expect(prompt).toMatch(/Gender: use feminine grammatical forms/i);
  });

  it("tells her to hold it in first person, every time", () => {
    expect(prompt).toMatch(/Speak about YOURSELF in first person/i);
  });

  it("forbids a slash form about herself - the exact slip she made", () => {
    expect(prompt).toMatch(/NEVER write a slash form about yourself/i);
    expect(prompt).toContain("מציע/ה");   // named as the counter-example
  });

  it("still honours the original `gender` field name", () => {
    // Agents configured before the rename must not silently lose their setting.
    expect(promptFor(LEGACY_FIELD)).toMatch(/Gender: use feminine grammatical forms/i);
  });

  it("says SOMETHING even when no gender is configured", () => {
    // The actual defect: this block used to emit nothing at all, leaving the
    // model to guess afresh every turn.
    const before = promptFor(MAYA_BEFORE);
    expect(before).toMatch(/choose ONE consistent/i);
    expect(before).toMatch(/NEVER write a slash form about yourself/i);
  });
});

describe("the customer is addressed without hedging", () => {
  const prompt = promptFor(MAYA);

  it("forbids slash forms outright", () => {
    expect(prompt).toMatch(/Slash forms are FORBIDDEN/i);
  });

  it("gives the restructured alternatives, not just the prohibition", () => {
    // A rule that only says "don't" leaves the model with no way to comply.
    expect(prompt).toContain("אפשר לבצע את הפעולה עכשיו?");
    expect(prompt).toContain("להמשיך לביטול ההזמנה?");
  });

  it("says a first name alone is not evidence of gender", () => {
    expect(prompt).toMatch(/A first name alone is not evidence/i);
  });
});

describe("nothing internal, and nothing unbacked", () => {
  const prompt = promptFor(MAYA);

  it("forbids naming tools and counting checks", () => {
    expect(prompt).toMatch(/Nothing internal reaches the customer/i);
    expect(prompt).toContain("עשיתי שתי בדיקות");   // the real sentence, as a counter-example
  });

  it("forbids raw provider errors", () => {
    expect(prompt).toMatch(/shopify_400/);
    expect(prompt).toMatch(/no_eta/);
  });

  it("forbids unexplained acronyms in Hebrew, naming ETA", () => {
    expect(prompt).toMatch(/No unexplained acronyms/i);
    expect(prompt).toContain("מה זה ETA?");
  });

  it("forbids claiming contact that did not happen", () => {
    expect(prompt).toMatch(/Never claim an action you did not take/i);
    expect(prompt).toContain("אני פונה לצוות המשלוחים");
  });

  it("states plainly that a note or tag reaches no one", () => {
    // The precise misunderstanding that produced the false claim.
    expect(prompt).toMatch(/reaches NO ONE/i);
  });

  it("allows an offer while forbidding a bare commitment", () => {
    expect(prompt).toMatch(/Offering is fine/i);
  });
});
