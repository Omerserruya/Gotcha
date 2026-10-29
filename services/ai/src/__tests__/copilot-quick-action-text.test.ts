/**
 * A proposed action is never drawn as a tool's name and arguments (2026-10-29:
 * "link customer identifier - type: phone, value: 97254...", option 4 of the
 * Copilot's ways to answer on a real conversation).
 * Drives the real suggestion loop (OpenAIProvider.suggestResponse) with a
 * scripted model. Pinned:
 *   - a quick_action's text is its label in the AGENT's language (not the
 *     customer's), or a neutral line for a tool with no label;
 *   - no suggestion text contains a tool slug, in snake_case or with spaces,
 *     or any argument value the model passed;
 *   - the replies themselves are untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ script: [] as any[] }));

vi.mock("@chatcenter/shared", async () => {
  const effect = await vi.importActual<any>("../../../../packages/shared/src/lib/tool-effect");
  return {
    classifyToolEffect: effect.classifyToolEffect,
    prisma: { contact: { findFirst: async () => null } },
    publishEvent: async () => undefined,
    dispatchToolCall: async (tc: any) => ({ toolCallId: tc.id, content: JSON.stringify({ ok: true }) }),
  };
});
vi.mock("../services/ai.service", () => ({
  getDefaultModel: () => "gpt-test",
  generateResponse: async () => H.script.shift() ?? { content: "" },
}));
vi.mock("../services/knowledge.service", () => ({ retrieveRelevantChunks: async () => [], buildKnowledgeContext: () => "" }));
vi.mock("../services/crm-prefetch.service", () => ({ prefetchCrmContext: async () => null, renderCrmContextBlock: () => "" }));
vi.mock("../services/plan-context.service", () => ({ assemblePlanContext: async () => ({}) }));
vi.mock("../services/prompt-builder.service", () => ({
  buildAgentPrompt: () => "SYSTEM",
  computeCurrentPlanForOpts: () => null,
  renderOutputContractInstruction: () => "CONTRACT",
}));
vi.mock("../services/behavior-engine.service", () => ({
  computeBehaviorState: () => ({ outputContract: "x" }),
  shouldRetrieveKB: () => false,
}));
vi.mock("../services/copilot-diagnostics.service", () => ({
  logCopilotPlan: () => undefined, logCopilotTool: () => undefined, plannerReasonForTool: () => "",
  noToolDecision: () => ({}), summarizeToolResult: () => "",
}));
vi.mock("../services/capability-runtime/calendar.port.prod", () => ({ createProdCalendarPort: () => ({}) }));
vi.mock("../services/capability-runtime/calendar.execute", () => ({ isCalendarTool: () => false, executeCalendarToolAdvisory: vi.fn() }));
const fn = (name: string) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } });
const TOOLS = ["link_customer_identifier", "shopify.cancel_order", "integration_update_deal_stage", "escalate_to_human"];
vi.mock("../services/copilot-tool-surface.service", () => ({
  assembleCopilotToolSurface: async () => {
    const tools = TOOLS.map(fn);
    return { tools, toolFunctionNames: TOOLS, calendarBookable: false, hasActiveBooking: false };
  },
}));

import { OpenAIProvider } from "../services/openai.provider";
import { quickActionText, ACTION_LABELS } from "../lib/action-labels";

const provider = new OpenAIProvider("k");
const call = (name: string, args: any, id = `tc_${name}`) => ({ id, function: { name, arguments: JSON.stringify(args) } });

const ARGS: Record<string, Record<string, unknown>> = {
  link_customer_identifier: { type: "phone", value: "972545681234" },
  "shopify.cancel_order": { orderId: "#1016", reason: "customer_request" },
  integration_update_deal_stage: { dealId: "deal_77", stage: "closed_won" },
  escalate_to_human: { reason: "angry_customer" },
};

const suggest = (agentLocale: string | undefined) => {
  H.script = [{
    content: "",
    toolCalls: [
      ...TOOLS.map((t) => call(t, ARGS[t])),
      call("submit_suggestions", { suggestions: [{ text: "היי, אפשר לשלוח לי את מספר הטלפון?", type: "reply" }] }),
    ],
  }];
  return provider.suggestResponse({
    tenantId: "T", conversationId: "c1", customerName: "Matan",
    messages: [{ direction: "INBOUND", body: "איפה ההזמנה שלי?", createdAt: new Date().toISOString() }],
    copilotConfig: { isActive: true, model: "gpt-test", copilotMode: "READY_MESSAGE" } as any,
    locale: "he",
    agentLocale,
  } as any);
};

/** Every form a slug or an argument could take in the text. */
function leaks(text: string): string[] {
  const found: string[] = [];
  for (const t of TOOLS) {
    const bare = t.replace(/^integration_/, "").replace(/^.*\./, "");
    for (const form of [t, bare, bare.replace(/_/g, " ")]) if (text.toLowerCase().includes(form.toLowerCase())) found.push(form);
    for (const v of Object.values(ARGS[t])) if (text.includes(String(v))) found.push(String(v));
    for (const k of Object.keys(ARGS[t])) if (new RegExp(`\\b${k}\\s*:`).test(text)) found.push(`${k}:`);
  }
  return found;
}

