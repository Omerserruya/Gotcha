import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgentPrompt, type AgentRecord } from "../services/prompt-builder.service";
import { computeBehaviorState } from "../services/behavior-engine.service";

/**
 * The website is not how a shop talks in a chat (2026-10-25, eval E04).
 *
 * Noa's first reply opened with "Designed in Copenhagen. Worn everywhere." in
 * English: the website enrichment had written the site's hero line as
 * "Greeting style (open conversations like this)". Website copy now reaches the
 * prompt as facts and vocabulary only, for new employees and existing rows.
 */

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  prisma: {},
  grammaticalAddressPromptBlock: () => null,
}));

// Noa's customAttributes on dev, as the enrichment wrote them.
const NOA_ATTRS = {
  "Brand voice": "Considered clothing, designed in Copenhagen and made in small runs.",
  "Positioning": "Made in small runs in Portugal and Italy, traceable materials, repairs for life.",
  "Tone of voice": "Designed in Copenhagen. Worn everywhere. Every piece starts as a question.",
  "Brand personality": "Fewer, better things",
  "Languages we speak": "English",
  "Call-to-action style": "Shop New Arrivals",
  "Preferred words & phrases": "seasonless wardrobe, repairs for life, traceable materials",
  "How we speak to our audience": "Customers who want seasonless, long-lasting garments in natural fibres.",
  "Greeting style (open conversations like this)": "Designed in Copenhagen. Worn everywhere.",
};

const prompt = buildAgentPrompt({
  behaviorState: computeBehaviorState({
    mode: "agent",
    identity: { hasContact: false, contactLifecycle: null, priorConversationCount: 0 },
    request: { lastMessage: "היי", messageCount: 1, recentInboundTexts: ["היי"] },
  }),
  agent: {
    name: "Noa", role: "customer_support", tone: "friendly", style: {},
    identity: { company: "HALVØ", description: "Clothing." }, goals: {}, toneConfig: {}, behavioral: {},
    persona: { grammaticalGender: "feminine", customAttributes: NOA_ATTRS },
    conversationFlow: null, customGuardrails: null, escalationRules: null, behavioralAnchors: null,
  } as AgentRecord,
  context: { customerBlock: "## Customer\n- Channel: webchat", locale: "he" },
  knowledge: {},
  toolFunctionNames: [],
} as any);

describe("★ an existing employee's website voice keys never reach the prompt", () => {
  it("no slogan, no greeting line, no CTA, no 'Languages we speak: English'", () => {
    expect(prompt).not.toContain("Worn everywhere");
    expect(prompt).not.toContain("Greeting style");
    expect(prompt).not.toContain("Shop New Arrivals");
    expect(prompt).not.toContain("Languages we speak");
  });
  it("facts and vocabulary stay", () => {
    expect(prompt).toContain("- Positioning: Made in small runs in Portugal and Italy");
    expect(prompt).toContain("- Preferred words & phrases: seasonless wardrobe");
  });
  it("a key the merchant added stays", () => {
    const p = buildAgentPrompt({
      behaviorState: computeBehaviorState({ mode: "agent", identity: { hasContact: false, contactLifecycle: null, priorConversationCount: 0 }, request: { lastMessage: "היי", messageCount: 1, recentInboundTexts: ["היי"] } }),
      agent: { name: "Noa", role: "customer_support", tone: "friendly", style: {}, identity: {}, goals: {}, toneConfig: {}, behavioral: {}, persona: { customAttributes: { "Signature": "צוות HALVØ" } }, conversationFlow: null, customGuardrails: null, escalationRules: null, behavioralAnchors: null } as AgentRecord,
      context: { customerBlock: "", locale: "he" }, knowledge: {}, toolFunctionNames: [],
    } as any);
    expect(p).toContain("- Signature: צוות HALVØ");
  });
});

describe("★ a new employee gets facts and vocabulary from the website, nothing else", () => {
  it("the enrichment writes only Positioning and Preferred words as persona attributes", () => {
    const src = readFileSync(join(__dirname, "../services/agent-config-generator.ts"), "utf8");
    const at = src.indexOf("async function buildDiscoveryEnrichment");
    const body = src.slice(at, src.indexOf("\n}\n", at));
    const keys = Array.from(body.matchAll(/putP\("([^"]+)"/g)).map((m) => m[1]);
    const direct = Array.from(body.matchAll(/persona\["([^"]+)"\]\s*=/g)).map((m) => m[1]);
    expect([...keys, ...direct].sort()).toEqual(["Positioning", "Preferred words & phrases"]);
  });
});
