/**
 * E2E scenario validation for the Skill / knowledge-ledger / tool-contract
 * refinements. Drives the REAL prompt-builder (`buildAgentPrompt`), the REAL
 * ledger resolver, and the REAL dispatch-gate functions - the exact code paths
 * the live AI service executes per turn - across the four required scenarios:
 *
 *   1. discovery conversation        (sales, cold, empty CRM)
 *   2. low-engagement lead           (anti-give-up / recovery)
 *   3. returning customer w/ memory  (known facts flip the ledger; memory usage)
 *   4. tool requiring missing inputs (contract + schema gate blocks dispatch)
 *
 * No LLM calls: we assert the assembled prompt + gate decisions are correct,
 * which is what actually steers model behavior.
 */
import { describe, it, expect } from "vitest";
import { buildAgentPrompt, type AgentRecord } from "../services/prompt-builder.service";
import { missingRequiredArgs } from "../services/ai-bot.service";
import { missingContractInputs } from "../services/tool-contracts";
import { computeBehaviorState } from "../services/behavior-engine.service";
import { computeKnowledgeLedger, renderKnowledgeLedger } from "../services/knowledge-ledger";
import { requiredKnowledgeFor } from "../services/skills";

const SALES_AGENT: AgentRecord = {
  name: "Aria",
  role: "sales",
  persona: { brand_archetype: "sage" },
  conversationFlow: null,
  customGuardrails: null,
  escalationRules: null,
  behavioralAnchors: null,
};

function salesPrompt(lastMessage: string, messageCount: number, context: any) {
  const behaviorState = computeBehaviorState({
    mode: "agent",
    identity: { hasContact: true, contactLifecycle: null, priorConversationCount: 0 },
    request: { lastMessage, messageCount, recentInboundTexts: [lastMessage] },
  });
  return buildAgentPrompt({
    behaviorState,
    agent: SALES_AGENT,
    context,
    knowledge: {},
    toolFunctionNames: ["escalate_to_human"],
  } as any);
}

describe("E2E #1 - discovery conversation (sales, cold)", () => {
  const prompt = salesPrompt("hi, what do you guys do?", 1, {
    customerBlock: "## Customer\n- Name: Dana\n- Channel: whatsapp",
    locale: "en",
  });

  it("loads the SALES skill with objective, memory usage and anti-give-up recovery", () => {
    expect(prompt).toContain("# Skill: Consultative Sales");
    expect(prompt).toContain("Conversation objective");
    expect(prompt).toMatch(/demo|meeting|trial|quote/);
    expect(prompt).toContain("Using memory");
    expect(prompt).toContain("Recovery / never give up");
  });

  it("renders a knowledge ledger that targets the highest-priority gap first", () => {
    expect(prompt).toContain("# Knowledge Ledger (this turn)");
    // Nothing known yet → top-priority required field (business_type) is the target.
    const ledger = computeKnowledgeLedger(requiredKnowledgeFor("sales"), "## Customer\n- Name: Dana");
    expect(ledger.nextTarget?.key).toBe("business_type");
    expect(ledger.hasMissingRequired).toBe(true);
  });

  it("the FAQ-bot anti-pattern is explicitly forbidden", () => {
    expect(prompt.toLowerCase()).toContain("faq bot");
  });
});

describe("E2E #2 - low-engagement lead (anti-give-up)", () => {
  const prompt = salesPrompt("meh, not really interested", 5, {
    customerBlock: "## Customer\n- Name: Sam\n- Channel: whatsapp",
    locale: "en",
  });

  it("carries the recovery contract: short reply ≠ end; one more meaningful move", () => {
    expect(prompt).toContain("Recovery / never give up");
    expect(prompt).toMatch(/short.*reply|low-engagement|one more meaningful move/i);
    expect(prompt).toMatch(/re-engagement|low-commitment next step/i);
  });

  it("failure criteria name giving-up as a failure mode", () => {
    expect(prompt.toLowerCase()).toContain("gave up after low engagement");
  });
});

describe("E2E #3 - returning customer with memory", () => {
  // CRM/memory already hold several discovery facts from prior conversations.
  const context = {
    customerBlock: "## Customer\n- Name: Omer\n- Channel: whatsapp",
    crmBlock: "Industry: e-commerce\nCurrent tools: Shopify + spreadsheets\nChannels: WhatsApp, email",
    memoryBlock: "Known: runs an online store; handles support over WhatsApp.",
    locale: "en",
  };
  const prompt = salesPrompt("hey, it's me again", 2, context);

  it("instructs the agent to reference memory naturally (continuity, not just skip-ask)", () => {
    expect(prompt).toContain("Using memory");
    expect(prompt).toMatch(/I remember|good to hear from you again|build the relationship/i);
  });

  it("known facts flip to ✓ and the next target skips them to the top missing required field", () => {
    const factText = [context.customerBlock, context.crmBlock, context.memoryBlock].join("\n");
    const ledger = computeKnowledgeLedger(requiredKnowledgeFor("sales"), factText);
    const byKey = Object.fromEntries(ledger.entries.map((e) => [e.key, e.known]));
    expect(byKey.business_type).toBe(true);          // "industry" hint matched
    expect(byKey.current_tools).toBe(true);          // "current tools" phrase matched
    expect(byKey.communication_channels).toBe(true); // "channels" hint matched
    expect(byKey.pain_points).toBe(false);
    // business_type (p1) is known → next target is the next missing REQUIRED by
    // priority: pain_points (p2), NOT a re-ask of something already known.
    expect(ledger.nextTarget?.key).toBe("pain_points");
    const md = renderKnowledgeLedger(ledger)!;
    expect(md).toContain("✓ `business_type`");
    expect(md).toContain("pain_points");
  });
});

describe("E2E #4 - tool requiring missing inputs", () => {
  const TOOLS = [
    { type: "function", function: { name: "issue_refund", parameters: { required: ["reason"] } } },
    { type: "function", function: { name: "check_shipment", parameters: { properties: {} } } }, // loose schema
  ];

  it("contract gate blocks an integration tool with no contract-required input", () => {
    // check_shipment's schema declares nothing required, but the Tool Contract does.
    expect(missingRequiredArgs("check_shipment", {}, TOOLS)).toEqual([]); // schema gate alone misses it
    const contract = missingContractInputs("check_shipment", {});
    expect(contract.missing).toEqual(["order_number"]);                   // contract catches it
    expect(contract.strategy).toBe("ask_one_at_a_time");
  });

  it("union of schema + contract gates collects everything missing", () => {
    const schemaMissing = missingRequiredArgs("issue_refund", {}, TOOLS);   // ["reason"]
    const contractMissing = missingContractInputs("issue_refund", {}).missing; // ["order_id"]
    const union = Array.from(new Set([...schemaMissing, ...contractMissing]));
    expect(union.sort()).toEqual(["order_id", "reason"]);
  });

  it("gate clears once required inputs are present", () => {
    expect(missingContractInputs("check_shipment", { order_number: "Z-100" }).missing).toEqual([]);
    expect(missingRequiredArgs("issue_refund", { reason: "damaged" }, TOOLS)).toEqual([]);
  });
});