beforeEach(() => { H.script = []; });

describe("a proposed action is said in words, never as a tool call", () => {
  it("no suggestion text carries a tool slug or an argument value", async () => {
    for (const loc of ["he", "en", undefined]) {
      const out = await suggest(loc);
      expect(out.length).toBe(1 + TOOLS.length);
      for (const s of out) expect([s.text, leaks(s.text)]).toEqual([s.text, []]);
    }
  });

  it("each action reads as its label in the agent's language; one without a label reads neutrally", async () => {
    const he = (await suggest("he")).filter((s) => s.type === "quick_action").map((s) => s.text);
    expect(he).toEqual(["לקשר פרט מזהה ללקוח", "פעולה מוצעת במערכת", "פעולה מוצעת במערכת", "להעביר לנציג"]);
    const en = (await suggest("en")).filter((s) => s.type === "quick_action").map((s) => s.text);
    expect(en).toEqual(["Link an identifier to the customer", "A suggested action in the system", "A suggested action in the system", "Hand over to a person"]);
  });

  it("the agent's language, not the customer's: a Hebrew customer with an English agent gets English labels", async () => {
    const out = await suggest("en");
    expect(out.find((s) => s.type === "quick_action")!.text).toBe("Link an identifier to the customer");
    // The draft itself is untouched.
    expect(out.find((s) => s.type === "reply")!.text).toBe("היי, אפשר לשלוח לי את מספר הטלפון?");
  });

  it("the proposal itself still travels for the approvals path, apart from the text", async () => {
    const qa = (await suggest("he")).find((s) => s.type === "quick_action") as any;
    expect(qa.quickAction).toMatchObject({ tool: "link_customer_identifier", args: ARGS.link_customer_identifier });
  });
});

describe("quickActionText", () => {
  it("finds a label through integration_ and dotted names", () => {
    expect(quickActionText("integration_escalate_to_human", "he")).toBe("להעביר לנציג");
    expect(quickActionText("crm.update_contact", "en")).toBe("Update the customer's details");
  });
  it("no label carries an underscore or looks like a slug", () => {
    for (const [tool, l] of Object.entries(ACTION_LABELS)) {
      for (const text of Object.values(l)) {
        expect(text).not.toMatch(/_/);
        expect(text.toLowerCase()).not.toContain(tool.replace(/_/g, " "));
      }
    }
  });
  it("an unlabeled tool never echoes its name", () => {
    expect(quickActionText("delete_everything_now", "en")).toBe("A suggested action in the system");
    expect(quickActionText("delete_everything_now", "he-IL")).toBe("פעולה מוצעת במערכת");
  });
});
