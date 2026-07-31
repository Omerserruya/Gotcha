import { describe, it, expect, vi } from "vitest";
import { buildAgentPrompt, type AgentRecord } from "../services/prompt-builder.service";
import { computeBehaviorState } from "../services/behavior-engine.service";

/**
 * Needing approval is not a reason to fetch a human.
 *
 * A customer wrote "אני רוצה לבטל את ההזמנה שלי 1006" - I want to cancel my
 * order 1006. The bot replied "מעבירה אותך לנציגת שירות" - transferring you to
 * a service rep - and handed the conversation over. Zero tool calls, zero
 * approval requests.
 *
 * It was following its instructions. `cancel_order` told the model:
 *
 *     "Customer requests cancellation AND you have approval."
 *
 * In a HITL system, CALLING the tool is what raises the approval. That sentence
 * describes a precondition the system itself provides, so a model reading it
 * literally concludes it may not act - and reaches for a human instead. The
 * tool was permitted (is_allowed = true) and the policy was configured
 * (mode: always, approverRole: ADMIN). Nothing was broken except the wording.
 */

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (l?: string) => l || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  assertPublicUrl: vi.fn(async () => {}),
  prisma: {},
  encryptCredentials: (v: unknown) => v,
  decryptCredentials: (v: unknown) => v,
}));

import ShopifyAdapter from "../services/connectors/shopify.adapter";

const tools = ShopifyAdapter.tools();
const byName = (slug: string) => tools.find((t: any) => t.name === `shopify.${slug}`) as any;

/** Tools whose gate raises an approval rather than refusing. */
const APPROVAL_GATED = ["cancel_order", "create_discount_code"];

describe("no tool tells the model to wait for approval", () => {
  it.each(APPROVAL_GATED)("%s does not state approval as a precondition", (slug) => {
    const def = byName(slug);
    expect(def, `${slug} missing`).toBeTruthy();
    const text = `${def.whenToUse} ${def.description}`;
    // The exact phrasing that produced the handover.
    expect(text).not.toMatch(/AND you have approval/i);
    expect(text).not.toMatch(/you have approval to/i);
  });

  it.each(APPROVAL_GATED)("%s tells the model the system handles approval", (slug) => {
    const def = byName(slug);
    expect(def.whenToUse).toMatch(/Approval is handled by the system/i);
    expect(def.whenToUse).toMatch(/calling this tool is what RAISES the approval/i);
  });

  it.each(APPROVAL_GATED)("%s forbids handing over instead of calling", (slug) => {
    // The specific wrong move: transferring the conversation to a human
    // because approval is needed.
    expect(byName(slug).whenToUse).toMatch(/never hand the conversation to a human/i);
  });

  it("cancel_order still says WHEN to use it", () => {
    // Removing the bad precondition must not leave the model without guidance.
    expect(byName("cancel_order").whenToUse).toMatch(/customer asks to cancel/i);
  });

  it("cancel_order keeps its irreversibility warning", () => {
    // Making the tool reachable must not make it feel cheap.
    expect(byName("cancel_order").sideEffects).toMatch(/irreversible/i);
  });
});

describe("the prompt states the rule independently of any tool's wording", () => {
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

  const prompt = buildAgentPrompt({
    behaviorState: computeBehaviorState({
      mode: "agent",
      identity: { hasContact: true, contactLifecycle: null, priorConversationCount: 0 },
      request: {
        lastMessage: "אני רוצה לבטל את ההזמנה שלי 1006",
        messageCount: 1,
        recentInboundTexts: ["אני רוצה לבטל את ההזמנה שלי 1006"],
      },
    }),
    agent: MAYA,
    context: { customerBlock: "## Customer\n- Channel: whatsapp", locale: "he" },
    knowledge: {},
    toolFunctionNames: ["shopify.cancel_order", "escalate_to_human"],
  } as any);

  it("says approval is not a reason to hand over", () => {
    expect(prompt).toMatch(/Approval is not a reason to hand over/i);
  });

  it("names the wrong move using the sentence the bot actually sent", () => {
    expect(prompt).toContain("מעבירה אותך לנציגת שירות");
  });

  it("tells the model to call the tool and carry on", () => {
    expect(prompt).toMatch(/CALL THE TOOL/);
    expect(prompt).toMatch(/do NOT transfer the conversation to a human agent instead/i);
  });

  it("keeps handover available for genuine dead ends", () => {
    // The rule must not strand a customer the bot truly cannot help.
    expect(prompt).toMatch(/genuinely cannot help at all/i);
  });

  it("still forbids mentioning the approval to the customer", () => {
    expect(prompt).toMatch(/never mention approvals, managers, queues/i);
  });
});
