import { describe, it, expect, vi } from "vitest";
import { buildAgentPrompt, isShopFloor, type AgentRecord } from "../services/prompt-builder.service";
import { computeBehaviorState } from "../services/behavior-engine.service";

/**
 * The final self-review by business (2026-10-25, P2). The 25-rule contract was
 * written for a B2B sales rep and a shop's employee obeyed it: a pitch on a
 * vague message, a question after every answer (7a), an email asked of a
 * shopper (13). Truth for everyone, a role add-on, then a short style block LAST.
 */
vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  prisma: {},
  grammaticalAddressPromptBlock: () => null,
}));

const agent = (role: string): AgentRecord => ({
  name: "Noa", role, tone: "friendly", style: {}, identity: {}, goals: {}, toneConfig: {}, behavioral: {},
  persona: {}, conversationFlow: null, customGuardrails: null, escalationRules: null, behavioralAnchors: null,
} as AgentRecord);

const prompt = (role: string, tools: string[], industry?: string, locale = "he") => buildAgentPrompt({
  behaviorState: computeBehaviorState({
    mode: "agent",
    identity: { hasContact: false, contactLifecycle: null, priorConversationCount: 0 },
    request: { lastMessage: "תודה רבה!", messageCount: 3, recentInboundTexts: ["תודה רבה!"] },
  }),
  agent: agent(role),
  company: industry ? { organizationName: "X", industry } : undefined,
  context: { customerBlock: "## Customer\n- Channel: webchat", locale },
  knowledge: {},
  toolFunctionNames: tools,
} as any);

describe("★ which business", () => {
  it("a connected store or a retail industry is the shop floor, whatever the role", () => {
    expect(isShopFloor({ toolFunctionNames: ["woocommerce.list_products"] })).toBe(true);
    expect(isShopFloor({ toolFunctionNames: [], company: { organizationName: "HALVØ", industry: "Clothing" } })).toBe(true);
    expect(isShopFloor({ toolFunctionNames: ["schedule_meeting"], company: { organizationName: "Acme", industry: "SaaS" } })).toBe(false);
  });
});

describe("★ the shop floor", () => {
  const p = prompt("customer_support", ["woocommerce.list_products", "escalate_to_human"]);
  it("gets the shop add-on, never the sales one", () => {
    expect(p).toContain("# The shop floor (this employee serves shoppers)");
    expect(p).not.toContain("# B2B sales");
    expect(p).not.toMatch(/Knowledge gap \(when a Knowledge Ledger is present\)/);
    expect(p).not.toMatch(/Discovery before data capture/);
    expect(p).not.toMatch(/proactively propose a demo\/meeting/);
    expect(p).not.toContain("real human sales rep");
  });
  it("a sales employee at a shop is still on the shop floor", () => {
    expect(prompt("sales", ["woocommerce.list_products"])).not.toContain("# B2B sales");
  });
  it("never offers to reserve, call back or check with someone without a tool", () => {
    expect(p).toContain("Never offer to reserve or hold an item, call back, or check with someone, unless a tool does it");
  });
});

describe("★ B2B sales", () => {
  const p = prompt("sales", ["schedule_meeting"], "SaaS");
  it("keeps the sales rules (7a, 13, 14) and the calendar ack", () => {
    expect(p).toContain("# B2B sales (this employee sells to businesses)");
    expect(p).toMatch(/Knowledge gap \(when a Knowledge Ledger is present\)/);
    expect(p).toMatch(/Discovery before data capture/);
    expect(p).toMatch(/Calendar checks = a brief ack/);
  });
});

describe("★ style is the last thing the model reads, about ten lines, in the business's language", () => {
  const p = prompt("customer_support", ["woocommerce.list_products"]);
  it("last", () => {
    const style = p.lastIndexOf("# Style (read last, follow exactly)");
    expect(style).toBeGreaterThan(p.lastIndexOf("# The shop floor"));
    expect(style).toBeGreaterThan(p.lastIndexOf("# Response Quality Contract"));
    expect(p.slice(style).split("\n").filter((l) => l.startsWith("- ")).length).toBeLessThanOrEqual(13);
  });
  it("Hebrew examples for a Hebrew business: a warm close after a thank-you, the Hebrew tells", () => {
    expect(p).toContain('"בכיף 🙂"');
    expect(p).toContain('"אשמח לעזור", "בהחלט", "שאלה מצוינת"');
    expect(p).toContain("At most ONE question");
    expect(p).toContain("one or two short sentences");
  });
  it("English examples for an English one", () => {
    expect(prompt("customer_support", ["woocommerce.list_products"], undefined, "en")).toContain('"Anytime 🙂"');
  });
  it("truth rules stay for everyone", () => {
    for (const q of [p, prompt("sales", [], "SaaS"), prompt("customer_support", [], "Clinic")]) {
      expect(q).toMatch(/Product facts come only from a tool/);
      expect(q).toMatch(/Never claim an action you did not take/);
      expect(q).toMatch(/Slash forms are FORBIDDEN/);
    }
  });
});
